// Public-only composition: existing Mini App API/UI + My Style, separate D1.
// No scheduled export, AI/service bindings, bot token, sync key or admin routes.
import {createWorker} from '../cloudflare/worker.mjs';
import features from './worker.mjs';
import {telegramPublicUser} from './telegram_signature.mjs';
import {forgetSubscriber} from './store.mjs';
import {withReadBudget} from '../cloudflare/read_guard.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
export const STAGING_WORKER='wb-finds-style-staging',PUBLIC_BOT_ID='8636930701';
const forbiddenDB=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20']);
const error=(text,status=403)=>Response.json({error:text},{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
export function assertStaging(env){
  if(env.STYLE_STAGING!=='1'||env.PUBLIC_BOT_ID!==PUBLIC_BOT_ID||!env.STYLE_STAGING_DB_ID||forbiddenDB.has(env.STYLE_STAGING_DB_ID))throw Error('STAGING_ISOLATION_REQUIRED');
  for(const key of ['AI','TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','MINIAPP_SYNC_KEY','SCHEDULER_DRIVER','PRODUCTION','PRODUCTION_DB','SERVICE'])if(env[key])throw Error('STAGING_PRIVILEGED_BINDING');
}
const publicAPI=/^\/api\/(?:catalog|me|preferences|outfits(?:\/saved(?:\/\d+)?)?|saved\/\d+)$/;
const checkedDatabases=new WeakMap();
async function verifyDatabase(env,identity=env.DB){
  if(!checkedDatabases.has(identity))checkedDatabases.set(identity,(async()=>{
    const row=await env.DB.prepare("SELECT value FROM feature_meta WHERE key='style_staging_database'").first();
    if(row?.value!==env.STYLE_STAGING_DB_ID)throw Error('STAGING_DATABASE_CANARY_MISMATCH');
  })());
  await checkedDatabases.get(identity);
}
async function route(request,env,ctx,dbIdentity=env.DB){
  try{assertStaging(env);}catch{return error('Изоляция staging не подтверждена',503);}
  const url=new URL(request.url),path=url.pathname,origin=request.headers.get('Origin');
  if(origin&&origin!==url.origin)return error('Недопустимый источник запроса');
  if(path==='/api/health'&&request.method==='GET'){
    try{await verifyDatabase(env,dbIdentity);}catch{return error('Тестовая база не подтверждена',503);}
    const db=await env.DB.prepare('SELECT 1 AS ok').first();
    return Response.json({ok:db.ok===1,staging:true,worker:STAGING_WORKER,database_id:env.STYLE_STAGING_DB_ID,version:env.CF_VERSION?.id??null,auth:'TELEGRAM_ED25519',scheduled:false,admin:false,ai:false,telegram_send:false,production:false},{headers:{'Cache-Control':'no-store'}});
  }
  if(path.startsWith('/api/style/')||['/style','/style/','/feature/app.js','/feature/app.css'].includes(path)){
    if(path.startsWith('/api/')){
      try{await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),env.PUBLIC_BOT_ID);}catch{return error('Откройте через публичного Telegram-бота',401);}
      try{await verifyDatabase(env,dbIdentity);}catch{return error('Тестовая база не подтверждена',503);}
    }
    // The local /preview/session signer is deliberately not present here.
    const r=new Request(request);if(path==='/style'||path==='/style/'){
      const asset=new URL('/style/index.html',url.origin);return env.ASSETS.fetch(new Request(asset,r));
    }
    return features.fetch(r,env,ctx);
  }
  if(path.startsWith('/style-photos/')||path==='/style-navigation.js'){
    if(!['GET','HEAD'].includes(request.method))return error('Метод не поддерживается',405);
    return env.ASSETS.fetch(request);
  }
  const asset=['/','/index.html','/static/app.js','/static/app.css'].includes(path);
  if(!asset&&!publicAPI.test(path))return error('Административные и служебные пути в публичном staging запрещены');
  if(!asset){
    if(path!=='/api/catalog')try{await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),env.PUBLIC_BOT_ID);}catch{return error('Откройте через публичного Telegram-бота',401);}
    try{await verifyDatabase(env,dbIdentity);}catch{return error('Тестовая база не подтверждена',503);}
  }
  const core=createWorker(raw=>telegramPublicUser(raw,env.PUBLIC_BOT_ID));
  const response=await core.fetch(request,env,ctx);
  // Existing public "Delete my data" also removes this same user's style data.
  // A failure remains retryable; no production or other user's data is touched.
  if(path==='/api/me'&&request.method==='DELETE'&&response.ok){
    try{const uid=await telegramPublicUser(request.headers.get('X-Telegram-Init-Data'),env.PUBLIC_BOT_ID);await withReadBudget(env,'optional',2000,e=>forgetSubscriber(e.DB,uid),{writes:2000});}catch{return error('Удаление профиля не завершено. Повторите запрос',503);}
  }
  return response;
}
export default {async fetch(request,env,ctx){
  try{assertStaging(env);}catch{return error('Изоляция staging не подтверждена',503);}
  const meter=observeD1(env.DB);let response;
  try{response=await route(request,{...env,DB:meter.DB},ctx,env.DB);}catch{return error('Тестовый сервис временно недоступен',503);}
  const secured=new Response(response.body,response),known=meter.coverage.complete;
  // This is official metadata of ALL SQL in this request, including reservations
  // and their settlement, not returned-row counts. No extra SQL/PII is recorded.
  if(new URL(request.url).pathname.startsWith('/api/')){
    secured.headers.set('X-Style-D1-Metadata',known?'complete':'unknown');
    secured.headers.set('X-Style-D1-Queries',String(meter.metrics.queries));
    secured.headers.set('X-Style-D1-Rows-Read',known?String(meter.metrics.rows_read):'unknown');
    secured.headers.set('X-Style-D1-Rows-Written',known?String(meter.metrics.rows_written):'unknown');
    if(meter.metrics.queries)console.log('STYLE_D1_USAGE',JSON.stringify({path:new URL(request.url).pathname,queries:meter.metrics.queries,rows_read:known?meter.metrics.rows_read:null,rows_written:known?meter.metrics.rows_written:null,metadata_complete:known}));
  }
  return secured;
}};
