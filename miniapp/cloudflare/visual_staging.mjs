// Isolated preview harness. It has no scheduled handler, publication route,
// search operation, reaction mutation, or license acceptance operation.
import {equal} from './auth.mjs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureLearning} from './learning.mjs';
import {ensureVisual,visualRun,visualStatus} from './visual_enrichment.mjs';
import {withReadBudget} from './read_guard.mjs';
import {observeD1} from './d1_budget.mjs';

const productionDB='d73d252d-3948-425b-b7c3-b65d0f5c6e5f';
// Previously unanalysed second views of three real products. No first-view
// repeat is required to prove a native binding and persistent D1 cache.
export const STAGING_PRODUCTS=[
  {id:163106569,title:'Поло · второе фото',image:'https://basket-11.wbbasket.ru/vol1631/part163106/163106569/images/big/2.webp'},
  {id:742502965,title:'Кроссовки · второе фото',image:'https://basket-35.wbbasket.ru/vol7425/part742502/742502965/images/big/2.webp'},
  {id:812988272,title:'Сумка · второе фото',image:'https://basket-37.wbbasket.ru/vol8129/part812988/812988272/images/big/2.webp'}
];
export default {
  async fetch(request,env){
    if(env.VISUAL_STAGING!=='isolated'||!/^[a-f0-9-]{36}$/.test(env.VISUAL_STAGING_DB_ID||'')||env.VISUAL_STAGING_DB_ID===productionDB)return new Response('Staging isolation required',{status:503});
    const path=new URL(request.url).pathname;
    if(path==='/api/health')return Response.json({ok:true,staging:true,scheduled:false,deployment_id:env.CF_VERSION?.id||null});
    const key=env.MINIAPP_SYNC_KEY||'';
    if(key.length<32||!equal(request.headers.get('Authorization'),'Bearer '+key))return new Response('Unauthorized',{status:403});
    const meter=observeD1(env.DB),e={...env,DB:meter.DB};
    const json=data=>Response.json({...data,d1:{...meter.metrics},deployment_id:env.CF_VERSION?.id||null});
    try{
      if(request.method==='POST'&&path.startsWith('/staging/init/')){
        const phase=path.split('/').at(-1);
        if(phase==='base')await e.DB.prepare('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)').run();
        else if(phase==='scheduler')await ensureScheduler(e);
        else if(phase==='learning')await ensureLearning(e);
        else if(phase==='visual')await ensureVisual(e);
        else return new Response('Unknown phase',{status:404});
        return json({initialized:phase});
      }
      if(request.method==='POST'&&path==='/staging/seed'){
        const ts=Math.floor(Date.now()/1000);
        await e.DB.batch(STAGING_PRODUCTS.map(p=>e.DB.prepare("INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,state) VALUES(?,?,'visual-staging',?,?,?,?,'ready')").bind(p.id,JSON.stringify(p),String(p.id),ts,ts,ts+86400)));
        return json({products:STAGING_PRODUCTS.map(p=>p.id)});
      }
      if(request.method==='GET'&&path==='/staging/status')return json(await visualStatus(e));
      if(request.method==='POST'&&path==='/staging/run'){
        const data=await request.json();if(!STAGING_PRODUCTS.some(p=>p.id===data.pid))return new Response('Fixed real sample only',{status:403});
        return json(await withReadBudget(e,'optional',6000,runtime=>visualRun(runtime,{force:true,pid:data.pid}),{writes:2048}));
      }
      return new Response('Not found',{status:404});
    }catch{return json({ok:false,error:'STAGING_CHECK_FAILED'});}
  }
};
