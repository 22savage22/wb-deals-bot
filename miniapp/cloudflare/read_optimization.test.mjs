import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureScheduler} from './scheduler_api.mjs';
import {nativeTick} from './native_scheduler.mjs';
import {catalogSnapshot} from './catalog_cache.mjs';
import {withReadBudget,READ_LIMITS,WRITE_LIMITS} from './read_guard.mjs';
function environment(t){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());const calls=[];
  const wrap=(sql,args=[])=>({bind(...a){return wrap(sql,a);},async all(){calls.push(sql);return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async first(){calls.push(sql);return db.prepare(sql).get(...args)??null;},async run(){calls.push(sql);return {meta:{changes:Number(db.prepare(sql).run(...args).changes),rows_read:1,rows_written:1}};}});
  return {db,calls,DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}}};
}
test('persistent ready counter follows inserts, rejection, cooldown, reactivation and deletion',async t=>{
  const e=environment(t);await ensureScheduler(e);
  const insert=e.db.prepare("INSERT INTO scheduler_inventory VALUES(?,'{}','topic','title',1,1,9999999999,'ready',0)");insert.run(1);insert.run(2);
  const count=()=>e.db.prepare('SELECT ready FROM scheduler_counts').get().ready;
  assert.equal(count(),2);e.db.exec("UPDATE scheduler_inventory SET state='rejected' WHERE pid=1");assert.equal(count(),1);
  e.db.exec("UPDATE scheduler_inventory SET state='cooldown' WHERE pid=2");assert.equal(count(),0);
  e.db.exec("UPDATE scheduler_inventory SET state='ready' WHERE pid=2");assert.equal(count(),1);
  e.db.exec('DELETE FROM scheduler_inventory WHERE pid=2');assert.equal(count(),0);
  await ensureScheduler({...e,DB:{...e.DB}});assert.equal(count(),0);
});
test('idle Cron skips inventory, delivery history, full counts and network',async t=>{
  const e=environment(t);await ensureScheduler(e);const now=Math.floor(Date.now()/1000);
  e.db.prepare("INSERT INTO scheduler_policy VALUES(1,'{}')").run();
  e.db.prepare('INSERT INTO scheduler_posts VALUES(1,?)').run(now-60);
  e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.search_enabled',json('false')),status=json_set(status,'$.last_maintenance',?,'$.last_preflight',?)").run(now,now);
  e.calls.length=0;await nativeTick(e,Date.now(),()=>{throw new Error('No network on idle tick');});
  assert.ok(e.calls.length<=6);assert.ok(!e.calls.some(sql=>/scheduler_inventory|scheduler_deliveries|COUNT\(/i.test(sql)),e.calls.join('\n'));
});
test('catalogue persistent snapshot survives new isolate and enforces five-minute rebuild window',async t=>{
  const e=environment(t),now=Math.floor(Date.now()/1000);
  e.db.prepare('INSERT INTO products VALUES(1,?,\'{}\',?)').run(JSON.stringify({id:1,title:'Fixture'}),now);
  assert.equal((await catalogSnapshot(e.DB,now)).length,1);
  e.calls.length=0;assert.equal((await catalogSnapshot({...e.DB},now+299)).length,1);
  assert.ok(!e.calls.some(sql=>sql.includes('FROM products')));
  await catalogSnapshot(e.DB,now+300);assert.equal(e.calls.filter(sql=>sql.includes('FROM products')).length,1);
});
test('concurrent catalogue refresh serves snapshot without launching a second scan',async t=>{
  const e=environment(t),now=Math.floor(Date.now()/1000);await catalogSnapshot(e.DB,now-301);
  e.db.prepare('INSERT INTO metadata VALUES(?,?)').run('catalog_refresh',JSON.stringify({owner:'other',expires:now+60}));e.calls.length=0;
  await catalogSnapshot(e.DB,now);assert.ok(!e.calls.some(sql=>sql.includes('FROM products')));
});
test('read budget is atomic across isolates, preserves core allowance and resets by UTC day',async t=>{
  const e=environment(t),day=new Date().toISOString().slice(0,10);
  await withReadBudget(e,'optional',15000,async env=>env.DB.prepare('SELECT 1').all());
  e.db.prepare('UPDATE worker_read_budget SET reads=? WHERE day=? AND lane=?').run(READ_LIMITS.optional-1,day,'optional');
  await assert.rejects(withReadBudget({...e,DB:{...e.DB}},'optional',15000,()=>assert.fail('Must reject before heavy SQL')),/защитный бюджет/);
  await withReadBudget(e,'core',25000,async env=>env.DB.prepare('SELECT 1').all());
  e.db.prepare('UPDATE worker_read_budget SET day=? WHERE lane=?').run('1999-01-01','optional');
  await withReadBudget(e,'optional',15000,async env=>env.DB.prepare('SELECT 1').all());
  assert.equal(e.db.prepare("SELECT reads FROM worker_read_budget WHERE day=? AND lane='optional'").get(day).reads,1);
});
test('budget reports observed rows, and unknown metadata retains conservative reservation',async t=>{
  const e=environment(t);await withReadBudget(e,'optional',15000,async env=>{await env.DB.prepare('SELECT 1').all();});
  assert.equal(e.db.prepare('SELECT reads FROM worker_read_budget').get().reads,1);
  await withReadBudget(e,'optional',15000,async()=>{});
  assert.equal(e.db.prepare('SELECT reads FROM worker_read_budget').get().reads,1);
  await withReadBudget(e,'optional',15000,async env=>{await env.DB.prepare('SELECT 1').run();});
  assert.equal(e.db.prepare('SELECT reads FROM worker_read_budget').get().reads,2);
  const original=e.DB.prepare;
  e.DB.prepare=sql=>sql==='SELECT 2'?{bind(){return this;},async all(){return {results:[]};}}:original(sql);
  await withReadBudget(e,'optional',15000,async env=>env.DB.prepare('SELECT 2').all());
  assert.equal(e.db.prepare('SELECT reads FROM worker_read_budget').get().reads,15002);
});
test('production 31526 writes is not falsely denied by a 5000-write reservation',async t=>{
  const e=environment(t),day=new Date().toISOString().slice(0,10);
  await withReadBudget(e,'core',25000,async()=>{});
  e.db.prepare("UPDATE worker_read_budget SET reads=?,writes=? WHERE day=? AND lane='core'").run(293505,31526,day);
  await withReadBudget(e,'core',25000,async env=>env.DB.prepare('SELECT 1').all());
  const row=e.db.prepare("SELECT reads,writes FROM worker_read_budget WHERE lane='core'").get();
  assert.equal(row.reads,293506);assert.equal(row.writes,31528);
  await withReadBudget(e,'diagnostic',1500,async env=>env.DB.prepare('SELECT 1').all());
});
test('network/app failure retains actual D1 costs, not worst-case fake usage',async t=>{
  const e=environment(t);
  await assert.rejects(withReadBudget(e,'core',25000,async env=>{await env.DB.prepare('SELECT 1').all();throw new Error('Network unavailable');}),/Network unavailable/);
  const row=e.db.prepare('SELECT reads,writes FROM worker_read_budget').get();assert.equal(row.reads,1);assert.equal(row.writes,2);
});
test('write guard prevents bookkeeping from exhausting the write quota; failed operations retain reservation',async t=>{
  const e=environment(t);await withReadBudget(e,'optional',15000,async env=>env.DB.prepare('SELECT 1').all());
  e.db.prepare("UPDATE worker_read_budget SET writes=? WHERE lane='optional'").run(WRITE_LIMITS.optional-1);
  await assert.rejects(withReadBudget(e,'optional',15000,()=>assert.fail('No work when write allowance is spent')),/защитный бюджет/);
  await assert.rejects(withReadBudget(e,'core',25000,()=>{throw new Error('Fixture failure');}),/Fixture failure/);
  const row=e.db.prepare("SELECT reads,writes FROM worker_read_budget WHERE lane='core'").get();assert.equal(row.reads,0);assert.equal(row.writes,2);
});
test('owner validation errors do not consume worst-case scheduler funds',async t=>{
  const e=environment(t);class HttpError extends Error{constructor(){super('Owner typo');this.status=400;}}
  for(let i=0;i<20;i++)await assert.rejects(withReadBudget(e,'core',25000,()=>{throw new HttpError();}),/Owner typo/);
  const row=e.db.prepare('SELECT reads,writes FROM worker_read_budget').get();assert.equal(row.reads,0);assert.equal(row.writes,40);
});
test('cold schema v2 upgrade plus successful native send stays inside 50-query Free ceiling',async t=>{
  const e=environment(t);await ensureScheduler(e);const now=Math.floor(Date.now()/1000);
  e.db.prepare("INSERT INTO scheduler_policy VALUES(1,?)").run(JSON.stringify({chat_id:'-100123456789',queries:['dress'],total_posts:0}));
  const p={id:1,title:'Fixture',product:700,query:'dress',image:'https://basket-01.wbbasket.ru/x'};
  e.db.prepare("INSERT INTO scheduler_inventory VALUES(1,?,'dress','fixture',?,0,?,'ready',0)").run(JSON.stringify(p),now,now+10000);
  e.db.exec("UPDATE scheduler_config SET status=json_set(status,'$.schema_version',2)");e.calls.length=0;
  const result=await withReadBudget({...e,DB:{...e.DB},TG_BOT_TOKEN:'fixture'},'core',25000,env=>nativeTick(env,Date.now(),async url=>{
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
    if(url.includes('sendPhoto'))return Response.json({ok:true,result:{message_id:123}});
    return Response.json({products:[{id:1,name:'Fixture',reviewRating:4.8,feedbacks:100,sizes:[{qty:1,price:{product:70000,basic:70000}}]}]});
  }));
  assert.equal(result.results.post.result,'success');assert.ok(e.calls.length<=50,'Cold migration+guard+publication queries: '+e.calls.length);
});
test('empty queue cannot keep loading publication history every minute',async t=>{
  const e=environment(t);await ensureScheduler(e);const now=Math.floor(Date.now()/1000);
  e.db.prepare("INSERT INTO scheduler_policy VALUES(1,'{}')").run();
  e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.search_enabled',json('false')),status=json_set(status,'$.last_maintenance',?)").run(now);
  e.calls.length=0;await nativeTick(e,Date.now(),()=>assert.fail('No WB/Telegram with empty queue and disabled search'));
  assert.ok(!e.calls.some(sql=>sql.includes('FROM scheduler_deliveries')));
});
test('new time/order/user hot paths use indexed searches, including one product history lookup',async t=>{
  const e=environment(t);await ensureScheduler(e);const plan=(sql,...args)=>e.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail).join('\n');
  assert.match(plan("SELECT pid FROM scheduler_inventory WHERE state='ready' AND expires<?",100),/scheduler_inventory_expiry/);
  assert.match(plan('SELECT product_id FROM saved WHERE user_id=? ORDER BY created_at DESC LIMIT 1000',1),/saved_user_created/);
  assert.match(plan('SELECT product_id FROM saved WHERE user_id=? AND owned=1 LIMIT 1000',1),/saved_user_owned/);
  assert.match(plan('SELECT 1 FROM scheduler_posts WHERE pid=? AND ts>?',1,100),/COVERING INDEX sqlite_autoindex_scheduler_posts/);
  assert.match(plan('DELETE FROM scheduler_actions WHERE ts<?',100),/scheduler_actions_time/);
});
