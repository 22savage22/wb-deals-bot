// Actual rows_read/rows_written from installed local Miniflare/workerd D1.
// This is LOCAL EMULATION with synthetic prices, NOT Cloudflare account billing,
// live price/source verification or a production deployment.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {openPriceStore,PRICE_LIMITS} from './store.mjs';
import {priceContextKey} from '../shadow/value.mjs';
import {pricePreview,refreshWatched} from './service.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const DATABASE='local-isolated-price-budget-emulation',WORKER='isolated-price-budget';
const FULL_DATABASE='local-isolated-price-budget-full-capacity';
const NOW=Date.parse('2026-10-18T10:00:00Z');
function products(count=20){
  const context={currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'};
  return Array.from({length:count},(_,i)=>({id:900000+i,source:'wb-card',name:'Локальная синтетическая футболка '+i,
    category:'Футболки',categoryVerified:true,type:'tshirt',priceBasis:'piece',packCount:1,
    price:199.95+i,oldPrice:999.95+i,currency:'RUB',available:true,variantKey:String(700000+i),
    priceSource:'wb_card',priceCondition:'standard',priceContextConfirmed:true,context:{...context},observedAt:NOW,stockObservedAt:NOW,
    rating:4.8,reviews:100,qualityVerified:true,qualitySource:'wb_card',qualityObservedAt:NOW,
    variants:[{variantKey:String(700000+i),size:'42',price:199.95+i,available:true,condition:'standard',currency:'RUB',context:{...context}}]}));
}
const sumCosts=operations=>Object.values(operations).reduce((out,step)=>({queries:out.queries+step.queries,rows_read:out.rows_read+step.rows_read,rows_written:out.rows_written+step.rows_written}),{queries:0,rows_read:0,rows_written:0});
async function capacityProbe(binding){
  const setup={},cycle={},service={};
  const measure=async(collection,label,operation)=>{
    const meter=observeD1(binding),store=openPriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:FULL_DATABASE,PRICE_DB:meter.DB},{approvedDatabaseId:FULL_DATABASE});
    const result=await operation(store,meter.DB);
    collection[label]={...meter.metrics,metadata_complete:meter.coverage.complete,top_queries:meter.topQueries()};return result;
  };
  const rows=products(100),rowIds=rows.map(p=>p.id);
  await measure(setup,'init',store=>store.init());
  await measure(setup,'track100',store=>store.track(rows,{now:NOW-1000}));
  // Explicit synthetic bulk fixture: exactly 100 products x 90 distinct days,
  // same SKU/context. No network, price provider, private SQL or production DB.
  await measure(setup,'bulk_history9000',(_,db)=>db.prepare(`WITH RECURSIVE days(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM days WHERE n<90)
    INSERT INTO price_observations(pid,variant,context,day,observed_at,price,source)
    SELECT json_extract(p.value,'$.id'),json_extract(p.value,'$.variantKey'),?,strftime('%Y-%m-%d',(?-d.n*86400000-1000)/1000,'unixepoch'),
      ?-d.n*86400000-1000,json_extract(p.value,'$.price')+30+d.n,'wb_card' FROM json_each(?) p CROSS JOIN days d`)
    .bind(priceContextKey(rows[0].context),NOW,NOW,JSON.stringify(rows.map(p=>({id:p.id,variantKey:p.variantKey,price:p.price})))).run());
  // Make every current product fresh so the REAL service preview must obey its
  // 20-history cap with all 100 cards confirmed; historical rows alone cannot
  // establish that runtime worst case. This is explicitly fixture setup.
  const latest=rows.map(p=>({...p,observedAt:NOW-1000,stockObservedAt:NOW-1000}));
  await measure(setup,'set100_current_fixture',(_,db)=>db.prepare(`UPDATE price_watch SET latest=p.value,last_good=p.value,current_valid=1,current_code='CONFIRMED',
    latest_observed_at=?,last_good_observed_at=?,checked_at=?,due_at=?,invalidated_at=0 FROM json_each(?) p WHERE price_watch.pid=json_extract(p.value,'$.id')`)
    .bind(NOW-1000,NOW-1000,NOW-1000,NOW,JSON.stringify(latest)).run());
  const before=await measure(setup,'capacity_before',(_,db)=>db.prepare(`SELECT (SELECT count(*) FROM price_watch WHERE active=1) AS watch,
    (SELECT count(*) FROM price_observations) AS history,(SELECT history_rows FROM price_store_stats WHERE id=1) AS history_counter`).first());
  const due=await measure(cycle,'due20',store=>store.due({now:NOW,limit:20}));
  const lease=await measure(cycle,'acquire',store=>store.acquire('wb-card',{now:NOW}));
  const batch=due.map(row=>rows.find(p=>p.id===row.id));
  const ingested=await measure(cycle,'ingest20_at_capacity',store=>store.ingest(batch,{now:NOW}));
  const current=await measure(cycle,'list100',store=>store.list({now:NOW,limit:100}));
  const points=[];
  for(const product of batch)points.push(await measure(cycle,'history_'+product.id,store=>store.history(product,{now:NOW})));
  const finished=await measure(cycle,'finish200',store=>store.finish('wb-card',lease.owner,{now:NOW+10,status:200,ok:true}));
  const after=await measure(setup,'capacity_after',(_,db)=>db.prepare(`SELECT (SELECT count(*) FROM price_watch WHERE active=1) AS watch,
    (SELECT count(*) FROM price_observations) AS history,(SELECT history_rows FROM price_store_stats WHERE id=1) AS history_counter`).first());
  // Measure the ACTUAL current service after the fix for its former all100
  // history reads. No test-only replacement for service orchestration is used.
  const preview=await measure(service,'actual_preview100_history20',store=>pricePreview(store,{now:NOW+20,historyIds:batch.map(p=>p.id)}));
  let syntheticSourceCalls=0;
  const later=NOW+PRICE_LIMITS.minGapMs+20;
  const syntheticSource={name:'wb-card',readOnly:true,async details(ids){syntheticSourceCalls++;return {products:rows.filter(p=>ids.includes(p.id)).map(p=>({...p,observedAt:later,stockObservedAt:later,qualityObservedAt:later}))};}};
  const refreshed=await measure(service,'actual_refreshWatched100',store=>refreshWatched({store,source:syntheticSource,enabled:true,now:()=>later}));
  const total=sumCosts(cycle),actual=service.actual_refreshWatched100;
  const perCycle={rows_read:Math.max(total.rows_read,actual.rows_read),rows_written:Math.max(total.rows_written,actual.rows_written)};
  const daily={cycles:40,upstreamRequestsPerCycle:1,reads:perCycle.rows_read*40,writes:perCycle.rows_written*40,
    with25PercentReserve:{reads:Math.ceil(perCycle.rows_read*40*1.25),writes:Math.ceil(perCycle.rows_written*40*1.25)},
    freeLimits:{reads:5000000,writes:100000},guard80Percent:{reads:4000000,writes:80000},otherAccountUsage:null,
    scenario:'40 cycles at the larger measured per-cycle read/write cost; each assumes one approved detail batch. Synthetic setup and other Workers excluded.',
    cloudflareAccountBilling:false};
  daily.within80PercentGuard=daily.with25PercentReserve.reads<=daily.guard80Percent.reads&&daily.with25PercentReserve.writes<=daily.guard80Percent.writes;
  daily.remainingToFreeLimit={reads:daily.freeLimits.reads-daily.with25PercentReserve.reads,writes:daily.freeLimits.writes-daily.with25PercentReserve.writes};
  const hash=async file=>createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex');
  return {scope:'LOCAL_MINIFLARE_D1_FULL_CAPACITY_SYNTHETIC_FIXTURE',setup,cycle,cycleTotal:total,service,before,after,daily,
    serviceSourceSha256:await hash('./service.mjs'),analysisSourceSha256:await hash('./analysis.mjs'),
    queryBudget:{limit:50,cycleQueries:total.queries,actualServiceQueries:actual.queries,actualPreviewQueries:service.actual_preview100_history20.queries,
      remainingForCallerQueries:50-Math.max(total.queries,actual.queries),withinLimit:total.queries<=50&&actual.queries<=50,
      callerAuthAndBudgetQueriesIncluded:false,previousRisk:'Full100 current cards formerly caused101 preview SQL. Current service loads history for at most20 explicit IDs.'},
    outcomes:{watchBefore:before.watch,historyBefore:before.history,watchAfter:after.watch,historyAfter:after.history,historyCounterMatches:after.history===after.history_counter,
      due:due.length,leaseAdmitted:lease.admitted,confirmed:ingested.confirmed,logicalObservations:ingested.observationsWritten,retentionPruned:ingested.historyPruned,
      capacityEvictions:before.history+ingested.observationsWritten-ingested.historyPruned-after.history,currentCards:current.length,currentConfirmed:current.filter(r=>r.confirmed).length,
      historiesRead:points.length,historyPoints:points.map(h=>h.length),finishOk:finished.finished,previewConfirmed:preview.confirmed,
      actualRefreshStatus:refreshed.status,actualRefreshConfirmed:refreshed.preview?.confirmed??null,syntheticSourceCalls,fixtureIds:rowIds}};
}
export async function runPriceBudgetProbe({reportPath=path.join(ROOT,'.test-temp/price-budget-report.json')}={}){
  let externalRequests=0;
  const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:WORKER,compatibilityDate:'2026-09-01',modules:true,
    script:'export default {fetch(){return new Response("LOCAL_PRICE_BUDGET_ONLY")}}',d1Databases:{PRICE_DB:DATABASE,FULL_PRICE_DB:FULL_DATABASE},
    outboundService:async()=>{externalRequests++;return new Response('EXTERNAL_ACCESS_FORBIDDEN',{status:403});}}]}));
  const operations={};
  try{
    const binding=await mf.getD1Database('PRICE_DB',WORKER);
    const measure=async(label,operation)=>{
      const meter=observeD1(binding),store=openPriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:DATABASE,PRICE_DB:meter.DB},{approvedDatabaseId:DATABASE});
      const value=await operation(store);
      operations[label]={...meter.metrics,metadata_complete:meter.coverage.complete,top_queries:meter.topQueries()};
      return value;
    };
    const rows=products();
    await measure('init',store=>store.init());
    const tracked=await measure('track20',store=>store.track(rows,{now:NOW}));
    const due=await measure('due20',store=>store.due({now:NOW,limit:20}));
    const lease=await measure('acquire',store=>store.acquire('wb-card',{now:NOW}));
    const ingested=await measure('ingest20',store=>store.ingest(rows,{now:NOW}));
    const current=await measure('list20',store=>store.list({now:NOW,limit:100}));
    const history=await measure('history1',store=>store.history(rows[0],{now:NOW}));
    const duplicate=await measure('repeat_ingest20',store=>store.ingest(rows,{now:NOW+1}));
    const stale=await measure('list20_after_freshness',store=>store.list({now:NOW+PRICE_LIMITS.maxAgeMs+1}));
    const ended=await measure('finish403',store=>store.finish('wb-card',lease.owner,{now:NOW+10,status:403,ok:false}));
    // Every measure opens a fresh store object. This re-admission occurs on a
    // later UTC day against the same durable D1 state, not an in-memory flag.
    const reopened=await measure('reopen_block',store=>store.acquire('wb-card',{now:NOW+2*86400000}));
    const failed=await measure('list20_after403',store=>store.list({now:NOW+11}));
    const retained=await measure('history_after403',store=>store.history(rows[0],{now:NOW+11}));
    // One explicitly synthetic old history row exercises real trigger-backed
    // deletion/RETURNING semantics. Setup is separate from measured cleanup.
    const oldAt=NOW-100*86400000;
    await binding.prepare('INSERT INTO price_observations(pid,variant,context,day,observed_at,price,source) VALUES(?,?,?,?,?,?,?)')
      .bind(rows[0].id,'fixture-retention-old',priceContextKey(rows[0].context),new Date(oldAt).toISOString().slice(0,10),oldAt,299.95,'wb_card').run();
    const cleanup=await measure('retention_cleanup',store=>store.ingest([],{now:NOW+12}));
    const count=await binding.prepare('SELECT count(*) n FROM price_observations').first();
    const capacityStress=await capacityProbe(await mf.getD1Database('FULL_PRICE_DB',WORKER));
    const report={scope:'LOCAL_MINIFLARE_D1_EMULATION',syntheticData:true,measurement:'OFFICIAL_D1_RESULT_METADATA_FROM_LOCAL_WORKERD',
      cloudflareAccountBilling:false,cloudflareAccountTotals:null,productionChanged:false,productionDatabaseAccess:false,
      externalRequests,workersAiCalls:0,telegramSends:0,fixtureTime:new Date(NOW).toISOString(),limits:PRICE_LIMITS,operations,capacityStress,
      outcomes:{tracked:tracked.tracked,due:due.length,leaseAdmitted:lease.admitted,confirmed:ingested.confirmed,observationsWritten:ingested.observationsWritten,
        currentPrices:current.filter(row=>row.confirmed).length,historyPoints:history.length,duplicateObservationsWritten:duplicate.observationsWritten,
        staleCurrentPrices:stale.filter(row=>row.confirmed).length,blocked:ended.blocked,reopenedAdmitted:reopened.admitted,reopenedReason:reopened.reason,
        pricesAfterFailure:failed.filter(row=>row.confirmed).length,historyPointsAfterFailure:retained.length,oldHistoryPruned:cleanup.historyPruned,totalObservationRows:count.n}};
    if(reportPath){await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n','utf8');}
    return report;
  }finally{await mf.dispose();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  runPriceBudgetProbe().then(report=>console.log(JSON.stringify({scope:report.scope,operations:report.operations,outcomes:report.outcomes})))
    .catch(()=>{console.error('LOCAL_PRICE_BUDGET_FAILED; no external or production source attempted');process.exitCode=1;});
}
