import test from 'node:test';
import assert from 'node:assert/strict';
import {adminEnvironment,adminRequest,rawPolicy,discoveryFixture} from './admin_test_support.mjs';
import {ensureControl,recordDiscovery} from './admin_history.mjs';
import {discoveryQueries} from './query_control.mjs';
import {runDiscovery,readHeader} from './native_scheduler.mjs';

test('imported query IDs from another copy reuse matching local identity and do not shadow it with an archive',async t=>{
  const e=await adminEnvironment(t),old=await(await adminRequest(e,'/api/admin/search')).json();
  const imported=old.queries.map(r=>({...r,id:'foreign:'+r.id,priority:4}));const response=await adminRequest(e,'/api/admin/search/queries','PUT',{revision:old.revision,queries:imported});assert.equal(response.status,200);
  const saved=await(await adminRequest(e,'/api/admin/search')).json();assert.equal(saved.queries.length,3);assert.deepEqual(saved.queries.map(r=>r.id),old.queries.map(r=>r.id));assert.ok(saved.queries.every(r=>r.priority===4));
});

test('query editor reads actual D1 without config/schema writes and rejects non-owner before D1',async t=>{
  const e=await adminEnvironment(t),before=rawPolicy(e),schedule=e.db.prepare('SELECT data FROM scheduler_config').get().data;
  for(const id of [null,22]){const c=e.calls;assert.equal((await adminRequest(e,'/api/admin/search','GET',null,id)).status,id?403:401);assert.equal(e.calls,c);}
  const r=await adminRequest(e,'/api/admin/search');assert.equal(r.status,200);const data=await r.json();
  assert.equal(data.queries.length,3);assert.equal(data.queries[2].enabled,false);assert.equal(data.queries[0].origin,'existing');assert.equal(data.queries[0].stats,null);
  assert.equal(e.db.prepare("SELECT name FROM sqlite_master WHERE name='admin_changes'").get(),undefined);
  assert.equal(rawPolicy(e),before);assert.equal(e.db.prepare('SELECT data FROM scheduler_config').get().data,schedule);
  assert.doesNotMatch(JSON.stringify(data),/chat_id|1234567|TG_BOT|token/i);
});
test('query save validates, preserves production policy fields, detects conflicts and restores with a new audit entry',async t=>{
  const e=await adminEnvironment(t),data=await(await adminRequest(e,'/api/admin/search')).json(),original=JSON.parse(rawPolicy(e));
  const bad=structuredClone(data.queries);bad[0].priority=6;
  assert.equal((await adminRequest(e,'/api/admin/search/queries','PUT',{revision:data.revision,queries:bad})).status,400);
  assert.deepEqual(JSON.parse(rawPolicy(e)),original);
  const rows=structuredClone(data.queries);rows[0].priority=4;rows[1].archived=true;rows[2].enabled=true;
  rows.push({text:'платье летнее',priority:2,enabled:true,archived:false,origin:'algorithm'});
  const saved=await adminRequest(e,'/api/admin/search/queries','PUT',{revision:data.revision,queries:rows});assert.equal(saved.status,200);
  const value=await saved.json(),policy=JSON.parse(rawPolicy(e));assert.equal(policy.chat_id,original.chat_id);assert.equal(policy.max_price,original.max_price);assert.equal(policy.total_posts,42);
  assert.deepEqual(policy.queries,['худи мужское','сумка','платье летнее']);assert.equal(value.queries.at(-1).origin,'manual');
  assert.equal((await adminRequest(e,'/api/admin/search/queries','PUT',{revision:data.revision,queries:rows})).status,409);
  const history=await(await adminRequest(e,'/api/admin/config/history')).json();assert.equal(history.items.length,1);
  assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:history.items[0].id,revision:value.revision})).status,200);
  const restored=JSON.parse(rawPolicy(e));assert.deepEqual(restored.queries,original.queries);assert.deepEqual(restored.disabled_topics,original.disabled_topics);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM admin_changes').get().n,2);
  assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
});
test('specific manual query test shares lock/backoff and never queues or posts a product',async t=>{
  const e=await adminEnvironment(t);await ensureControl(e);
  e.db.prepare('INSERT INTO products(id,data,checked_at) VALUES(777,?,?)').run(JSON.stringify({id:777,image:'https://basket-01.wbbasket.ru/a.webp'}),Math.floor(Date.now()/1000));
  const data=await(await adminRequest(e,'/api/admin/search')).json(),body={query_id:data.queries[2].id,request_id:'test-disabled-saved-query'};
  assert.equal((await adminRequest(e,'/api/admin/search/test','POST',body)).status,202);
  assert.equal((await(await adminRequest(e,'/api/admin/search/test','POST',body)).json()).duplicate,true);
  const calls=[],results=await Promise.all([runDiscovery(e,await readHeader(e),discoveryFixture(calls)),runDiscovery(e,await readHeader(e),discoveryFixture(calls))]);
  assert.ok(results.some(r=>r.result==='success'));assert.ok(results.some(r=>r.result==='lock_busy'));
  const searches=calls.filter(u=>u.hostname==='search.wb.ru');assert.equal(searches.length,1);assert.equal(searches[0].searchParams.get('query'),'сумка');
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_inventory').get().n,0);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_posts').get().n,0);
  const history=await(await adminRequest(e,'/api/admin/search/history')).json();assert.equal(history.items[0].receipt.test,true);assert.equal(history.items[0].receipt.added,0);assert.equal(history.items[0].receipt.new_found,0);assert.equal(history.items[0].receipt.products.length,1);
  assert.equal((await adminRequest(e,'/api/admin/search/test','POST',{...body,request_id:'another'})).status,429);
  assert.equal(e.db.prepare("SELECT COUNT(*) n FROM scheduler_leases WHERE kind='search'").get().n,0);
});
test('archiving a pending tested query cancels that request without searching another phrase',async t=>{
  const e=await adminEnvironment(t),data=await(await adminRequest(e,'/api/admin/search')).json();
  await adminRequest(e,'/api/admin/search/test','POST',{query_id:data.queries[0].id,request_id:'archive-race'});
  await adminRequest(e,'/api/admin/search/queries','PUT',{revision:data.revision,queries:data.queries.map(r=>({...r,archived:true,enabled:false}))});
  let calls=0;const r=await runDiscovery(e,await readHeader(e),async()=>{calls++;throw Error('must not fetch');});
  assert.equal(r.result,'query_changed_or_archived');assert.equal(calls,0);assert.equal(e.db.prepare('SELECT search_request FROM scheduler_config').get().search_request,null);
});
test('WB quota rejection creates honest missing metrics and one bounded cooldown, no fallback burst',async t=>{
  const e=await adminEnvironment(t);await ensureControl(e);let calls=0;
  const result=await runDiscovery(e,await readHeader(e),async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'900'}});});
  assert.equal(result.result,'error');assert.equal(calls,1);assert.ok(result.search_backoff_seconds>=900);
  const data=await(await adminRequest(e,'/api/admin/search')).json(),r=data.queries.find(r=>r.stats);
  assert.equal(r.stats.found,null);assert.equal(r.stats.last_error,'WB HTTP 429');assert.equal(r.stats.successful,0);
});
test('priority weighting is bounded and query history is limited without inventing old statistics',async t=>{
  const e=await adminEnvironment(t);await ensureControl(e);
  assert.deepEqual(discoveryQueries({queries:['a','b'],query_settings:[{id:'a',text:'a',priority:3},{id:'b',text:'b',priority:1}]}),['a','a','a','b']);
  for(let i=0;i<505;i++)await recordDiscovery(e,{query:'худи мужское',at:i,origin:'cron',found:100,new_found:3,valid:1,added:1,products:[]});
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM admin_search_runs').get().n,500);
  const page=await(await adminRequest(e,'/api/admin/search/history')).json();assert.equal(page.items.length,20);assert.ok(page.next_cursor);
  const next=await(await adminRequest(e,'/api/admin/search/history?cursor='+page.next_cursor)).json();assert.equal(next.items.length,20);assert.ok(next.items[0].id<page.items.at(-1).id);
});
