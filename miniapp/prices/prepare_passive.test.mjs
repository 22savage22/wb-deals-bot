import test from 'node:test';import assert from 'node:assert/strict';
import {passiveReleasePlan} from './prepare_passive.mjs';
const options={databaseId:'e58515c1-8f40-4715-88b8-e6ecf577a6dd',stagingDatabaseId:'cff8577f-6055-4f7b-a3b3-d9c3f0c2caa2',stagingCollectorDatabaseId:'266c53da-f77a-44b2-974e-69953e76cead',runId:'price_reviewed_test_20',startedAt:1792278000000,expiresAt:1792281600000};
test('release is private, OFF, pinned to dedicated D1 and has no Cron, productionDB, realTelegram or AI binding',()=>{
 const p=passiveReleasePlan(options);assert.equal(p.approvalRequired,true);assert.equal(p.deployed,false);
 assert.equal(p.collector.workers_dev,false);assert.equal(p.collector.preview_urls,false);assert.deepEqual(p.collector.routes,[]);assert.deepEqual(p.collector.triggers.crons,[]);
 assert.equal(p.collector.vars.PRICE_CAPTURE_ENABLED,'0');assert.equal(p.collector.vars.PRICE_PASSIVE_ENABLED,'false');assert.equal(p.productionFragment.vars.PRICE_OBSERVATION_ENABLED,'0');
 assert.equal(p.staging.vars.PRICE_OBSERVATION_ENABLED,'0');assert.deepEqual(p.staging.triggers.crons,[]);assert.equal(p.staging.ai,undefined);
 assert.equal(p.staging.vars.TG_BOT_TOKEN,'123:fixture-passive-price');assert.equal(p.staging.d1_databases[0].database_id,options.stagingDatabaseId);
 assert.equal(p.staging.services[0].service,p.stagingCollector.name);assert.notEqual(p.stagingCollector.d1_databases[0].database_id,p.collector.d1_databases[0].database_id);
 assert.match(p.collectorEntry,new RegExp(options.databaseId));assert.match(p.startSQL,/reserved_writes\+240<=2980/);assert.match(p.startSQL,/NOT EXISTS/);
});
test('protected/shared/placeholder database or unbounded run cannot produce release files',()=>{
 for(const databaseId of ['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','43861c0c-aa50-4e5e-9014-7b36bd319e5b',options.stagingDatabaseId,'00000000-0000-0000-0000-000000000000'])assert.throws(()=>passiveReleasePlan({...options,databaseId}),/SEPARATE/);
 for(const patch of [{runId:'x'},{expiresAt:options.startedAt},{expiresAt:options.startedAt+86400001}])assert.throws(()=>passiveReleasePlan({...options,...patch}));
});
