// Genuine LOCAL Miniflare/workerd D1 metadata with synthetic fixture rows.
// No remote Cloudflare, account credentials, WB, Telegram, AI or production DB.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {openPassivePriceStore,PASSIVE_LIMITS} from './passive_store.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),WORKER='local-passive-budget-only';
const NOW=Date.parse('2026-10-18T10:00:00Z'),DAY=86400000;
const DATABASES={FRESH:'local-passive-fresh-capacity-budget',EXPIRED:'local-passive-expired-capacity-budget',GROWTH:'local-passive-daily-growth-budget',MISSING:'local-passive-missing-meter-budget'};
const requested={currency:'RUB',destination:'-1257786',spp:'30',paymentBasis:'unknown'};
const context={currency:'RUB',destination:'-1257786',paymentBasis:'unknown',authentication:'anonymous'};
const atDay=at=>new Date(at).toISOString().slice(0,10);
const totals=collection=>Object.values(collection).reduce((out,r)=>({queries:out.queries+r.queries,rows_read:out.rows_read+r.rows_read,rows_written:out.rows_written+r.rows_written}),{queries:0,rows_read:0,rows_written:0});
const event=(runId,n,at=NOW+1)=>({runId,eventId:`local-capacity-event-${String(n).padStart(5,'0')}`,at,source:'wb_card',method:'GET',acquisition:'native_details',httpStatus:200,fallback:false,requestedContext:requested,outcome:'success',offers:Array.from({length:20},(_,i)=>({id:200000+n*20+i,variantKey:String(700000+n*20+i),size:'M',price:199.95+i,currency:'RUB',available:true,priceObservedAt:at,stockObservedAt:at,verificationStatus:'api_observed',retailConfirmed:false,context,requestedContext:requested}))});
function fixtureFor(binding,id){
  const setup={},runtime={},checks={};
  async function measure(collection,label,operation,{masked=false}={}){
    const meter=observeD1(binding),DB=masked?{prepare:meter.DB.prepare,batch:async statements=>(await meter.DB.batch(statements)).map(row=>{const meta={...row.meta};delete meta.rows_written;return {...row,meta};})}:meter.DB;
    const store=openPassivePriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:id,PRICE_PASSIVE_ENABLED:'true',PRICE_DB:DB},{approvedDatabaseId:id});
    const result=await operation(store,DB);
    collection[label]={...meter.metrics,metadata_complete:meter.coverage.complete,top_queries:meter.topQueries(),...(masked?{storeMetadataIntentionallyMasked:true}:{})};
    return result;
  }
  async function counts(label){return measure(checks,label,(_,db)=>db.prepare(`SELECT
    (SELECT count(*) FROM observed_quote_history) AS history_rows,(SELECT history_rows FROM passive_stats WHERE id=1) AS history_counter,
    (SELECT count(*) FROM passive_events) AS audit_rows,(SELECT event_rows FROM passive_stats WHERE id=1) AS audit_counter,
    (SELECT count(*) FROM passive_runs) AS run_rows,(SELECT run_rows FROM passive_stats WHERE id=1) AS run_counter,
    (SELECT count(*) FROM passive_write_budget) AS budget_days`).first());}
  return {setup,runtime,checks,measure,counts};
}
async function fillHistory(fixture,{expired=false}={}){
  const offset=expired?91:0;
  return fixture.measure(fixture.setup,'seed_9000_synthetic_quote_history',(_,db)=>db.prepare(`WITH RECURSIVE
    products(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM products WHERE n<100),
    days(d) AS(SELECT 0 UNION ALL SELECT d+1 FROM days WHERE d<89)
    INSERT INTO observed_quote_history(nm_id,variant_key,requested_context,effective_context,day,observed_at,price,stock_observed_at,available)
    SELECT 900000+p.n,cast(800000+p.n AS TEXT),?,?,strftime('%Y-%m-%d',(?-(?+d.d)*86400000-3600000)/1000,'unixepoch'),
      ?-(?+d.d)*86400000-3600000,500+p.n,?-(?+d.d)*86400000-3600000,1 FROM products p CROSS JOIN days d`)
    .bind(JSON.stringify(requested),JSON.stringify(context),NOW,offset,NOW,offset,NOW,offset).run());
}
async function fillExpiredAudit(f){
  const old=NOW-8*DAY;
  await f.measure(f.setup,'seed_28_old_reviewed_runs',(_,db)=>db.prepare(`WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<27)
    INSERT INTO passive_runs(run_id,started_at,expires_at,stopped_at,status,admission_nonce)
    SELECT printf('expired-reviewed-run-%02d',i),?,?,?,'stopped','local-synthetic-fixture' FROM n`).bind(old,old+DAY,old+DAY).run());
  for(let group=0;group<7;group++){
    const runId=`expired-reviewed-run-${String(group).padStart(2,'0')}`;
    await f.measure(f.setup,'seed_old_audit_group_'+group,(_,db)=>db.batch([
      db.prepare("UPDATE passive_runs SET status='active' WHERE run_id=?").bind(runId),
      db.prepare('UPDATE passive_control SET active_run_id=? WHERE id=1').bind(runId),
      db.prepare(`WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<19)
        INSERT INTO passive_events(event_id,run_id,observed_at,captured_at,http_status,outcome,requested_context,offers,admission_nonce)
        SELECT printf('expired-event-%02d-%02d',?,i),?,?,?,200,'success',?,'[]','local-synthetic-fixture' FROM n`).bind(group,runId,old+1000,old+1000,JSON.stringify(requested)),
      db.prepare("UPDATE passive_runs SET status='stopped' WHERE run_id=?").bind(runId),
      db.prepare('UPDATE passive_control SET active_run_id=NULL WHERE id=1')
    ]));
  }
  await f.measure(f.setup,'seed_9_old_budget_days',(_,db)=>db.prepare(`WITH RECURSIVE n(i) AS(SELECT 20 UNION ALL SELECT i+1 FROM n WHERE i<28)
    INSERT INTO passive_write_budget(day) SELECT strftime('%Y-%m-%d',(?-i*86400000)/1000,'unixepoch') FROM n`).bind(NOW).run());
}
async function capacityScenario(binding,id,{expired=false}={}){
  const f=fixtureFor(binding,id),runId=expired?'passive-expired-stress-run':'passive-fresh-stress-run';
  await f.measure(f.setup,'init',s=>s.init());await fillHistory(f,{expired});if(expired)await fillExpiredAudit(f);
  const before=await f.counts('before_start');
  const started=await f.measure(f.runtime,'reviewed_start',s=>s.start({runId,now:NOW,expiresAt:NOW+DAY,reviewed:true}));
  const afterStart=await f.counts('after_start'),captures=[];
  for(let n=1;n<=20;n++){
    const result=await f.measure(f.runtime,'capture_'+String(n).padStart(2,'0'),s=>s.capture(event(runId,n,NOW+n),{now:NOW+n}));
    captures.push({captured:result.captured,status:result.status,responseCount:result.responseCount??0,meter:result.meter??null,reason:result.reason??null,budget:result.budget??null});
    if(!result.captured)break;
  }
  // Fresh object, no producer latch: the durable collector gate must be cheap.
  const terminal=await f.measure(f.runtime,'terminal_reopened_capture',s=>s.capture(event(runId,99,NOW+100),{now:NOW+100}));
  const after=await f.counts('after_captures');
  const exported=await f.measure(f.checks,'safe_export',s=>s.exportSafe({runId,now:NOW+100}));
  const status=await f.measure(f.checks,'final_status',s=>s.status({runId,now:NOW+100}));
  const captureCosts=Object.entries(f.runtime).filter(([label])=>/^capture_/.test(label)).map(([,cost])=>cost);
  const maxCaptureWrites=Math.max(0,...captureCosts.map(r=>r.rows_written)),maxCaptureReads=Math.max(0,...captureCosts.map(r=>r.rows_read));
  return {scope:expired?'FULL_HISTORY_AND_EXPIRED_AUDIT_CLEANUP':'FULL_FRESH_HISTORY_EVICTION',syntheticFixture:true,before,afterStart,after,setup:f.setup,runtime:f.runtime,checks:f.checks,runtimeTotal:totals(f.runtime),
    started:{started:started.started,status:started.status,meter:started.meter},captures,terminal:{captured:terminal.captured,status:terminal.status,responseCount:terminal.responseCount,reason:terminal.reason},
    finalStatus:status,exportedEvents:exported.events.length,exportedOffers:exported.events.reduce((n,e)=>n+e.offers.length,0),retailConfirmed:exported.retailConfirmed,
    captureCount:captures.filter(r=>r.captured).length,maxCaptureWrites,maxCaptureReads,maxCaptureQueries:Math.max(0,...captureCosts.map(r=>r.queries)),
    reservation:{capture:PASSIVE_LIMITS.captureReserve,start:PASSIVE_LIMITS.startReserve,stop:PASSIVE_LIMITS.stopReserve,startCovered:f.runtime.reviewed_start.rows_written<=PASSIVE_LIMITS.startReserve,everyCaptureCovered:maxCaptureWrites<=PASSIVE_LIMITS.captureReserve},
    cleanup:{expired,historyPrunedAtStart:before.history_rows-afterStart.history_rows,auditPrunedAtStart:before.audit_rows-afterStart.audit_rows,runsPrunedAtStart:before.run_rows+Number(started.started)-afterStart.run_rows,budgetDaysRemovedAtStart:before.budget_days+1-afterStart.budget_days},
    countersMatch:after.history_rows===after.history_counter&&after.audit_rows===after.audit_counter&&after.run_rows===after.run_counter};
}
async function dailyGrowthScenario(binding,id){
  const f=fixtureFor(binding,id);await f.measure(f.setup,'init',s=>s.init());let maxBudgetDays=0,maxRuns=0;
  const days=[];
  for(let n=0;n<32;n++){
    const at=NOW+n*DAY,runId=`daily-reviewed-run-${String(n).padStart(2,'0')}`;
    const started=await f.measure(f.runtime,`day_${n}_start`,s=>s.start({runId,now:at,expiresAt:at+DAY,reviewed:true}));
    const stopped=await f.measure(f.runtime,`day_${n}_stop`,s=>s.stop({runId,now:at+1}));
    const counts=await f.counts('day_'+n);maxBudgetDays=Math.max(maxBudgetDays,counts.budget_days);maxRuns=Math.max(maxRuns,counts.run_rows);
    days.push({day:atDay(at),started:started.started,stopped:stopped.stopped,budgetDays:counts.budget_days,runRows:counts.run_rows});
  }
  const guardAt=NOW+32*DAY,guardRun='passive-daily-budget-stop-run';
  await f.measure(f.runtime,'daily_guard_start',s=>s.start({runId:guardRun,now:guardAt,expiresAt:guardAt+DAY,reviewed:true}));
  await f.measure(f.setup,'synthetic_near_daily_quota',(_,db)=>db.prepare('UPDATE passive_write_budget SET reserved_writes=2980 WHERE day=?').bind(atDay(guardAt)).run());
  const firstBudgetStop=await f.measure(f.runtime,'daily_guard_first_transition',s=>s.capture(event(guardRun,200,guardAt+1),{now:guardAt+1}));
  const rejected=await f.measure(f.runtime,'daily_guard_reopened_rejection',s=>s.capture(event(guardRun,201,guardAt+2),{now:guardAt+2}));
  return {scope:'THIRTY_TWO_SYNTHETIC_UTC_DAYS_PLUS_DAILY_GUARD',days,maxBudgetDays,maxRuns,setup:f.setup,runtime:f.runtime,checks:f.checks,runtimeTotal:totals(f.runtime),maxQueriesPerOperation:Math.max(...Object.values(f.runtime).map(r=>r.queries)),dailyGuard:{firstStatus:firstBudgetStop.status,reopenedStatus:rejected.status,reopenedCaptured:rejected.captured,budget:firstBudgetStop.budget}};
}
async function missingMeterScenario(binding,id){
  const f=fixtureFor(binding,id);await f.measure(f.setup,'init',s=>s.init());const expiredRun='passive-short-ttl-run',runId='passive-missing-meter-run';
  await f.measure(f.runtime,'start_short_ttl',s=>s.start({runId:expiredRun,now:NOW,expiresAt:NOW+10,reviewed:true}));
  const expired=await f.measure(f.runtime,'expired_reopened_capture',s=>s.capture(event(expiredRun,1,NOW+11),{now:NOW+11}));
  await f.measure(f.runtime,'start_missing_meter',s=>s.start({runId,now:NOW+20,expiresAt:NOW+DAY,reviewed:true}));
  const captured=await f.measure(f.runtime,'capture_masked_metadata',s=>s.capture(event(runId,2,NOW+21),{now:NOW+21}),{masked:true});
  const terminal=await f.measure(f.runtime,'blocked_reopened_capture',s=>s.capture(event(runId,3,NOW+22),{now:NOW+22}));
  const status=await f.measure(f.checks,'final_status',s=>s.status({runId,now:NOW+22}));
  return {scope:'REAL_D1_WRITES_WITH_STORE_BATCH_METADATA_INTENTIONALLY_MASKED',metadataMaskSynthetic:true,actualD1MetadataAvailableToProbe:true,setup:f.setup,runtime:f.runtime,checks:f.checks,
    expired:{captured:expired.captured,status:expired.status},capture:{captured:captured.captured,status:captured.status,meter:captured.meter},terminal:{captured:terminal.captured,status:terminal.status},finalStatus:status};
}
export async function runPassiveBudgetProbe({reportPath=path.join(ROOT,'.test-temp/passive-budget-report.json')}={}){
  let externalRequests=0;
  const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:WORKER,compatibilityDate:'2026-09-01',modules:true,script:'export default {fetch(){return new Response("LOCAL_PASSIVE_BUDGET_ONLY")}}',
    d1Databases:DATABASES,outboundService:async()=>{externalRequests++;return new Response('EXTERNAL_FORBIDDEN',{status:403});}}]}));
  try{
    const freshCapacity=await capacityScenario(await mf.getD1Database('FRESH',WORKER),DATABASES.FRESH);
    const expiredCapacity=await capacityScenario(await mf.getD1Database('EXPIRED',WORKER),DATABASES.EXPIRED,{expired:true});
    const dailyGrowth=await dailyGrowthScenario(await mf.getD1Database('GROWTH',WORKER),DATABASES.GROWTH);
    const missingMetadata=await missingMeterScenario(await mf.getD1Database('MISSING',WORKER),DATABASES.MISSING);
    const rejectedGates={complete:freshCapacity.runtime.terminal_reopened_capture,expired:missingMetadata.runtime.expired_reopened_capture,unknownMetadata:missingMetadata.runtime.blocked_reopened_capture,dailyBudget:dailyGrowth.runtime.daily_guard_reopened_rejection};
    const report={version:1,scope:'LOCAL_MINIFLARE_WORKERD_D1_PASSIVE_FULL_CAPACITY',measurement:'OFFICIAL_LOCAL_D1_ROWS_METADATA',syntheticData:true,cloudflareAccountBilling:false,otherAccountUsage:null,
      productionChanged:false,productionDatabaseAccess:false,externalRequests,workersAiCalls:0,telegramSends:0,fixtureTime:new Date(NOW).toISOString(),limits:PASSIVE_LIMITS,
      sourceSha256:createHash('sha256').update(await readFile(new URL('./passive_store.mjs',import.meta.url))).digest('hex'),freshCapacity,expiredCapacity,dailyGrowth,missingMetadata,
      gateRejections:{operations:rejectedGates,total:totals(rejectedGates),allOneQueryZeroWrites:Object.values(rejectedGates).every(r=>r.queries===1&&r.rows_written===0),firstDailyStopTransition:dailyGrowth.runtime.daily_guard_first_transition,note:'One call each after complete/TTL/missing-meter/durable daily stop. The first daily stop transition writes its reserved terminal state once; subsequent isolates only read the indexed gate.'},
      note:'Setup fills synthetic tables directly and is excluded from operational budgets. rows_written/rows_read are real local workerd metadata, not production account consumption. Metadata masking only tests fail-closed behaviour.'};
    if(reportPath){await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');}
    return report;
  }finally{await mf.dispose();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  runPassiveBudgetProbe().then(r=>console.log(JSON.stringify({report:'.test-temp/passive-budget-report.json',fresh:{total:r.freshCapacity.runtimeTotal,captures:r.freshCapacity.captureCount,maxWrites:r.freshCapacity.maxCaptureWrites,reserve:r.freshCapacity.reservation},expired:{total:r.expiredCapacity.runtimeTotal,captures:r.expiredCapacity.captureCount,maxWrites:r.expiredCapacity.maxCaptureWrites,reserve:r.expiredCapacity.reservation},budgetDays:r.dailyGrowth.maxBudgetDays,externalRequests:r.externalRequests})))
    .catch(error=>{console.error('LOCAL_PASSIVE_BUDGET_FAILED',error?.message||'LOCAL_FAILURE');process.exitCode=1;});
}
