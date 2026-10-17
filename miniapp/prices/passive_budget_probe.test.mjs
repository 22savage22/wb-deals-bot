// Local workerd stress with actual official D1 metadata; no live sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runPassiveBudgetProbe} from './passive_budget_probe.mjs';
test('passive full9000 history/20offer stress measures reservations, cleanup and durable cheap rejection',{timeout:120000},async()=>{
  const r=await runPassiveBudgetProbe();
  assert.equal(r.syntheticData,true);assert.equal(r.cloudflareAccountBilling,false);assert.equal(r.externalRequests,0);assert.equal(r.productionDatabaseAccess,false);assert.equal(r.productionChanged,false);assert.equal(r.workersAiCalls,0);assert.equal(r.telegramSends,0);
  for(const scenario of [r.freshCapacity,r.expiredCapacity]){
    assert.equal(scenario.before.history_rows,9000);assert.equal(scenario.started.started,true);assert.equal(scenario.countersMatch,true);assert.ok(scenario.after.history_rows<=9000);assert.ok(scenario.after.audit_rows<=140);assert.ok(scenario.after.run_rows<=28);
    assert.ok(scenario.captureCount>0&&scenario.captureCount<=20);assert.equal(scenario.exportedEvents,scenario.captureCount);assert.equal(scenario.exportedOffers,scenario.captureCount*20);assert.equal(scenario.retailConfirmed,0);
    assert.equal(scenario.reservation.startCovered,true);assert.equal(scenario.reservation.everyCaptureCovered,true);assert.ok(scenario.maxCaptureQueries<=50);assert.ok(scenario.runtimeTotal.rows_written<=3000);
    assert.ok(scenario.finalStatus.budget.reservedWrites<=3000);assert.equal(scenario.terminal.captured,false);assert.ok(['complete','budget_exceeded'].includes(scenario.terminal.status));
    assert.equal(scenario.runtime.terminal_reopened_capture.queries,1);assert.equal(scenario.runtime.terminal_reopened_capture.rows_written,0);
    for(const collection of [scenario.setup,scenario.runtime,scenario.checks])for(const [label,cost] of Object.entries(collection)){
      assert.equal(cost.metadata_available,true,label);assert.equal(cost.metadata_complete,true,label);assert.ok(cost.queries<=50,label);assert.ok(Number.isFinite(cost.rows_written)&&cost.rows_written>=0,label);
    }
  }
  assert.equal(r.expiredCapacity.before.audit_rows,140);assert.equal(r.expiredCapacity.before.run_rows,28);assert.equal(r.expiredCapacity.cleanup.historyPrunedAtStart,20);assert.equal(r.expiredCapacity.cleanup.auditPrunedAtStart,20);assert.equal(r.expiredCapacity.cleanup.runsPrunedAtStart,4);assert.equal(r.expiredCapacity.cleanup.budgetDaysRemovedAtStart,2);
  assert.ok(r.dailyGrowth.days.every(d=>d.started&&d.stopped));assert.ok(r.dailyGrowth.maxBudgetDays<=9);assert.ok(r.dailyGrowth.maxRuns<=9);assert.ok(r.dailyGrowth.maxQueriesPerOperation<=50);
  assert.equal(r.dailyGrowth.dailyGuard.firstStatus,'budget_exceeded');assert.equal(r.dailyGrowth.dailyGuard.reopenedStatus,'budget_exceeded');assert.equal(r.dailyGrowth.dailyGuard.reopenedCaptured,false);
  assert.equal(r.gateRejections.allOneQueryZeroWrites,true);assert.equal(r.gateRejections.total.queries,4);assert.equal(r.gateRejections.total.rows_written,0);assert.ok(r.gateRejections.total.rows_read>0);
  assert.equal(r.missingMetadata.expired.status,'expired');assert.equal(r.missingMetadata.runtime.expired_reopened_capture.queries,1);assert.equal(r.missingMetadata.runtime.expired_reopened_capture.rows_written,0);
  assert.equal(r.missingMetadata.capture.status,'meter_unknown');assert.equal(r.missingMetadata.capture.meter.reason,'WRITE_METER_UNKNOWN');assert.equal(r.missingMetadata.terminal.captured,false);assert.equal(r.missingMetadata.terminal.status,'meter_unknown');assert.equal(r.missingMetadata.runtime.blocked_reopened_capture.queries,1);assert.equal(r.missingMetadata.runtime.blocked_reopened_capture.rows_written,0);
  assert.equal(r.missingMetadata.finalStatus.budget.meter,'unknown');assert.ok(r.missingMetadata.finalStatus.budget.reservedWrites>=240);
  console.log('LOCAL_PASSIVE_STRESS',JSON.stringify({fresh:{captures:r.freshCapacity.captureCount,total:r.freshCapacity.runtimeTotal,maxQueries:r.freshCapacity.maxCaptureQueries,maxCaptureWrites:r.freshCapacity.maxCaptureWrites,reservation:r.freshCapacity.reservation},expired:{captures:r.expiredCapacity.captureCount,total:r.expiredCapacity.runtimeTotal,maxCaptureWrites:r.expiredCapacity.maxCaptureWrites,start:r.expiredCapacity.runtime.reviewed_start,cleanup:r.expiredCapacity.cleanup},dailyBudgetDays:r.dailyGrowth.maxBudgetDays,missingMeter:r.missingMetadata.capture.status,gateRejections:r.gateRejections}));
});
