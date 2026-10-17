// Genuine local workerd D1 metadata. This test never substitutes invented row
// counts or claims account billing. Requires the installed Miniflare runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runPriceBudgetProbe} from './budget_probe.mjs';
test('local Miniflare measures bounded real SQL costs and persistent source-block/history semantics',{timeout:60000},async()=>{
  const report=await runPriceBudgetProbe();
  assert.equal(report.scope,'LOCAL_MINIFLARE_D1_EMULATION');assert.equal(report.cloudflareAccountBilling,false);
  assert.equal(report.externalRequests,0);assert.equal(report.productionChanged,false);assert.equal(report.productionDatabaseAccess,false);
  for(const [label,operation] of Object.entries(report.operations)){
    assert.equal(operation.metadata_available,true,label);assert.equal(operation.metadata_complete,true,label);
    assert.ok(operation.queries>0&&operation.queries<=50,label);
    assert.ok(Number.isFinite(operation.rows_read)&&operation.rows_read>=0,label);
    assert.ok(Number.isFinite(operation.rows_written)&&operation.rows_written>=0,label);
  }
  assert.equal(report.operations.list20.rows_written,0);assert.equal(report.operations.history1.rows_written,0);
  assert.ok(report.operations.ingest20.queries<=5);assert.ok(report.operations.ingest20.rows_written>=20);
  assert.deepEqual(report.outcomes,{tracked:20,due:20,leaseAdmitted:true,confirmed:20,observationsWritten:20,currentPrices:20,historyPoints:1,
    duplicateObservationsWritten:0,staleCurrentPrices:0,blocked:true,reopenedAdmitted:false,reopenedReason:'SOURCE_BLOCKED',
    pricesAfterFailure:0,historyPointsAfterFailure:1,oldHistoryPruned:1,totalObservationRows:20});
  const full=report.capacityStress;
  assert.equal(full.outcomes.watchBefore,100);assert.equal(full.outcomes.historyBefore,9000);
  assert.equal(full.outcomes.watchAfter,100);assert.ok(full.outcomes.historyAfter<=9000);assert.equal(full.outcomes.historyCounterMatches,true);
  assert.equal(full.outcomes.logicalObservations,20);assert.equal(full.outcomes.confirmed,20);assert.equal(full.outcomes.capacityEvictions,20);
  assert.ok(full.outcomes.retentionPruned>0);assert.equal(full.outcomes.historiesRead,20);assert.ok(full.outcomes.historyPoints.every(n=>n===28));
  assert.equal(full.outcomes.currentCards,100);assert.equal(full.outcomes.currentConfirmed,100);assert.equal(full.outcomes.finishOk,true);
  assert.equal(full.outcomes.actualRefreshStatus,'ok');assert.equal(full.outcomes.actualRefreshConfirmed,100);assert.equal(full.outcomes.syntheticSourceCalls,1);
  for(const collection of [full.setup,full.cycle,full.service])for(const [label,operation] of Object.entries(collection)){
    assert.equal(operation.metadata_available,true,label);assert.equal(operation.metadata_complete,true,label);
    assert.ok(operation.queries<=50,label);
  }
  assert.equal(full.queryBudget.withinLimit,true);assert.ok(full.queryBudget.actualPreviewQueries<=21);
  assert.equal(full.daily.within80PercentGuard,true);assert.equal(full.daily.otherAccountUsage,null);
  assert.equal(full.daily.cloudflareAccountBilling,false);assert.equal(full.daily.cycles,40);
  console.log('LOCAL_D1_PRICE_COSTS',JSON.stringify(Object.fromEntries(Object.entries(report.operations).map(([label,o])=>[label,{queries:o.queries,rows_read:o.rows_read,rows_written:o.rows_written}]))));
  console.log('LOCAL_D1_FULL_CAPACITY',JSON.stringify({before:full.before,after:full.after,total:full.cycleTotal,service:full.service,queryBudget:full.queryBudget,daily:full.daily}));
});
