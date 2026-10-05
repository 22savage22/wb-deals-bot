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
import {ensureReactions,vote} from './feedback.mjs';
import {queueHealth,searchState,mainProblem} from '../admin/view.mjs';
const now=()=>Math.floor(Date.now()/1000);
function environment(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  let calls=0;const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){calls++;return db.prepare(sql).get(...args)||null;},async all(){calls++;return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async run(){calls++;const changes=Number(db.prepare(sql).run(...args).changes);return {meta:{changes,rows_read:1,rows_written:changes}};}});
  return {db,get calls(){return calls;},TG_BOT_TOKEN:'456:main-test-only',MINIAPP_BOT_TOKEN:'123:test-only',MINIAPP_ADMIN_ID:'11',MINIAPP_SYNC_KEY:'s'.repeat(40),MINIAPP_BOT_USERNAME:'test_bot',SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async r=>new Response(new URL(r.url).pathname)}};
}
function signed(e,id=11,date=now(),token=e.TG_BOT_TOKEN){
  const fields={auth_date:String(date),user:JSON.stringify({id})},check=Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('\n'),secret=createHmac('sha256','WebAppData').update(token).digest();
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
test('main-bot owner auth is isolated from public-bot sessions, including forged owner IDs',async()=>{
  const e=environment();await ensureScheduler(e);
  const call=(path,raw,method='GET')=>worker.fetch(new Request('https://test.example'+path,{method,headers:{'X-Telegram-Init-Data':raw}}),e);
  const before=e.calls;
  for(const id of [11,22])assert.equal((await call('/api/admin/overview',signed(e,id,now(),e.MINIAPP_BOT_TOKEN))).status,401);
  assert.equal((await call('/api/admin/session',signed(e,22),'POST')).status,403);
  assert.equal((await call('/api/admin/session',signed(e).replace('11','22'),'POST')).status,401);
  assert.equal(e.calls,before,'denied users must not reach D1');
  assert.equal((await call('/api/me',signed(e))).status,401,'main bot cannot authenticate public user endpoints');
  assert.equal((await call('/api/me',signed(e,22,now(),e.MINIAPP_BOT_TOKEN))).status,200);
  const settings=e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get();
  assert.equal((await call('/api/admin/session',signed(e),'POST')).status,200);
  assert.equal(JSON.parse(e.db.prepare("SELECT value FROM metadata WHERE key='owner_admin_open'").get().value).owner_verified,true);
  assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get(),settings);
  e.db.close();
});
test('public frontend CSP remains unchanged; admin shell does not expose private data',async()=>{
  const e=environment(),admin=await req(e,'/admin'),publicApp=await req(e,'/');
  assert.equal(await admin.text(),'/admin/index.html');assert.match(admin.headers.get('content-security-policy'),/style-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(publicApp.headers.get('content-security-policy'),/unsafe-inline/);assert.equal(e.calls,0);e.db.close();
});
test('admin first open reads the exact D1 schedule without writing defaults or changing 30 minutes',async()=>{
  const e=environment();await ensureScheduler(e);
  const original=e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get();
  const stored={...JSON.parse(original.data),post_interval_minutes:30,search_interval_minutes:60};
  e.db.prepare('UPDATE scheduler_config SET data=?,revision=? WHERE id=1').run(JSON.stringify(stored),12345);
  const before=e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get();
  const overview=await(await req(e,'/api/admin/overview')).json();
  assert.equal(overview.schedule.post_interval_minutes,30);
  assert.equal(overview.schedule.search_interval_minutes,60);
  assert.equal(overview.revision,12345);
  assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get(),before);
  const direct=await(await req(e,'/api/admin/schedule')).json();
  assert.equal(direct.schedule.post_interval_minutes,30);
  assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get(),before);
  e.db.close();
});
test('first admin open cannot initialize a missing production scheduler with defaults',async()=>{
  const e=environment();
  assert.equal((await req(e,'/api/admin/overview')).status,503);
  assert.equal(e.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_config'").get(),undefined);
  e.db.close();
});
test('admin refuses an incomplete D1 schedule instead of showing and persisting a default',async()=>{
  const e=environment();await ensureScheduler(e);
  const row=e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get(),stored=JSON.parse(row.data);
  delete stored.post_interval_minutes;
  e.db.prepare('UPDATE scheduler_config SET data=? WHERE id=1').run(JSON.stringify(stored));
  assert.equal((await req(e,'/api/admin/overview')).status,503);
  const after=e.db.prepare('SELECT data,revision FROM scheduler_config WHERE id=1').get();
  assert.equal(after.data,JSON.stringify(stored));assert.equal(after.revision,row.revision);
  e.db.close();
});
test('explicit interval change uses revision CAS and cannot overwrite a newer admin edit',async()=>{
  const e=environment();await ensureScheduler(e);
  const saved=await(await req(e,'/api/admin/overview')).json();
  assert.equal((await req(e,'/api/admin/schedule','PUT',{schedule:{...saved.schedule,post_interval_minutes:30},revision:saved.revision})).status,200);
  const current=await(await req(e,'/api/admin/overview')).json();
  assert.equal(current.schedule.post_interval_minutes,30);
  assert.equal((await req(e,'/api/admin/schedule','PUT',{schedule:{...saved.schedule,post_interval_minutes:5},revision:saved.revision})).status,409);
  assert.equal((await(await req(e,'/api/admin/overview')).json()).schedule.post_interval_minutes,30);
  e.db.close();
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

test('overview honors persisted WB backoff; preview does not change 30-minute production settings',async()=>{
  const e=environment();await prepared(e);const s={...DEFAULT_SCHEDULE,post_interval_minutes:30};
  const retry=now()+7200;e.db.prepare('UPDATE scheduler_config SET data=?,revision=17,status=?').run(JSON.stringify(s),JSON.stringify({search_retry_at:retry,last_scan_attempt:now(),next_search:retry}));
  const before=e.db.prepare('SELECT data,revision,status FROM scheduler_config').get();
  const overview=await(await req(e,'/api/admin/overview')).json();assert.equal(overview.status.next_search,retry);
  const preview=await(await req(e,'/api/admin/schedule/preview','POST',{schedule:{...s,post_interval_minutes:5}})).json();assert.equal(preview.preview,true);
  assert.deepEqual(e.db.prepare('SELECT data,revision,status FROM scheduler_config').get(),before);e.db.close();
});
function inventory(e,n=15){for(let i=1;i<=n;i++)e.db.prepare('INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires) VALUES(?,?,?,?,?,?,?)').run(i,JSON.stringify(product(i)),'платья','dress'+i,100,now(),now()+86400);}
test('queue pages are indexed and bounded; read/open never changes settings',async()=>{
  const e=environment();await prepared(e);inventory(e);const before=e.db.prepare('SELECT data,revision FROM scheduler_config').get();
  const calls=e.calls;assert.equal((await req(e,'/api/admin/queue','GET',null,22)).status,403);assert.equal(e.calls,calls);
  assert.equal((await req(e,'/api/admin/schedule/preview','POST',{schedule:DEFAULT_SCHEDULE},22)).status,403);assert.equal(e.calls,calls);
  const a=await(await req(e,'/api/admin/queue')).json();assert.equal(a.items.length,6);
  const b=await(await req(e,'/api/admin/queue?cursor='+a.next_cursor)).json();assert.equal(b.items.length,6);assert.equal(b.items[0].pid,7);
  assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config').get(),before);
  assert.match(JSON.stringify(e.db.prepare("EXPLAIN QUERY PLAN SELECT pid FROM scheduler_inventory WHERE state='ready' AND (queued_at,pid)>(100,6) ORDER BY queued_at,pid LIMIT 7").all()),/scheduler_inventory_order/);
  assert.equal((await req(e,'/api/admin/queue?cursor=bad')).status,400);e.db.close();
});
test('queue actions are idempotent, preserve tombstones and reject active publication leases',async()=>{
  const e=environment();await prepared(e);inventory(e);
  const skip={action:'skip',pid:1,request_id:'real-fixture-id'};
  assert.equal((await req(e,'/api/admin/queue','POST',skip)).status,202);
  assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=1').get().state,'admin_skipped');
  assert.equal((await(await req(e,'/api/admin/queue','POST',skip)).json()).duplicate,true);
  assert.equal(e.db.prepare('SELECT ready FROM scheduler_counts').get().ready,14);
  e.db.prepare("INSERT INTO scheduler_leases VALUES('post','running',?)").run(now()+60);
  assert.equal((await req(e,'/api/admin/queue','POST',{action:'delete',pid:2,request_id:'blocked'})).status,409);
  e.db.prepare('DELETE FROM scheduler_leases').run();
  const before=e.db.prepare('SELECT data,revision FROM scheduler_config').get();
  assert.equal((await req(e,'/api/admin/queue','POST',{action:'post',pid:2,request_id:'chosen-card'})).status,202);
  const config=e.db.prepare('SELECT * FROM scheduler_config').get();assert.equal(JSON.parse(config.status).admin_product_id,2);assert.match(config.post_request,/chosen-card/);
  assert.deepEqual({data:config.data,revision:config.revision},{...before});e.db.close();
});
test('materialized real totals survive vote changes/restart and exclude non-channel actors',async()=>{
  const e=environment();await prepared(e);await ensureReactions(e);card(e,1);
  await vote(e,{pid:1,voter:'local-only-A',action:'l',event_id:1});
  const first=await(await req(e,'/api/admin/learning')).json();assert.equal(first.current_votes.likes,1);
  await vote(e,{pid:1,voter:'local-only-A',action:'l',event_id:2});
  await vote(e,{pid:1,voter:'local-only-A',action:'d',event_id:3});
  await vote(e,{scope:'test',pid:1,voter:'local-only-B',action:'l',event_id:4});
  const view=await(await req({...e},'/api/admin/learning')).json();assert.deepEqual(view.current_votes,{likes:0,dislikes:1,bought:0});
  assert.equal(view.today_reactions,2,'two sentiment events, one current real vote');
  assert.equal(view.config.mode,'SHADOW');assert.equal(view.learning_allowed,false);e.db.close();
});
test('bounded historical summary backfill is not repeated and live event triggers aggregate once',async()=>{
  const e=environment();await prepared(e);card(e,1);
  for(let i=0;i<120;i++)e.db.prepare('INSERT INTO learning_events(event_key,ts,pid,kind,weight,features) VALUES(?,?,?,?,?,?)').run('local'+i,now(),1,i%2?'like':'dislike',1,JSON.stringify(features(product(1))));
  let view=await(await req(e,'/api/admin/learning')).json();assert.equal(view.backfill_complete,false);
  view=await(await req(e,'/api/admin/learning')).json();assert.equal(view.backfill_complete,true);assert.equal(view.today_reactions,120);
  await recordEvent(e,{key:'local-late',pid:1,kind:'buy'});
  view=await(await req(e,'/api/admin/learning')).json();assert.equal(view.today_reactions,121);
  assert.equal((await(await req(e,'/api/admin/learning')).json()).today_reactions,121);e.db.close();
});
test('human UI queue thresholds and backoff do not claim an ordinary 429 waiting period stops posting',()=>{
  assert.deepEqual([50,49,29,9].map(n=>queueHealth(n).tone),['green','yellow','orange','red']);
  const waiting=searchState(DEFAULT_SCHEDULE,{search_retry_at:1600,last_scan_error:'WB HTTP 429'},1000);assert.equal(waiting.tone,'yellow');assert.match(waiting.detail,/10 мин/);
  assert.equal(mainProblem({cron_active:true,last_scan_error:'WB HTTP 429'}),'');
});
