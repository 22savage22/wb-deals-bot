// Full ORIGINAL scheduled-boundary E2E in LOCAL Miniflare/workerd only.
// No Wrangler/auth/Cloudflare API, live WB, Telegram or AI. Never a CPU gate.
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildProjectionStaging} from './prepare_projection_staging.mjs';
import {seedProjectionFixture} from './projection_fixture_seed.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url)),CORE='aacdeded-216b-4f5a-af1a-081eef724d04';
const names={reference:'projection-local-reference',prepared:'projection-local-prepared'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const sum=receipts=>receipts.reduce((a,r)=>({queries:a.queries+r.mainD1.queries,rows_read:a.rows_read+r.mainD1.rows_read,rows_written:a.rows_written+r.mainD1.rows_written}),{queries:0,rows_read:0,rows_written:0});
function outputPath(value){const result=path.resolve(ROOT,value),rel=path.relative(path.join(ROOT,'.test-temp'),result);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('LOCAL_PROJECTION_OUTPUT_REQUIRED');return result;}
const safeDeal=raw=>{const p=JSON.parse(raw);assert.ok(Number.isSafeInteger(p.priceObservedAt)&&p.priceObservedAt<=Date.now());assert.equal(p.stockObservedAt,p.priceObservedAt);assert.equal(p.observedAt,p.priceObservedAt);assert.equal(p.priceProvenance.receivedAt,p.priceObservedAt);assert.ok(p.validationAttemptAt<=p.priceObservedAt);
 for(const key of ['observedAt','priceObservedAt','stockObservedAt','validationAttemptAt'])delete p[key];delete p.priceProvenance.receivedAt;return p;};
async function snapshot(DB){
 const deliveries=(await DB.prepare('SELECT pid,data,message_id FROM scheduler_deliveries ORDER BY pid').all()).results;
 const shadows=(await DB.prepare('SELECT pid,legacy_pid,river_pid,legacy_p,river_p,features FROM learning_shadow ORDER BY pid').all()).results.map(row=>({...row,features:JSON.parse(row.features)}));
 const row=await DB.prepare('SELECT data,status FROM scheduler_config WHERE id=1').first(),state=await DB.prepare('SELECT config,model FROM learning_state WHERE id=1').first();
 return {deliveries:deliveries.map(row=>({...row,data:safeDeal(row.data)})),shadows,schedule:JSON.parse(row.data),learningConfig:JSON.parse(state.config),model:JSON.parse(state.model),selection:JSON.parse(row.status).selection_explanation};
}
async function allowFixturePost(DB){
 // Advance only synthetic previous post/claim ages. The30-minute schedule and
 // actual publication gates remain unchanged; no raw posts leave workerd.
 await DB.prepare('UPDATE scheduler_posts SET ts=ts-3600').run();await DB.prepare('UPDATE scheduler_claims SET ts=ts-3600').run();
}
async function fixtureIdle(DB){
 const now=Math.floor(Date.now()/1000);await DB.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_maintenance',?,'$.last_preflight',?,'$.last_scan_attempt',?) WHERE id=1").bind(now,now,now).run();
}
function receiptProjection(receipt,kind){return receipt.projection?.find(p=>p.kind===kind);}
export async function runProjectionLocalStaging({outDir,preparedBuildDir,reportPath,postCalls=8,idleCalls=8,restart=true}={}){
 if(!Number.isSafeInteger(postCalls)||postCalls<1||postCalls>12||!Number.isSafeInteger(idleCalls)||idleCalls<0||idleCalls>12||typeof restart!=='boolean')throw Error('BOUNDED_LOCAL_REPLAYS_REQUIRED');
 const started=Date.now(),directory=outputPath(preparedBuildDir??outDir??`.test-temp/projection-local-${process.pid}-${started}`),reportFile=outputPath(reportPath??path.join(directory,'local-report.json'));
 const built=preparedBuildDir?{...JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8')),referenceDir:path.join(directory,'reference'),candidateDir:path.join(directory,'candidate')}:await buildProjectionStaging({outDir:directory});
 assert.equal(built.base,'524fbe8931b911e4c3bc4e05de7caf5003b1decc');assert.equal(built.excludesAllPriorCpuPatches,true);
 for(const mode of ['reference','prepared']){assert.equal(path.resolve(built.bundles[mode].path),path.join(directory,mode+'.mjs'));assert.equal(sha(await readFile(built.bundles[mode].path)),built.bundles[mode].sha256,'reuse only exact prepared bytes');}
 const scripts={reference:await readFile(built.bundles.reference.path,'utf8'),prepared:await readFile(built.bundles.prepared.path,'utf8')};
 const persistence=path.join(directory,'local-d1-state-'+started);await mkdir(persistence,{recursive:true});
 let externalRequests=0,mf,stage='launch';const phases=[],preparation=[];
 const deny=async()=>{externalRequests++;return new Response('EXTERNAL_ACCESS_FORBIDDEN',{status:403});};
 const launch=()=>new Miniflare(convertV4MiniflareOptions({cf:false,log:new Log(LogLevel.NONE),telemetry:{enabled:false},resourcePersistencePath:persistence,isolatedResourcePersistencePath:persistence,workers:Object.entries(names).map(([mode,name])=>({
  name,script:scripts[mode],modules:true,compatibilityDate:'2026-09-01',outboundService:deny,
  d1Databases:{DB:'local-projection-'+mode+'-'+CORE},bindings:{PRICE_LOCAL_STAGING:'1',SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:fixture-passive-price',MINIAPP_BOT_USERNAME:'fixture_bot',PRICE_OBSERVATION_ENABLED:'0',PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:CORE}
 }))}));
 let workers={},databases={};
 async function connect(){workers={};databases={};for(const [mode,name] of Object.entries(names)){databases[mode]=await mf.getD1Database('DB',name);workers[mode]=await mf.getWorker(name);}}
 async function call(mode,endpoint,body){
  const begin=Date.now(),response=await workers[mode].fetch('https://local-projection.invalid'+endpoint,{method:'POST',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
  assert.equal(response.status,200,mode+' '+endpoint+' HTTP status');const receipt=await response.json();assert.equal(receipt.scope,'SYNTHETIC_FULL_CRON_PROJECTION_STAGING');assert.equal(receipt.counts.actualExternalRequests,0);assert.equal(receipt.metadataComplete,true);
  return {...receipt,localWallMsNotCpu:Date.now()-begin};
 }
 async function prepare(ids,label){const receipt=await call('prepared','/prepare',{ids,now:Date.now()});preparation.push({label,ids,receipt});return receipt;}
 async function postPair(label,{expectHit=false,expectMiss=false,expectFirst=false}={}){
  const receipts={};for(const mode of Object.keys(names)){
   await allowFixturePost(databases[mode]);receipts[mode]=await call(mode,'/replay');
   assert.equal(receipts[mode].result?.results?.post?.result,'success',label+' '+mode+' successful publication');assert.equal(receipts[mode].counts.simulatedTelegram,1);assert.equal(receipts[mode].counts.wbDetails,1);assert.equal(receipts[mode].counts.wbSearch,0);
   if(expectFirst)assert.equal(receipts[mode].firstInvocation,true,'fresh workerd isolate for '+mode);
  }
  const a=receipts.reference,b=receipts.prepared;assert.deepEqual(a.counts,b.counts,label+' source counts');assert.deepEqual(a.simulatedMessages,b.simulatedMessages,label+' exact caption/photo/buttons');
  const id=a.result.results.post.product_id;assert.equal(b.result.results.post.product_id,id,label+' selected product');
  const snapshots={reference:await snapshot(databases.reference),prepared:await snapshot(databases.prepared)};assert.deepEqual(snapshots.reference,snapshots.prepared,label+' exact business/SHADOW state');
  const deal=snapshots.prepared.deliveries.find(p=>p.pid===id)?.data;assert.ok(deal);assert.equal(deal.product,249.99);assert.equal(deal.variantKey,String(id*10+2));assert.equal(deal.size,'M');assert.equal(deal.available,true);assert.equal(deal.fallback,false);assert.equal(deal.priceStatus,'api_observed');assert.equal(deal.retailConfirmed,false);
  assert.match(a.simulatedMessages[0].caption,/Цена из ответа WB/);assert.ok(!/Сейчас|проверена/.test(a.simulatedMessages[0].caption));
  if(expectHit)assert.ok(receiptProjection(b,'audience-hit'),label+' persistent audience hit');if(expectMiss)assert.ok(receiptProjection(b,'audience-miss'),label+' explicit original fallback');
  phases.push({label,kind:'post',selected:id,reference:a,prepared:b,proof:{sameSelectedId:true,sameCaptionButtonsPhoto:true,sameSourceCounts:true,sameDeliveryAndShadow:true},businessSha256:sha(JSON.stringify(snapshots.prepared))});
  return id;
 }
 async function idlePair(label){
  const receipts={};for(const mode of Object.keys(names)){await fixtureIdle(databases[mode]);receipts[mode]=await call(mode,'/replay');assert.equal(receipts[mode].counts.simulatedTelegram,0);assert.equal(receipts[mode].counts.wbDetails,0);assert.equal(receipts[mode].counts.wbSearch,0);assert.equal(receipts[mode].result?.results?.post,undefined);}
  assert.deepEqual(receipts.reference.counts,receipts.prepared.counts);assert.deepEqual(await snapshot(databases.reference),await snapshot(databases.prepared));phases.push({label,kind:'idle',...receipts,proof:{noPublication:true,noWBRequests:true,sameBusinessState:true}});
 }
 let report;
 try{
  mf=launch();await connect();stage='seed-original-fixtures';
  const seeded={};for(const mode of Object.keys(names))seeded[mode]=await seedProjectionFixture(databases[mode],{referenceDir:built.referenceDir,now:started});
  assert.equal(seeded.reference.corpusSha256,seeded.prepared.corpusSha256);
  stage='projection-init';preparation.push({label:'schema-init',receipt:await call('prepared','/init')});
  stage='prepare300';for(let n=0;n<300;n+=20){const r=await prepare(Array.from({length:20},(_,i)=>900000+n+i),'initial-'+n);assert.equal(r.result.written,20);}
  assert.equal((await databases.prepared.prepare('SELECT COUNT(*) AS n FROM cron_product_projections').first()).n,300);
  stage='warm-ab';for(let n=0;n<Math.max(postCalls,idleCalls);n++){
   if(n<postCalls){const id=await postPair('warm-post-'+n,{expectHit:true});await prepare([id],'refresh-after-warm-post-'+n);}
   if(n<idleCalls)await idlePair('idle-'+n);
  }
  let durableColdHit=false;
  if(restart){
   stage='fresh-workerd-restart';await mf.dispose();mf=launch();await connect();assert.equal((await databases.prepared.prepare('SELECT COUNT(*) AS n FROM cron_product_projections').first()).n,300);
   const id=await postPair('durable-cold-hit',{expectHit:true,expectFirst:true});durableColdHit=true;await prepare([id],'refresh-after-cold-hit');
  }
  stage='explicit-miss';await databases.prepared.prepare('DELETE FROM cron_product_projections WHERE pid=?').bind(900250).run();
  const missId=await postPair('one-missing-projection',{expectMiss:true});await prepare([900250,missId],'restore-after-miss');
  stage='exact-image-invalidation';for(const mode of Object.keys(names))await databases[mode].prepare("UPDATE scheduler_inventory SET data=json_set(data,'$.image_version',2) WHERE pid=?").bind(900251).run();
  await postPair('one-invalidated-image',{expectMiss:true});
  stage='final-proof';const final=await snapshot(databases.prepared);assert.equal(final.schedule.post_interval_minutes,30);assert.equal(final.schedule.search_enabled,false);assert.equal(final.learningConfig.mode,'SHADOW');assert.equal(externalRequests,0);
  assert.equal(new Set(final.deliveries.map(row=>row.message_id)).size,final.deliveries.length,'unique synthetic messages exercise reaction registration');
  const warm=phases.filter(p=>p.label.startsWith('warm-post')),idle=phases.filter(p=>p.kind==='idle');
  report={status:'PASS',scope:'LOCAL_MINIFLARE_FULL_ORIGINAL_SCHEDULED_PROJECTION_AB',syntheticData:true,referenceBase:built.base,priceOnlyPatch:built.pricePatch,excludesAllPriorCpuPatches:true,bundles:built.bundles,algorithm:built.algorithm,
   fixture:seeded.reference,preparation,phases,durableColdHit,externalRequests,realTelegramPosts:0,realWBRequests:0,workersAiCalls:0,productionChanged:false,remoteDeployed:false,
   results:{warmPostsPerArm:warm.length,idleCallsPerArm:idle.length,totalPostsPerArm:phases.filter(p=>p.kind==='post').length,warm:{reference:sum(warm.map(p=>p.reference)),prepared:sum(warm.map(p=>p.prepared))},idle:{reference:sum(idle.map(p=>p.reference)),prepared:sum(idle.map(p=>p.prepared))},
    maxMainQueries:Math.max(...phases.flatMap(p=>[p.reference.mainD1.queries,p.prepared.mainD1.queries])),allBusinessProofsMatched:true,uniqueSyntheticMessages:final.deliveries.length,scheduleMinutes:30,searchEnabled:false,river:'SHADOW'},
   limitations:['LOCAL workerd/D1 emulation only; not Cloudflare CPU or billing.','Local wall durations are diagnostics, never CPU measurements.','Synthetic profiles are deterministic fixtures, not real image recognition.','Every refreshed product is re-prepared in a separate bounded task; post itself never warms cache.','Cache misses run ORIGINAL fresh feedback/profile processing.','Observation/stock/provenance timestamp equality and validation-attempt ordering are verified; only their real invocation clock values are omitted from A/B business comparison.'],wallMs:Date.now()-started};
  await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify(report,null,2)+'\n');return report;
 }catch(error){
  await mkdir(path.dirname(reportFile),{recursive:true});await writeFile(reportFile,JSON.stringify({status:'FAILED',scope:'LOCAL_MINIFLARE_PROJECTION_AB',stage,externalRequests,realTelegramPosts:0,remoteDeployed:false,preparation,phases,errorCode:error.code||'LOCAL_ASSERTION_OR_RUNTIME_FAILURE',message:String(error.message).slice(0,300)},null,2)+'\n');throw error;
 }finally{if(mf)await mf.dispose();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const r=await runProjectionLocalStaging(process.argv[2]==='--reuse'?{preparedBuildDir:process.argv[3]}:{outDir:process.argv[2]});console.log(JSON.stringify({status:r.status,scope:r.scope,results:r.results,durableColdHit:r.durableColdHit,externalRequests:r.externalRequests,wallMs:r.wallMs},null,2));}
