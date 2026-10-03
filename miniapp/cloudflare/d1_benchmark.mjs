// LOCAL Miniflare/workerd D1 metadata; synthetic stress fixture, never production.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {ensureScheduler,SCHEDULER_INDEXES} from './scheduler_api.mjs';
import {nativeTick} from './native_scheduler.mjs';
import {observeD1} from './d1_budget.mjs';
import {catalogSnapshot} from './catalog_cache.mjs';
import worker from './worker.mjs';
const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'budget',compatibilityDate:'2026-09-01',modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'budget-benchmark'}}],cf:false}));
try{
  const db=await mf.getD1Database('DB','budget'),now=Math.floor(Date.now()/1000);
  for(const sql of readFileSync(new URL('./schema.sql',import.meta.url),'utf8').split(';').filter(x=>x.trim()))await db.prepare(sql).run();
  await ensureScheduler({DB:db});
  const records=Array.from({length:10000},(_,i)=>({id:100000+i,title:'Fixture '+i,category:'Fixture',query:'topic'+i%40,price:700,product:700,image:'https://basket-01.wbbasket.ru/x',rating:4.8,feedbacks:100,checked_at:now}));
  for(let i=0;i<records.length;i+=500)await db.prepare("INSERT INTO products(id,data,checked_at) SELECT json_extract(value,'$.id'),value,? FROM json_each(?)").bind(now,JSON.stringify(records.slice(i,i+500))).run();
  const inventory=records.slice(0,300).map(p=>({pid:p.id,data:JSON.stringify(p),topic:p.query,title_key:p.title}));
  await db.prepare("INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires) SELECT json_extract(value,'$.pid'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,?,? FROM json_each(?)").bind(now,now,now+86400,JSON.stringify(inventory)).run();
  const history=Array.from({length:10000},(_,i)=>({pid:300000+i,ts:i<144?now-600-i*600:now-86400-i*600,topic:'topic'+i%40,title_key:'prior'+i}));
  await db.prepare("INSERT INTO scheduler_deliveries(pid,ts,topic,title_key,data) SELECT json_extract(value,'$.pid'),json_extract(value,'$.ts'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),'{}' FROM json_each(?)").bind(JSON.stringify(history)).run();
  await db.prepare('INSERT INTO scheduler_posts VALUES(?,?)').bind(999999,now-60).run();
  await db.prepare("INSERT INTO scheduler_policy VALUES(1,?)").bind(JSON.stringify({chat_id:'-100123456789',queries:['topic0'],total_posts:10000})).run();
  await db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.min_queue',300),status=json_set(status,'$.last_scan_attempt',?,'$.last_scan_added',1,'$.last_maintenance',?,'$.last_preflight',?) WHERE id=1").bind(now,now,now).run();
  const measure=async(label,sql,...args)=>{
    const result=await db.prepare(sql).bind(...args).all();
    const out={label,rows_read:result.meta.rows_read,rows_written:result.meta.rows_written};console.log(JSON.stringify(out));return out;
  };
  const baseline=[];
  for(let i=0;i<2;i++){
    baseline.push(await measure('before.queue_count',"SELECT COUNT(*) FROM scheduler_inventory WHERE state='ready' AND expires>?",now));
    baseline.push(await measure('before.queue',"SELECT * FROM scheduler_inventory WHERE state='ready' AND expires>? AND retry_at<=? ORDER BY queued_at,pid LIMIT 300",now,now));
    baseline.push(await measure('before.history','SELECT * FROM scheduler_deliveries WHERE ts>? ORDER BY ts',now-86400));
  }
  const catalogBefore=await measure('before.catalog','SELECT data,overrides FROM products ORDER BY checked_at DESC LIMIT 3000');
  const originalCap=`UPDATE scheduler_inventory SET state='cooldown',retry_at=COALESCE((SELECT MIN(ts)+86401 FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?),?) WHERE state='ready' AND (SELECT COUNT(*) FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?)>=8`;
  // Disposable local database ONLY: reproduce the pre-incident missing indexes.
  await db.prepare('DROP INDEX scheduler_deliveries_topic_time').run();await db.prepare('DROP INDEX scheduler_deliveries_time').run();
  await measure('before.preindex_topic_cap',originalCap,now-86400,now+3600,now-86400);
  for(const sql of SCHEDULER_INDEXES.filter(x=>x.includes('scheduler_deliveries')))await db.prepare(sql).run();
  await measure('before.indexed_correlated_cap',originalCap,now-86400,now+3600,now-86400);
  await measure('after.grouped_cap',`UPDATE scheduler_inventory SET state='cooldown',retry_at=COALESCE((SELECT MIN(ts)+86401 FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?),?) WHERE state='ready' AND topic IN (SELECT topic FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic HAVING COUNT(*)>=8)`,now-86400,now+3600,now-86400);
  const meter=observeD1(db);
  await nativeTick({DB:meter.DB,SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'fixture'},Date.now(),()=>{throw new Error('Network forbidden in benchmark');});
  console.log('after.idle_tick',JSON.stringify(meter.metrics));
  await db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_maintenance',0)").run();
  const cleanup=observeD1(db);await nativeTick({DB:cleanup.DB},Date.now(),()=>{throw new Error('Network forbidden');});console.log('after.maintenance_tick',JSON.stringify(cleanup.metrics));
  await db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_scan_attempt',0)").run();
  const search=observeD1(db);await nativeTick({DB:search.DB},Date.now(),async()=>Response.json({products:[]}));console.log('after.search_tick_empty',JSON.stringify(search.metrics));
  await db.prepare('UPDATE scheduler_posts SET ts=? WHERE pid=999999').bind(now-1000).run();
  const post=observeD1(db);await nativeTick({DB:post.DB,TG_BOT_TOKEN:'fixture',MINIAPP_BOT_USERNAME:'fixture'},Date.now(),async url=>{
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
    if(url.includes('sendPhoto'))return Response.json({ok:true,result:{message_id:123}});
    const id=Number(new URL(url).searchParams.get('nm'));
    return Response.json({products:[{id,name:'Fixture '+(id-100000),reviewRating:4.8,feedbacks:100,subjectName:'Fixture',sizes:[{qty:1,price:{product:70000,basic:70000}}]}]});
  });console.log('after.post_tick_stub',JSON.stringify(post.metrics));
  const first=observeD1(db);await catalogSnapshot(first.DB,now);console.log('after.catalog_rebuild',JSON.stringify(first.metrics));
  const hit=observeD1(db);await catalogSnapshot(hit.DB,now+1);console.log('after.catalog_hit',JSON.stringify(hit.metrics));
  console.log('before.partial_idle_tick_reads',baseline.reduce((n,x)=>n+x.rows_read,0));
  console.log('catalog_1000_requests_before',catalogBefore.rows_read*1000);
  console.log('catalog_1000_requests_after_one_window',first.metrics.rows_read+hit.metrics.rows_read*999);
  const complete=observeD1(db);await worker.scheduled({scheduledTime:Date.now()},{DB:complete.DB,SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'fixture'});console.log('after.complete_idle_tick_with_guard',JSON.stringify(complete.metrics));
  const steady=observeD1(db);await worker.scheduled({scheduledTime:Date.now()},{DB:steady.DB,SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'fixture'});console.log('after.complete_steady_idle_tick_with_guard',JSON.stringify(steady.metrics));
  console.log('forecast_reads_day_144_posts_288_maintenance_72_search_1000_catalog_requests',1440*steady.metrics.rows_read+144*post.metrics.rows_read+288*cleanup.metrics.rows_read+72*search.metrics.rows_read+288*first.metrics.rows_read+1000*hit.metrics.rows_read+100000);
}finally{await mf.dispose();}
