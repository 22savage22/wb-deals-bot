// Real Miniflare/workerd rows_read, synthetic LOCAL fixture, not production.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureLearning,learningRoute,importFeedback,shadowChoice} from './learning.mjs';
import {adminRoute} from './admin_api.mjs';
import {observeD1} from './d1_budget.mjs';
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'admin-budget',compatibilityDate:'2026-09-01',modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'local-admin-benchmark'}}],cf:false}));
try{
  const DB=await mf.getD1Database('DB','admin-budget'),env={DB,SCHEDULER_DRIVER:'cloudflare-native'},now=Math.floor(Date.now()/1000),helpers={json:Response.json,payload:r=>r.json(),fail:(code,message)=>{throw Error(message);}};
  for(const sql of readFileSync(new URL('./schema.sql',import.meta.url),'utf8').split(';').filter(x=>x.trim()))await DB.prepare(sql).run();
  await ensureScheduler(env);await ensureLearning(env);
  const cards=Array.from({length:300},(_,i)=>({id:10000+i,title:'Fixture '+i,category:'category'+i%30,query:'query'+i%30,price:999,product:999,brand:'fixture',rating:4.8,feedbacks:100}));
  await DB.prepare("INSERT INTO products(id,data,checked_at) SELECT json_extract(value,'$.id'),value,? FROM json_each(?)").bind(now,JSON.stringify(cards)).run();
  const measure=async(label,operation)=>{const meter=observeD1(DB);await operation({...env,DB:meter.DB});console.log(JSON.stringify({label,...meter.metrics,top_queries:meter.topQueries()}));return meter.metrics;};
  await importFeedback(env,cards.slice(0,20).map(p=>({pid:p.id,likes:2,dislikes:1,bought:0})));
  const overview=await measure('admin.overview',e=>adminRoute(new Request('https://local/api/admin/overview'),e,helpers));
  const learning=await measure('admin.learning',e=>learningRoute(new Request('https://local/api/admin/learning'),e,helpers));
  const training=await measure('admin.train_batch',e=>learningRoute(new Request('https://local/api/admin/learning/train'),e,helpers));
  const imported=await measure('admin.import_20',e=>importFeedback(e,cards.slice(0,20).map(p=>({pid:p.id,likes:3,dislikes:2,bought:1}))));
  const rows=cards.map(p=>({pid:p.id,data:JSON.stringify(p)}));
  const shadow=await measure('admin.shadow_choice',e=>shadowChoice(e,rows,rows[0]));
  const safety=10000,forecast=2880*(overview.rows_read+2)+72*(training.rows_read+imported.rows_read+8)+144*shadow.rows_read+72+10*learning.rows_read+safety;
  console.log('ADMIN_ADDITIONAL_ROWS_DAY_ESTIMATE',forecast,'assumes owner visible 24h, 144 posts, 72 learning jobs, 10 learning-screen opens; includes 10000 margin');
}finally{await mf.dispose();}
