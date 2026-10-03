import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {observeD1,d1QuotaFailure} from './d1_budget.mjs';
import {ensureScheduler,SCHEDULER_INDEXES} from './scheduler_api.mjs';
import worker from './worker.mjs';

function env(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());const calls=[];
  const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){calls.push(sql);return db.prepare(sql).get(...args)??null;},async all(){calls.push(sql);return {results:db.prepare(sql).all(...args)};},async run(){calls.push(sql);return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});
  return {db,calls,DB:{prepare:wrap,async batch(statements){const result=[];for(const s of statements)result.push(await s.run());return result;}}};
}
test('indexes are additive, survive cold restart, and do not reset settings/history',async t=>{
  const e=env(t);await ensureScheduler(e);
  e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.post_interval_minutes',30),post_request='owner-action'").run();
  e.db.prepare("INSERT INTO scheduler_deliveries VALUES(1,100,321,'dress','dress','{}')").run();
  e.calls.length=0;await ensureScheduler({...e,DB:{...e.DB}});
  assert.deepEqual(e.calls,['SELECT status FROM scheduler_config WHERE id=1']);
  const config=e.db.prepare('SELECT * FROM scheduler_config').get();
  assert.equal(JSON.parse(config.data).post_interval_minutes,30);assert.equal(config.post_request,'owner-action');
  assert.equal(e.db.prepare('SELECT message_id FROM scheduler_deliveries').get().message_id,321);
  assert.equal(e.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name IN ("+SCHEDULER_INDEXES.map(()=>'?').join(',')+")").get(...SCHEDULER_INDEXES.map(sql=>sql.split(' ')[5])).n,SCHEDULER_INDEXES.length);
});
test('history/topic/duplicate hot paths use indexes instead of repeated full-table scans',async t=>{
  const e=env(t);await ensureScheduler(e);
  const plan=(sql,...args)=>e.db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(r=>r.detail).join('\n');
  assert.match(plan('SELECT COUNT(*) FROM scheduler_deliveries WHERE topic=? AND ts>?','dress',100),/scheduler_deliveries_topic_time/);
  assert.match(plan('SELECT * FROM scheduler_deliveries WHERE ts>? ORDER BY ts',100),/scheduler_deliveries_time/);
  assert.match(plan('SELECT 1 FROM scheduler_inventory WHERE title_key=?','dress'),/scheduler_inventory_title/);
  assert.match(plan('SELECT COUNT(*) FROM scheduler_claims WHERE ts>?',100),/scheduler_claims_time/);
  assert.match(plan("SELECT 1 FROM scheduler_claims WHERE status IN ('pending','error') AND ts>?",100),/scheduler_claims_status_time/);
  const query=`UPDATE scheduler_inventory SET state='cooldown',retry_at=COALESCE((SELECT MIN(ts)+86401 FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?),?) WHERE state='ready' AND topic IN (SELECT topic FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic HAVING COUNT(*)>=8)`;
  const details=plan(query,100,1000,100);assert.match(details,/scheduler_deliveries_topic_time/);assert.match(details,/scheduler_deliveries_time/);assert.doesNotMatch(details,/SCAN d\b/);
});
test('existing database upgrades once without changing legacy schedule revision',async t=>{
  const e=env(t);await ensureScheduler(e);const before=e.db.prepare('SELECT revision,data FROM scheduler_config').get();
  e.db.prepare("UPDATE scheduler_config SET status=json_remove(status,'$.schema_version')").run();
  await ensureScheduler({...e,DB:{...e.DB}});
  const after=e.db.prepare('SELECT revision,data,status FROM scheduler_config').get();
  assert.equal(after.revision,before.revision);assert.equal(after.data,before.data);assert.equal(JSON.parse(after.status).schema_version,2);
});
test('real result metadata is counted without logging SQL, rows or credentials',async()=>{
  const original={bind(){return this;},async all(){return {results:[{value:7}],meta:{rows_read:4,rows_written:0}};},async run(){return {meta:{rows_read:2,rows_written:1}};}};
  const meter=observeD1({prepare(){return original;},async batch(statements){return Promise.all(statements.map(s=>s.run()));}});
  assert.equal(await meter.DB.prepare('private SQL').bind('secret').first('value'),7);
  await meter.DB.batch([meter.DB.prepare('private SQL').bind('secret')]);
  assert.deepEqual(meter.metrics,{queries:2,rows_read:6,rows_written:1,metadata_available:true});
});
test('quota failure is not an empty database and does not retry schema writes',async()=>{
  let queries=0;const e={DB:{prepare(){return {bind(){return this;},async first(){queries++;throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};},async batch(){throw new Error('DDL must not run');}}};
  await assert.rejects(ensureScheduler(e),/daily row read limit/);assert.equal(queries,1);
});
test('quota API response is actionable, secret-free, and specifies midnight UTC',async()=>{
  const error=new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. private data");
  const failure=d1QuotaFailure(error,Date.parse('2026-10-03T15:00:00Z'));
  assert.equal(failure.retry_at,Date.parse('2026-10-04T00:00:00Z')/1000);
  assert.equal(d1QuotaFailure(new Error('secret database failure')),null);
  const e={MINIAPP_SYNC_KEY:'s'.repeat(40),DB:{prepare(){return {bind(){return this;},async first(){throw error;}};}}};
  const response=await worker.fetch(new Request('https://test.example/api/scheduler/config',{headers:{Authorization:'Bearer '+e.MINIAPP_SYNC_KEY}}),e);
  assert.equal(response.status,503);assert.ok(Number(response.headers.get('Retry-After'))>0);
  const data=await response.json();assert.equal(data.code,'D1_DAILY_QUOTA_EXCEEDED');assert.equal(JSON.stringify(data).includes('private'),false);
});
test('quota keeps Cron visibly failed and never attempts WB or Telegram without D1 safety',async()=>{
  const e={SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare(){return {bind(){return this;},async all(){throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit.");}};}}};
  await assert.rejects(worker.scheduled({scheduledTime:Date.now()},e),/D1_DAILY_QUOTA_EXCEEDED/);
});
