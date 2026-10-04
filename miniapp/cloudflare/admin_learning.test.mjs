import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker from './worker.mjs';
import {ensureScheduler,DEFAULT_SCHEDULE} from './scheduler_api.mjs';
import {ensureLearning,importFeedback,recordEvent,shadowChoice,predict,features,explorationQuery} from './learning.mjs';
import {nextPost} from './admin_api.mjs';
import {createClient} from '../admin/client.mjs';
import {nativeTick} from './native_scheduler.mjs';
const now=()=>Math.floor(Date.now()/1000);
function environment(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  let calls=0;const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){calls++;return db.prepare(sql).get(...args)||null;},async all(){calls++;return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async run(){calls++;const changes=Number(db.prepare(sql).run(...args).changes);return {meta:{changes,rows_read:1,rows_written:changes}};}});
  return {db,get calls(){return calls;},MINIAPP_BOT_TOKEN:'123:test-only',MINIAPP_ADMIN_ID:'11',MINIAPP_SYNC_KEY:'s'.repeat(40),MINIAPP_BOT_USERNAME:'test_bot',SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async r=>new Response(new URL(r.url).pathname)}};
}
function signed(e,id=11,date=now()){
  const fields={auth_date:String(date),user:JSON.stringify({id})},check=Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('\n'),secret=createHmac('sha256','WebAppData').update(e.MINIAPP_BOT_TOKEN).digest();
  return new URLSearchParams({...fields,hash:createHmac('sha256',secret).update(check).digest('hex')}).toString();
}
const req=(e,path,method='GET',body,id=11,ctx)=>worker.fetch(new Request('https://test.example'+path,{method,headers:{'Content-Type':'application/json',...(id?{'X-Telegram-Init-Data':signed(e,id)}:{})},...(body?{body:JSON.stringify(body)}:{})}),e,ctx);
const product=id=>({id,title:'Платье женское '+id,category:'Платья',query:'платье',brand:'Fixture',price:999,product:999,rating:4.8,feedbacks:100,checked_at:now(),image:'https://basket-01.wbbasket.ru/x'});
async function prepared(e){await ensureScheduler(e);await ensureLearning(e);}
function card(e,id){e.db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').run(id,JSON.stringify(product(id)),now());}

test('admin APIs reject non-owner, missing/expired/tampered initData BEFORE D1',async()=>{
  const e=environment();
  for(const id of [null,22]){const before=e.calls;assert.equal((await req(e,'/api/admin/overview','GET',null,id)).status,id?403:401);assert.equal(e.calls,before);}
  for(const data of [signed(e,11,now()-4000),signed(e).replace('11','22')]){
    const before=e.calls,r=await worker.fetch(new Request('https://test.example/api/admin/learning',{headers:{'X-Telegram-Init-Data':data}}),e);assert.equal(r.status,401);assert.equal(e.calls,before);
  }e.db.close();
});
test('public frontend CSP remains unchanged; admin shell does not expose private data',async()=>{
  const e=environment(),admin=await req(e,'/admin'),publicApp=await req(e,'/');
  assert.equal(await admin.text(),'/admin/index.html');assert.match(admin.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(publicApp.headers.get('content-security-policy'),/unsafe-inline/);assert.equal(e.calls,0);e.db.close();
});
test('queued buttons return without any WB/Telegram fetch, coalesce devices and survive runtime restart',async()=>{
  const e=environment();await ensureScheduler(e);const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('Button must not call the network');
  try{
    const start=performance.now(),a=await req(e,'/api/admin/schedule/action','POST',{action:'search_now',request_id:'one'});
    assert.equal(a.status,202);const accepted=await a.json();assert.equal(accepted.search_request,'one');assert.ok(performance.now()-start<1000);
    assert.equal((await(await req(e,'/api/admin/schedule/action','POST',{action:'search_now',request_id:'two'})).json()).search_request,'one');
    const first=await(await req(e,'/api/admin/overview')).json();
    await req(e,'/api/admin/schedule','PUT',{schedule:{...first.schedule,post_interval_minutes:20,timezone:'Asia/Kathmandu',mode:'times',post_times:['10:30','18:15'],quiet_enabled:true},revision:first.revision});
    const restarted=await(await req({...e},'/api/admin/overview')).json();assert.equal(restarted.schedule.timezone,'Asia/Kathmandu');assert.equal(restarted.schedule.post_interval_minutes,20);assert.deepEqual(restarted.schedule.post_times,['10:30','18:15']);
  }finally{globalThis.fetch=original;e.db.close();}
});
test('async safe check confirms launch before slow network, deduplicates and creates no posts',async()=>{
  const e=environment();await ensureScheduler(e);
  e.db.prepare('INSERT INTO scheduler_policy VALUES(1,?)').run(JSON.stringify({chat_id:'-100123456789',queries:['платье']}));e.TG_BOT_TOKEN='fixture';
  e.db.prepare('UPDATE scheduler_config SET status=?').run(JSON.stringify({last_scheduler_tick:now()}));
  const pending=[],original=globalThis.fetch;let calls=0,unblock;
  globalThis.fetch=()=>{calls++;return new Promise(resolve=>unblock=()=>resolve(Response.json({ok:true})));};
  try{
    const ctx={waitUntil:p=>pending.push(p)},start=performance.now();
    assert.equal((await req(e,'/api/admin/check','POST',{request_id:'test-check'},11,ctx)).status,202);
    assert.ok(performance.now()-start<1000);
    await req(e,'/api/admin/check','POST',{request_id:'test-check'},11,ctx);assert.equal(pending.length,1);
    assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM scheduler_posts').get().n,0);
    for(let i=0;i<10&&!unblock;i++)await new Promise(r=>setImmediate(r));assert.equal(calls,1);unblock();await Promise.all(pending);
    assert.equal(JSON.parse(e.db.prepare('SELECT status FROM scheduler_config').get().status).admin_check_state,'complete');
  }finally{globalThis.fetch=original;e.db.close();}
});
test('next post handles Moscow quiet overnight, fixed slots, non-whole-hour zone and disabled days',()=>{
  const ts=s=>Date.parse(s)/1000,s={...DEFAULT_SCHEDULE,quiet_enabled:true};
  assert.equal(nextPost(s,ts('2026-10-02T19:40:00Z'),ts('2026-10-02T20:05:00Z')),ts('2026-10-03T04:00:00Z'));
  assert.equal(nextPost({...s,paused:true},0,now()),null);
  const fixed={...DEFAULT_SCHEDULE,mode:'times',post_times:['00:15'],timezone:'Asia/Kathmandu'};
  const t=nextPost(fixed,ts('2026-10-02T12:00:00Z'),ts('2026-10-02T17:45:00Z'));
  assert.equal(t,ts('2026-10-02T18:30:00Z'));
  assert.equal(nextPost({...DEFAULT_SCHEDULE,natural_interval_enabled:true},602,602),602+10*60+((602%5)-2)*60);
});
test('client double click and ambiguous network response reuse durable idempotency ID',async()=>{
  const storage=new Map(),store={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  let calls=0,resolve;const requests=[];
  const c=createClient('test',async(url,options)=>{calls++;requests.push(JSON.parse(options.body));if(calls===1)return new Promise(r=>resolve=r);return Response.json({accepted:true});},store);
  const first=c.action('search_now');assert.deepEqual(await c.action('search_now'),{duplicate:true});assert.equal(calls,1);resolve(Response.json({accepted:true}));await first;
  let tries=0;const retry=createClient('test',async(url,options)=>{requests.push(JSON.parse(options.body));if(++tries===1)throw new TypeError('offline');return Response.json({accepted:true});},store);
  await assert.rejects(()=>retry.action('post_now'));await retry.action('post_now');assert.equal(requests.at(-1).request_id,requests.at(-2).request_id);assert.equal(storage.size,0);
});
test('learning imports bounded real-card aggregates once without storing voter identity or history scans',async()=>{
  const e=environment();await prepared(e);for(let id=1;id<=20;id++)card(e,id);
  const rows=Array.from({length:20},(_,i)=>({pid:i+1,likes:3,dislikes:2,bought:1,ts:now(),voters:{secret_user:123}})),before=e.calls;
  assert.equal((await importFeedback(e,rows)).added,60);assert.ok(e.calls-before<15,'set-based import must fit Free request query limit');
  assert.equal((await importFeedback(e,rows)).added,0);
  const all=e.db.prepare("SELECT * FROM learning_stats WHERE scope='all'").get();assert.equal(all.events,60);assert.equal(all.positive,80);assert.equal(all.negative,40);
  assert.doesNotMatch(JSON.stringify(e.db.prepare('SELECT * FROM learning_events LIMIT 60').all()),/secret_user|voters/);
  for(const sql of ["SELECT * FROM learning_stats WHERE scope='all' AND key='all'","SELECT * FROM learning_stats WHERE scope='category' ORDER BY events DESC LIMIT 30","SELECT * FROM learning_events WHERE id>2 ORDER BY id LIMIT 500"]){assert.match(JSON.stringify(e.db.prepare('EXPLAIN QUERY PLAN '+sql).all()),/SEARCH|USING INDEX|PRIMARY KEY/);}
  e.db.close();
});
test('missing cards do not consume feedback counters; saves are deduplicated by opaque key',async()=>{
  const e=environment();await prepared(e);await importFeedback(e,[{pid:7,likes:2}]);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM learning_feedback').get().n,0);
  card(e,7);assert.equal((await importFeedback(e,[{pid:7,likes:2}])).added,1);
  assert.equal((await recordEvent(e,{key:'opaque-save',pid:7,kind:'save'})).added,true);assert.equal((await recordEvent(e,{key:'opaque-save',pid:7,kind:'save'})).added,false);e.db.close();
});
test('SHADOW records counterfactual choice, never mutates Legacy; learning failure cannot stop an idle tick',async()=>{
  const e=environment();await prepared(e);card(e,1);card(e,2);
  e.db.prepare('UPDATE learning_state SET model=?').run(JSON.stringify({version:1,weights:{'brand=Preferred':10},intercept:0}));
  const rows=[{pid:1,data:JSON.stringify(product(1))},{pid:2,data:JSON.stringify({...product(2),brand:'Preferred'})}],copy=structuredClone(rows);
  await shadowChoice(e,rows,rows[0]);assert.deepEqual(rows,copy);
  const shadow=e.db.prepare('SELECT * FROM learning_shadow WHERE pid=1').get();assert.equal(shadow.legacy_pid,1);assert.equal(shadow.river_pid,2);
  e.db.prepare("UPDATE scheduler_config SET data=?,status=json_set(status,'$.last_maintenance',?,'$.last_preflight',?)").run(JSON.stringify({...DEFAULT_SCHEDULE,search_enabled:false}),now(),now());
  e.db.exec('DROP TABLE learning_state');const r=await nativeTick(e,Date.now(),()=>assert.fail('Idle Cron must not call any network'));assert.equal(r.enabled,true);assert.equal(r.error,undefined);e.db.close();
});
test('LEARNING is blocked; exploration bounded 0–30; CAS prevents overwriting a newer model',async()=>{
  const e=environment();await prepared(e);
  assert.equal((await req(e,'/api/admin/learning','PUT',{mode:'LEARNING',exploration_percent:10})).status,409);
  assert.equal((await req(e,'/api/admin/learning','PUT',{mode:'SHADOW',exploration_percent:31})).status,400);
  await req(e,'/api/admin/learning','PUT',{mode:'SHADOW',exploration_percent:30});
  const counts=new Map([['платье',7]]);assert.equal(await explorationQuery(e,['платье','сумка'],0,counts,[]),'сумка');assert.equal(await explorationQuery(e,['платье','сумка'],0,counts,['сумка']),'платье');
  const model=JSON.parse(e.db.prepare('SELECT model FROM learning_state').get().model);model.cursor=1;
  assert.equal((await req(e,'/api/admin/learning/train','PUT',{model,previous_cursor:0})).status,200);
  assert.equal((await req(e,'/api/admin/learning/train','PUT',{model,previous_cursor:0})).status,409);
  const view=await(await req(e,'/api/admin/learning')).json();assert.equal(view.comparison.uplift,null);assert.equal(view.comparison.sufficient,false);assert.equal(view.legacy_fallback,true);e.db.close();
});
test('edge vector prediction is finite and product features do not collect personal data',()=>{
  const f=features({...product(1),user_id:100});assert.equal(f.user_id,undefined);assert.ok(f.price>0);assert.equal(predict({intercept:0,weights:{}},f),.5);assert.equal(predict({intercept:1000,weights:{}},f)<1,true);
});
