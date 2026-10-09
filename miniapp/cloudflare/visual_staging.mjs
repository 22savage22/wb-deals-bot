// Isolated preview harness. It has no scheduled handler, publication route,
// search operation, reaction mutation, or license acceptance operation.
import {equal} from './auth.mjs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureLearning} from './learning.mjs';
import {ensureVisual,visualRun,visualStatus,cachedProfiles} from './visual_enrichment.mjs';
import {withReadBudget} from './read_guard.mjs';
import {observeD1} from './d1_budget.mjs';
import samples from './visual_staging_samples.json' with {type:'json'};

// These ten reviewed byte versions are intentionally replayed once to verify
// native binding, isolated D1 and measured accuracy. Re-runs use the D1 cache.
export const STAGING_PRODUCTS=samples.products;
export default {
  async fetch(request,env){
    if(env.VISUAL_STAGING!=='isolated'||env.VISUAL_STAGING_DB_ID!==samples.database.id)return new Response('Staging isolation required',{status:503});
    const path=new URL(request.url).pathname;
    if(path==='/api/health')return Response.json({ok:true,staging:true,scheduled:false,database_id:samples.database.id,deployment_id:env.CF_VERSION?.id||null});
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
        // Charge the known prior experiment on its UTC day, atomically once.
        // Never credit back other account usage or replace an existing ledger.
        const day=new Date().toISOString().slice(0,10),prior=samples.prior_usage,marker='visual_staging_prior:'+day;
        if(day===prior.day)await e.DB.batch([
          e.DB.prepare('INSERT INTO visual_neuron_budget(day,charged) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM metadata WHERE key=?) ON CONFLICT(day) DO UPDATE SET charged=charged+excluded.charged').bind(day,prior.neurons,marker),
          e.DB.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').bind(marker,String(prior.neurons))
        ]);
        await e.DB.batch(STAGING_PRODUCTS.map(p=>e.DB.prepare("INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,state) VALUES(?,?,'visual-staging',?,?,?,?,'ready')").bind(p.id,JSON.stringify({id:p.id,title:p.title,image:p.image,visual_group:p.visual_group}),String(p.id),ts,ts,ts+86400)));
        return json({products:STAGING_PRODUCTS.map(p=>p.id)});
      }
      if(request.method==='GET'&&path==='/staging/status'){
        const learning=await e.DB.prepare('SELECT config FROM learning_state WHERE id=1').first();
        return json({...await visualStatus(e),database_id:samples.database.id,river_mode:JSON.parse(learning?.config||'{}').mode});
      }
      if(request.method==='POST'&&path==='/staging/run'){
        const data=await request.json();if(!STAGING_PRODUCTS.some(p=>p.id===data.pid))return new Response('Fixed real sample only',{status:403});
        const result=await withReadBudget(e,'optional',6000,runtime=>visualRun(runtime,{force:true,pid:data.pid,maxImages:1}),{writes:2048});
        return json({...result,profile:result.profile||(await cachedProfiles(e,[data.pid])).get(data.pid)||null});
      }
      return new Response('Not found',{status:404});
    }catch{return json({ok:false,error:'STAGING_CHECK_FAILED'});}
  }
};
