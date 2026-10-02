import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {dueJobs,scheduledTick} from './cron_driver.mjs';
import {DEFAULT_SCHEDULE,ensureScheduler} from './scheduler_api.mjs';
const now=Date.parse('2026-10-02T09:00:00Z')/1000;
const row=(schedule={},status={},extra={})=>({data:JSON.stringify({...DEFAULT_SCHEDULE,...schedule}),status:JSON.stringify({queue_size:10,...status}),revision:1,...extra});
function environment(){
  const db=new DatabaseSync(':memory:');
  const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});
  return {db,SCHEDULER_DRIVER:'cloudflare',GITHUB_DISPATCH_TOKEN:'fixture-only',DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
}
test('posting pause/quiet/disabled weekdays do not disable independent search',()=>{
  assert.deepEqual(dueJobs(row({paused:true}),now),['search']);
  assert.deepEqual(dueJobs(row({quiet_enabled:true,quiet_start:'11:00',quiet_end:'13:00'}),now),['search']);
  assert.deepEqual(dueJobs(row({weekdays:[0]}),now),['search']);
  assert.deepEqual(dueJobs(row({enabled:false}),now),['search']);
});
test('interval, quiet overnight, caps, next slot and manual requests',()=>{
  assert.deepEqual(dueJobs(row({}, {last_post:now-601}),now),['search','post']);
  assert.deepEqual(dueJobs(row({}, {last_post:now-599}),now),['search']);
  assert.deepEqual(dueJobs(row({}, {revision:1,next_post:now+60}),now),['search']);
  assert.deepEqual(dueJobs(row({}, {heartbeat:now,posts_hour:12}),now),['search']);
  assert.deepEqual(dueJobs(row({}, {queue_size:0}),now),['search']);
  assert.deepEqual(dueJobs(row({paused:true,search_enabled:false},{},{post_request:'manual'}),now),['post']);
  assert.deepEqual(dueJobs(row({quiet_enabled:true}),Date.parse('2026-10-02T21:00:00Z')/1000),['search']);
  assert.deepEqual(dueJobs(row({mode:'times',post_times:['12:00']}),now),['search','post']);
  assert.deepEqual(dueJobs(row({mode:'times',post_times:['12:01']}),now),['search']);
});
test('search reserve accelerates safely, and active jobs block dispatch',()=>{
  assert.deepEqual(dueJobs(row({paused:true},{queue_size:100,last_scan_attempt:now-301}),now),[]);
  assert.deepEqual(dueJobs(row({paused:true},{queue_size:99,last_scan_attempt:now-301}),now),['search']);
  assert.deepEqual(dueJobs(row({},{scan_running:true,post_running:true}),now),[]);
});
test('driver is opt-in, no deployment token required, and missing secret fails closed',async()=>{
  assert.deepEqual(await scheduledTick({},now*1000),{enabled:false});
  const env=environment();delete env.GITHUB_DISPATCH_TOKEN;
  assert.equal((await scheduledTick(env,now*1000)).error,'missing_dispatch_secret');
  assert.match(env.db.prepare('SELECT status FROM scheduler_config').get().status,/clock_heartbeat/);env.db.close();
});
test('queued workflow is never duplicated; repeat cron is stopped by atomic cooldown',async()=>{
  const env=environment();await ensureScheduler(env);
  env.db.prepare('UPDATE scheduler_config SET data=?,status=?').run(row({paused:true}).data,'{}');
  let calls=0;const fetcher=async()=>{calls++;return Response.json({workflow_runs:[{status:'queued'}]});};
  assert.equal((await scheduledTick(env,now*1000,fetcher)).results.search,'already_running');
  assert.equal((await scheduledTick(env,(now+60)*1000,fetcher)).results.search,'cooldown');
  assert.equal(calls,1);env.db.close();
});
test('dispatch accepted once; ambiguous send and 403 do not immediately retry',async()=>{
  for(const status of [204,403,'network']){
    const env=environment();await ensureScheduler(env);env.db.prepare('UPDATE scheduler_config SET data=?').run(row({paused:true}).data);
    const calls=[];const fetcher=async(url,options)=>{calls.push({url,method:options.method});if(options.method==='GET')return Response.json({workflow_runs:[]});if(status==='network')throw new Error('fixture token must not leak');return new Response(null,{status});};
    const first=await scheduledTick(env,now*1000,fetcher);
    assert.equal(first.results.search,status===204?'accepted':'error');
    assert.equal((await scheduledTick(env,(now+60)*1000,fetcher)).results.search,'cooldown');
    assert.equal(calls.length,2);assert.equal(calls[1].method,'POST');
    assert.equal(env.db.prepare('SELECT status FROM scheduler_config').get().status.includes('fixture token'),false);
    if(status===403)assert.equal(env.db.prepare("SELECT expires FROM scheduler_leases WHERE kind='clock_search'").get().expires,now+21600);
    env.db.close();
  }
});
test('fresh search runtime is authoritative while paused; old running flags cannot freeze clock',async()=>{
  const env=environment();await ensureScheduler(env);
  env.db.prepare('UPDATE scheduler_config SET data=?,status=?').run(row({paused:true}).data,JSON.stringify({scan_running:true,last_scan_attempt:now-7200}));
  env.db.prepare('UPDATE scheduler_runtime SET data=?').run(JSON.stringify({last_scan_attempt:now,queue_size:100}));
  const fetcher=()=>{throw new Error('must not dispatch');};
  assert.deepEqual((await scheduledTick(env,now*1000,fetcher)).results,{});
  env.db.close();
});
test('deployment config reuses production DB, publishes only assets and preserves vars',()=>{
  const config=JSON.parse(readFileSync(new URL('../../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.name,'wb-finds-miniapp');assert.equal(config.keep_vars,true);
  assert.equal(config.d1_databases[0].database_id,'d73d252d-3948-425b-b7c3-b65d0f5c6e5f');
  assert.deepEqual(config.triggers.crons,['* * * * *']);assert.equal(config.assets.directory,'miniapp/public');
  assert.equal(config.vars,undefined);
});
