import test from 'node:test';import assert from 'node:assert/strict';
import {runPassiveStaging} from './passive_staging.mjs';
test('two isolated Workers preserve native source calls and30min policy across20synthetic observations',{timeout:120000},async()=>{
 const r=await runPassiveStaging();assert.equal(r.externalRequests,0);assert.equal(r.realTelegramPosts,0);assert.equal(r.workersAiCalls,0);assert.equal(r.productionChanged,false);
 assert.equal(r.sameSourceCounts,true);assert.equal(r.sameMainSQL,true);assert.equal(r.off.schedule30Unchanged,true);assert.equal(r.on.schedule30Unchanged,true);
 assert.equal(r.observed.responseCount,20);assert.equal(r.observed.distinctIds,20);assert.equal(r.observed.status,'complete');assert.equal(r.observed.retailConfirmed,0);
 assert.equal(r.comparisons.length,20);assert.ok(r.comparisons.every(c=>c.kopecksMatch&&c.skuMatches&&c.available&&!c.retailConfirmed));
 assert.ok(r.on.maxMainSQL<=50);assert.ok(r.maxCollectorSQL<=50);
 assert.equal(r.freeAccountUsageVerified,false);assert.equal(r.remoteLimitsEnforced,false);
 assert.ok(r.collectorD1.rows_written<3000);assert.equal(r.realProductsValidated,0);
 console.log('PASSIVE_LOCAL_STAGING',JSON.stringify({main:r.on.mainD1,collector:r.collectorD1,maxCombinedSQL:r.maxCombinedSQL,requestsOn:r.on.sourceCounts,requestsOff:r.off.sourceCounts}));
});
