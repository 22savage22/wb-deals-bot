// Isolated public app + OPTIONAL exact owner-only Superfind PREVIEW.
// No scheduled handler, AI, bot token, service binding or Telegram sender.
import {createWorker} from '../cloudflare/worker.mjs';
import features from './worker.mjs';
import {telegramPublicUser} from './telegram_signature.mjs';
import {ownerPreviewEnabled,ownerPreviewRoute,stagingAdminUser} from './staging_owner.mjs';
import {forgetSubscriber} from './store.mjs';
import {withReadBudget} from '../cloudflare/read_guard.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {withStagingBudget,StagingBudgetError} from './staging_budget.mjs';
import {stylePhoto} from './photo_proxy.mjs';
export const STAGING_WORKER='wb-finds-style-staging',PUBLIC_BOT_ID='8636930701';
const forbiddenDB=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20']);
const error=(text,status=403)=>Response.json({error:text},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function assertStaging(env){
  if(env.STYLE_STAGING!=='1'||env.PUBLIC_BOT_ID!==PUBLIC_BOT_ID||!env.STYLE_STAGING_DB_ID||forbiddenDB.has(env.STYLE_STAGING_DB_ID))throw Error('STAGING_ISOLATION_REQUIRED');
  for(const key of ['AI','TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','MINIAPP_SYNC_KEY','SCHEDULER_DRIVER','PRODUCTION','PRODUCTION_DB','SERVICE'])if(env[key])throw Error('STAGING_PRIVILEGED_BINDING');
  if(env.STAGING_OWNER_PREVIEW==='1'&&!ownerPreviewEnabled(env))throw Error('STAGING_OWNER_REQUIRED');
}
const publicAPI=/^\/api\/(?:catalog|me|preferences|outfits(?:\/saved(?:\/\d+)?)?|saved\/\d+)$/;
const checkedDatabases=new WeakMap();
export async function verifyDatabase(env,identity=env.DB){
  if(!checkedDatabases.has(identity))checkedDatabases.set(identity,(async()=>{
    const row=await env.DB.prepare("SELECT value FROM feature_meta WHERE key='style_staging_database'").first();
    if(row?.value!==env.STYLE_STAGING_DB_ID)throw Error('STAGING_DATABASE_CANARY_MISMATCH');
  })());
  const promise=checkedDatabases.get(identity);
  try{await promise;}catch(e){if(checkedDatabases.get(identity)===promise)checkedDatabases.delete(identity);throw e;}
}
async function route(request,env,ctx,dbIdentity=env.DB){
  const url=new URL(request.url),path=url.pathname,origin=request.headers.get('Origin');
  if(origin&&origin!==url.origin)return error('Недопустимый источник запроса');
  const run=operation=>withStagingBudget(env,request,async e=>{await verifyDatabase(e,dbIdentity);return operation(e);});
  if(path==='/api/health'&&request.method==='GET')return run(async e=>{
    const db=await e.DB.prepare('SELECT 1 AS ok').first();
    return Response.json({ok:db.ok===1,staging:true,worker:STAGING_WORKER,database_id:e.STYLE_STAGING_DB_ID,version:e.CF_VERSION?.id??null,auth:'TELEGRAM_ED25519',scheduled:false,admin:false,owner_preview:ownerPreviewEnabled(e),ai:false,telegram_send:false,production:false},{headers:{'Cache-Control':'no-store'}});
  });
  if(ownerPreviewEnabled(env)&&ownerPreviewRoute(path,request.method)){
    let uid;try{uid=await stagingAdminUser(request.headers.get('X-Telegram-Init-Data'),env);}catch{return error('Откройте предпросмотр из WBmarket',401);}
    if(String(uid)!==String(env.MINIAPP_ADMIN_ID))return error('Доступ только владельцу');
    return run(e=>features.fetch(request,e,ctx));
  }
  if(ownerPreviewEnabled(env)&&path==='/superfind'&&request.method==='GET')return env.ASSETS.fetch(new Request(new URL('/style/index.html',url.origin),request));
  if(path.startsWith('/api/style/')){
    try{await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),env.PUBLIC_BOT_ID);}catch{return error('Откройте через публичного Telegram-бота',401);}
    return run(e=>features.fetch(request,e,ctx));
  }
  if(['/style','/style/'].includes(path)&&request.method==='GET')return env.ASSETS.fetch(new Request(new URL('/style/index.html',url.origin),request));
  if(['/feature/app.js','/feature/app.css'].includes(path))return features.fetch(request,env,ctx);
  if(path.startsWith('/style-images/'))return stylePhoto(request,env,ctx,{guard:(e,r,op)=>run(op)});
  if(path.startsWith('/style-photos/')||path==='/style-navigation.js'){
    if(!['GET','HEAD'].includes(request.method))return error('Метод не поддерживается',405);
    return env.ASSETS.fetch(request);
  }
  const asset=['/','/index.html','/static/app.js','/static/app.css'].includes(path);
  if(!asset&&!publicAPI.test(path))return error('Административные и служебные пути в публичном staging запрещены');
  const core=createWorker(raw=>telegramPublicUser(raw,env.PUBLIC_BOT_ID));
  if(asset)return core.fetch(request,env,ctx);
  if(path!=='/api/catalog')try{await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),env.PUBLIC_BOT_ID);}catch{return error('Откройте через публичного Telegram-бота',401);}
  return run(async e=>{
    const response=await core.fetch(request,e,ctx);
    if(path==='/api/me'&&request.method==='DELETE'&&response.ok){
      try{const uid=await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),e.PUBLIC_BOT_ID);await withReadBudget(e,'optional',2000,w=>forgetSubscriber(w.DB,uid),{writes:2200});}catch{return error('Удаление профиля не завершено. Повторите запрос',503);}
    }
    return response;
  });
}
export default {async fetch(request,env,ctx={waitUntil:p=>p.catch(()=>{})}){
  try{assertStaging(env);}catch{return error('Изоляция staging не подтверждена',503);}
  const meter=observeD1(env.DB),runtime={...env,DB:meter.DB};
  // Server-code-only callback, never a binding or client-controlled job.
  runtime.FEATURE_BACKGROUND=async task=>{
    const jobMeter=observeD1(env.DB),work={...env,DB:jobMeter.DB};
    try{return await withStagingBudget(work,new Request(new URL('/__style-background/superfind',request.url),{method:'POST'}),task);}
    finally{console.log('STYLE_D1_BACKGROUND',JSON.stringify({queries:jobMeter.metrics.queries,rows_read:jobMeter.coverage.complete?jobMeter.metrics.rows_read:null,rows_written:jobMeter.coverage.complete?jobMeter.metrics.rows_written:null,metadata_complete:jobMeter.coverage.complete}));}
  };
  let response;
  try{response=await route(request,runtime,ctx,env.DB);}catch(e){response=error(e instanceof StagingBudgetError?e.message:'Тестовый сервис временно недоступен',e instanceof StagingBudgetError?429:503);}
  const secured=new Response(response.body,response),known=meter.coverage.complete;
  if(new URL(request.url).pathname.startsWith('/api/')){
    secured.headers.set('X-Style-D1-Metadata',known?'complete':'unknown');
    secured.headers.set('X-Style-D1-Queries',String(meter.metrics.queries));
    secured.headers.set('X-Style-D1-Rows-Read',known?String(meter.metrics.rows_read):'unknown');
    secured.headers.set('X-Style-D1-Rows-Written',known?String(meter.metrics.rows_written):'unknown');
    secured.headers.set('X-Style-D1-Scope','HTTP_ONLY_BACKGROUND_SEPARATE');
    if(meter.metrics.queries)console.log('STYLE_D1_USAGE',JSON.stringify({path:new URL(request.url).pathname,queries:meter.metrics.queries,rows_read:known?meter.metrics.rows_read:null,rows_written:known?meter.metrics.rows_written:null,metadata_complete:known}));
  }
  return secured;
}};
