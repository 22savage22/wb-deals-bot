// Isolated PREVIEW entrypoint, NOT the production worker. No scheduled() or AI binding.
// Reuses existing Telegram signature verification and the optional D1 budget lane.
import {telegramUser} from '../cloudflare/auth.mjs';
import {telegramPublicUser} from './telegram_signature.mjs';
import {stagingAdminUser} from './staging_owner.mjs';
import {withReadBudget} from '../cloudflare/read_guard.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {FeatureError,bad,styleMe,styleFeed,favorites,mutate,superfindState,refreshSuperfind} from './store.mjs';
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const json=(data,status=200)=>Response.json(data,{status});
export const FEATURE_LIMITS=Object.freeze({dailyReads:50000,dailyWrites:8000,feedCandidates:120,deckSize:20,maxVotesPerUser:500,maxFavorites:100});
async function budget(env,reads,writes,operation){
  return withReadBudget(env,'optional',reads,async e=>{
    const day=new Date().toISOString().slice(0,10),held=await q(e.DB,`INSERT INTO feature_budget(day,reads,writes) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET reads=reads+excluded.reads,writes=writes+excluded.writes WHERE reads+excluded.reads<=? AND writes+excluded.writes<=?`,day,reads,writes,FEATURE_LIMITS.dailyReads,FEATURE_LIMITS.dailyWrites).run();
    if(!held.meta.changes)bad(429,'Защитный бюджет новых функций исчерпан. Постинг не затронут');
    const meter=observeD1(e.DB);
    try{return await operation({...e,DB:meter.DB});}
    finally{
      const r=meter.coverage.complete?meter.metrics.rows_read+2:reads,w=meter.coverage.complete?meter.metrics.rows_written+2:writes;
      await q(e.DB,'UPDATE feature_budget SET reads=MAX(0,reads-?+?),writes=MAX(0,writes-?+?) WHERE day=?',reads,r,writes,w,day).run();
    }
  },{writes:writes+4});
}
async function body(request,allowed){
  if(!request.headers.get('content-type')?.startsWith('application/json'))bad(400,'Нужен JSON');
  const reader=request.body?.getReader();if(!reader)bad(400,'Пустой запрос');let bytes=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8192){await reader.cancel();bad(413,'Слишком большой запрос');}chunks.push(value);}
  const raw=new Uint8Array(bytes);let at=0;for(const chunk of chunks){raw.set(chunk,at);at+=chunk.length;}
  let input;try{input=JSON.parse(new TextDecoder().decode(raw));}catch{bad(400,'Некорректный JSON');}
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))bad(400,'Недопустимые поля запроса');return input;
}
async function route(request,env,ctx){
  if(env.FEATURE_PREVIEW!=='1')bad(404,'Новые функции не включены');
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(!path.startsWith('/api/')){
    if(!['GET','HEAD'].includes(method)||!['/','/style','/style/','/superfind','/feature/app.js','/feature/app.css'].includes(path))bad(404,'Не найдено');
    if(!env.ASSETS)bad(503,'Preview assets не подключены');return env.ASSETS.fetch(request);
  }
  if(!path.startsWith('/api/style/')&&!path.startsWith('/api/admin/superfind'))bad(404,'Не найдено');
  const admin=path.startsWith('/api/admin/'),origin=request.headers.get('Origin');
  if(origin&&origin!==url.origin)bad(403,'Недопустимый источник запроса');
  let uid;try{const raw=request.headers.get('X-Telegram-Init-Data');uid=env.STYLE_STAGING==='1'?await(admin?stagingAdminUser(raw,env):telegramPublicUser(raw,env.PUBLIC_BOT_ID)):await telegramUser(raw,admin?env.TG_BOT_TOKEN:env.MINIAPP_BOT_TOKEN);}catch{bad(401,'Откройте приложение через своего Telegram-бота');}
  if(admin&&String(uid)!==String(env.MINIAPP_ADMIN_ID))bad(403,'Доступ только владельцу');
  if(env.RATE_LIMITER&&!(await env.RATE_LIMITER.limit({key:'features:'+uid})).success)bad(429,'Слишком много действий, подождите');
  const isRefresh=path==='/api/admin/superfind/refresh'&&method==='POST';
  const isJob=path==='/api/admin/superfind/job'&&method==='GET';
  if(isRefresh){
    const data=await body(request,['requestId']);if(!/^[A-Za-z0-9_-]{16,80}$/.test(data.requestId??''))bad(400,'Нужен requestId');
    const result=await budget(env,10,8,async e=>{
      const prior=await q(e.DB,'SELECT status FROM feature_jobs WHERE id=?',data.requestId).first();
      if(!prior){
        const now=Date.now(),admitted=await e.DB.batch([
          q(e.DB,`INSERT INTO feature_job_lock(id,job_id,owner,expires) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,owner=excluded.owner,expires=excluded.expires WHERE feature_job_lock.expires<=?`,data.requestId,'queued:'+data.requestId,now+30000,now),
          q(e.DB,"INSERT OR IGNORE INTO feature_jobs(id,status,created_at,lease_until) SELECT ?,'queued',?,? WHERE EXISTS(SELECT 1 FROM feature_job_lock WHERE id=1 AND job_id=?)",data.requestId,now,now+30000,data.requestId)
        ]);if(!admitted[0].meta.changes)bad(409,'Проверка уже выполняется');
      }
      return {accepted:true,requestId:data.requestId,publication:'NONE'};
    });
    background(env,ctx,e=>refreshSuperfind(e.DB,data.requestId));return json(result,202);
  }
  if(isJob){
    const id=url.searchParams.get('id');if(!/^[A-Za-z0-9_-]{16,80}$/.test(id??''))bad(400,'Некорректная задача');
    const row=await budget(env,5,4,e=>q(e.DB,'SELECT status,result,lease_until FROM feature_jobs WHERE id=?',id).first());if(!row)bad(404,'Задача не найдена');
    if(row.status==='queued'||row.status==='running'&&row.lease_until<Date.now())background(env,ctx,e=>refreshSuperfind(e.DB,id));
    return json({status:row.status,...JSON.parse(row.result)});
  }
  const reset=['/api/style/me','/api/style/history'].includes(path)&&method==='DELETE';
  return budget(env,500,reset?2400:method==='GET'?8:admin?64:20,async e=>{
    if(path==='/api/style/me'&&method==='GET')return json(await styleMe(e.DB,uid));
    if(path==='/api/style/feed'&&method==='GET'){
      const mode=url.searchParams.get('mode')??'learn',cursor=Number(url.searchParams.get('cursor')??0);
      if(!['learn','recommend'].includes(mode)||!Number.isSafeInteger(cursor)||cursor<0||cursor>100000)bad(400,'Некорректная подборка');
      return json(await styleFeed(e.DB,uid,{mode,cursor}));
    }
    if(path==='/api/style/favorites'&&method==='GET')return json({items:await favorites(e.DB,uid)});
    if(path==='/api/admin/superfind'&&method==='GET')return json(await superfindState(e.DB,uid));
    const endpoints={
      '/api/style/vote':['POST','vote',['version','requestId','id','action']],
      '/api/style/favorite':['POST','favorite',['version','requestId','id','saved']],
      '/api/style/filters':['PUT','filters',['version','requestId','filters']],
      '/api/style/me':['DELETE','reset',['version','requestId']],
      '/api/style/history':['DELETE','forget',['version','requestId']],
      '/api/admin/superfind/settings':['PUT','super-settings',['version','requestId','settings']],
      '/api/admin/superfind/decision':['POST','super-decision',['version','requestId','id','action']],
    },entry=endpoints[path];
    if(!entry||method!==entry[0])bad(404,'Не найдено');
    const input=await body(request,entry[2]);return json(await mutate(e.DB,uid,input,entry[1]));
  });
}
function background(env,ctx,operation){
  // Detached work has its own reservation; HTTP202 has already settled.
  const work=e=>budget(e,1000,384,operation);
  ctx.waitUntil((env.FEATURE_BACKGROUND?env.FEATURE_BACKGROUND(work):work(env)).catch(()=>console.error('STYLE_BACKGROUND_FAILED')));
}
export default {async fetch(request,env,ctx={waitUntil:p=>p.catch(()=>{})}){
  let response;try{response=await route(request,env,ctx);}catch(error){response=json({error:error instanceof FeatureError?error.message:error.status===429?error.message:'Новые функции временно недоступны'},error.status??503);}
  const out=new Response(response.body,response);out.headers.set('Cache-Control','no-store');out.headers.set('X-Content-Type-Options','nosniff');out.headers.set('Referrer-Policy','no-referrer');
  out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://*.wbbasket.ru; connect-src 'self'; frame-ancestors 'self' https://*.telegram.org; object-src 'none'; base-uri 'none'");return out;
}};
