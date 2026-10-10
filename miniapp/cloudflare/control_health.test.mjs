import test from 'node:test';import assert from 'node:assert/strict';
import {adminEnvironment,adminRequest,rawPolicy} from './admin_test_support.mjs';
import {ensureLearning,recordEvent} from './learning.mjs';import {ensureControl,recordDiscovery} from './admin_history.mjs';import {healthHistory,visionHealth} from './control_health.mjs';
test('home and diagnostic unknowns remain unknown; bounded search history links a real recovery',async t=>{
  const e=await adminEnvironment(t),before=rawPolicy(e),overview=await(await adminRequest(e,'/api/admin/overview')).json();assert.equal(overview.summary.new_today,null);assert.equal(overview.summary.audience,null);assert.equal(overview.summary.learning,null);assert.equal(rawPolicy(e),before);
  let d=await(await adminRequest(e,'/api/admin/diagnostics')).json();assert.equal(d.wb_source,null);assert.equal(d.telegram,null);assert.equal(d.workers_ai.account_neurons,null);assert.equal(d.history.available,false);
  await ensureControl(e);const now=Math.floor(Date.now()/1000);await recordDiscovery(e,{at:now-100,query:'худи',error:'WB HTTP 429'});await recordDiscovery(e,{at:now,query:'худи',found:10,new_found:2,valid:1,added:1});
  const h=await healthHistory(e);assert.equal(h.events[0].type,'recovered');assert.equal(h.events[0].after_error_at,now-100);assert.equal(h.events[1].type,'error');assert.equal((await visionHealth(e)).enabled,false);
  const r=await(await adminRequest(e,'/api/admin/overview')).json();assert.equal(r.summary.new_today,1);
});
test('learning configuration has CAS, audit, safe restore and SHADOW-only admin writes',async t=>{
  const e=await adminEnvironment(t);await ensureLearning(e);const old=await(await adminRequest(e,'/api/admin/learning')).json();
  assert.equal((await adminRequest(e,'/api/admin/learning','PUT',{mode:'LEGACY',exploration_percent:10,revision:old.revision})).status,409);
  assert.equal((await adminRequest(e,'/api/admin/learning','PUT',{mode:'SHADOW',exploration_percent:15,revision:old.revision})).status,200);
  assert.equal((await adminRequest(e,'/api/admin/learning','PUT',{mode:'SHADOW',exploration_percent:20,revision:old.revision})).status,409);
  const current=await(await adminRequest(e,'/api/admin/learning')).json(),history=await(await adminRequest(e,'/api/admin/config/history')).json();assert.equal(history.items[0].scope,'learning');
  assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:history.items[0].id,revision:current.revision})).status,200);const restored=await(await adminRequest(e,'/api/admin/learning')).json();assert.deepEqual(restored.config,old.config);
});
test('a large signal weight is not ten independent observed events',async t=>{
  const e=await adminEnvironment(t);await ensureLearning(e);await adminRequest(e,'/api/admin/learning');
  e.db.prepare('INSERT INTO products(id,data,checked_at) VALUES(123,?,0)').run(JSON.stringify({id:123,title:'Fixture',category:'Худи',product:500}));
  await recordEvent(e,{key:'one-bulk-event',pid:123,kind:'like',weight:100});const v=await(await adminRequest(e,'/api/admin/learning')).json();assert.equal(v.insights.length,0);assert.equal(v.config.mode,'SHADOW');
});
test('native health transitions are bounded and contain allowlisted codes, never upstream error text',async t=>{
  const e=await adminEnvironment(t);await ensureControl(e);
  e.db.prepare('UPDATE scheduler_config SET status=?').run(JSON.stringify({last_error:'do-not-copy-raw',last_error_code:'TELEGRAM_UNKNOWN',watchdog_overdue:true}));
  e.db.prepare("UPDATE scheduler_config SET status='{}'").run();const history=await healthHistory(e);assert.equal(history.events.length,4);assert.doesNotMatch(JSON.stringify(history),/do-not-copy-raw/);assert.equal(history.events.filter(x=>x.type==='recovered').length,2);
  const stmt=e.db.prepare("INSERT INTO admin_health_events(ts,service,state,code) VALUES(1,'cron','error','POST_OVERDUE')");for(let i=0;i<210;i++)stmt.run();assert.equal(e.db.prepare('SELECT COUNT(*) n FROM admin_health_events').get().n,200);
});
