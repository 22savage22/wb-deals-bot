// LOCAL BUILD ONLY. No Cloudflare API, deploy, token, environment-file reads.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,cp,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildPriceIntegrityOnly,PRICE_INTEGRITY_BASE,PRICE_INTEGRITY_PATCH_SHA256} from './prepare_price_integrity_only.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),CORE='aacdeded-216b-4f5a-af1a-081eef724d04';
const sha=value=>createHash('sha256').update(value).digest('hex');
function replaceOnce(source,from,to){if(!source.includes(from)||source.indexOf(from)!==source.lastIndexOf(from))throw Error('PINNED_PROJECTION_SOURCE_CHANGED');return source.replace(from,to);}
export async function buildProjectionStaging({outDir,buildLabel='primary'}={}){
  if(typeof outDir!=='string')throw Error('PROJECTION_OUTPUT_REQUIRED');
  if(!['primary','cold'].includes(buildLabel))throw Error('PROJECTION_BUILD_LABEL_INVALID');
  const output=resolve(ROOT,outDir),rel=relative(resolve(ROOT,'.test-temp'),output);
  if(!rel||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('PROJECTION_OUTPUT_OUTSIDE_TEST_TEMP');
  try{await stat(output);throw Error('PROJECTION_OUTPUT_ALREADY_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  const reference=join(output,'reference'),candidate=join(output,'candidate');
  const base=buildPriceIntegrityOnly({outDir:reference});await cp(reference,candidate,{recursive:true});
  const dependencyFiles=['audience_quality.mjs','audience_feedback.mjs','learning.mjs','native_scheduler.mjs','selection_policy.mjs','visual_enrichment.mjs','visual_features.mjs'];
  const dependencyHashes={};for(const file of dependencyFiles)dependencyHashes[file]=sha(await readFile(join(reference,'miniapp/cloudflare',file)));
  const algorithm='projection-v1-'+sha(JSON.stringify(dependencyHashes));
  for(const dir of [reference,candidate]){
    const worker=join(dir,'miniapp/cloudflare/worker.mjs');
    // The original scheduled boundary is retained. Only its fetch dependency is
    // injected so even the full boundary cannot contact WB or Telegram.
    await writeFile(worker,replaceOnce(await readFile(worker,'utf8'),'nativeTick(e,controller.scheduledTime)',"nativeTick(e,controller.scheduledTime,e.PROJECTION_FIXTURE_FETCH)"));
  }
  await cp(join(ROOT,'miniapp/cloudflare/cron_projections.mjs'),join(candidate,'miniapp/cloudflare/cron_projections.mjs'));
  await writeFile(join(candidate,'miniapp/prices/projection_adapter.mjs'),replaceOnce(await readFile(join(ROOT,'miniapp/prices/projection_adapter.mjs'),'utf8'),'__WB_PROJECTION_ALGORITHM__',JSON.stringify(algorithm)));
  const nativeFile=join(candidate,'miniapp/cloudflare/native_scheduler.mjs');let native=await readFile(nativeFile,'utf8');
  native="import {preparedProduct,decodePreparedProduct} from '../prices/projection_adapter.mjs';\n"+native;
  native=replaceOnce(native,'function groups(p){','function groups(p){const prepared=preparedProduct(p);if(prepared?.nativeGroups)return prepared.nativeGroups;');
  native+='\nexport {groups as projectionNativeGroups};\n';
  const start=native.indexOf('export function choose('),end=native.indexOf('async function runtime(',start);
  if(start<0||end<start)throw Error('PINNED_CHOOSE_NOT_FOUND');
  let choose=native.slice(start,end);
  choose=replaceOnce(choose,'feedback=null){',"feedback=null){\n  const decode=row=>decodePreparedProduct(row.data,feedback?.projections?.get(row.pid));");
  choose=choose.replaceAll('JSON.parse(p.data)','decode(p)').replaceAll('JSON.parse(row.data)','decode(row)');
  native=native.slice(0,start)+choose+native.slice(end);
  native=replaceOnce(native,'await audienceContext(env,current.ready.map(r=>r.pid))','await audienceContext(env,current.ready.map(r=>r.pid),current.ready)');
  native=replaceOnce(native,'const manual=current.row.post_request;',"if(feedback?.projectionUnsafe)return {result:'projection_feedback_unavailable'};\n    const manual=current.row.post_request;");
  await writeFile(nativeFile,native);

  const qualityFile=join(candidate,'miniapp/cloudflare/audience_quality.mjs');let quality=await readFile(qualityFile,'utf8');
  quality="import {preparedProduct,decodePreparedProduct} from '../prices/projection_adapter.mjs';\n"+quality;
  quality=replaceOnce(quality,'export function ownerCategory(p){',"export function ownerCategory(p){const prepared=preparedProduct(p);if(prepared&&Object.hasOwn(prepared,'ownerCategory'))return prepared.ownerCategory;");
  quality=replaceOnce(quality,'export function productType(p){',"export function productType(p){const prepared=preparedProduct(p);if(prepared?.productType)return prepared.productType;");
  quality=quality.replace('productType(JSON.parse(r.data))!==last','productType(decodePreparedProduct(r.data,context?.projections?.get(r.pid)))!==last');
  quality=replaceOnce(quality,'const p=JSON.parse(row.data),v=candidateQuality','const p=decodePreparedProduct(row.data,context?.projections?.get(row.pid)),v=candidateQuality');
  await writeFile(qualityFile,quality);

  const feedbackFile=join(candidate,'miniapp/cloudflare/audience_feedback.mjs');let feedback=await readFile(feedbackFile,'utf8');
  feedback="import {preparedAudienceContext} from '../prices/projection_adapter.mjs';\n"+feedback;
  feedback=replaceOnce(feedback,'export async function audienceContext(e,candidateIds=[]){','export async function originalAudienceContext(e,candidateIds=[]){');
  feedback+='\nexport function audienceContext(e,candidateIds=[],candidateRows=[]){return preparedAudienceContext(e,candidateIds,candidateRows,originalAudienceContext);}\n';
  await writeFile(feedbackFile,feedback);

  const learningFile=join(candidate,'miniapp/cloudflare/learning.mjs');let learning=await readFile(learningFile,'utf8');
  learning="import {preparedShadowVisuals} from '../prices/projection_adapter.mjs';\n"+learning;
  learning=replaceOnce(learning,'const profiles=await cachedProfiles(e,candidates.map(c=>c.row.pid)),actual=JSON.parse(legacy.data);','const projectedVisual=await preparedShadowVisuals(e,candidates.map(c=>c.row.pid)),actual=JSON.parse(legacy.data);');
  learning=replaceOnce(learning,'const visual=p=>profileFeatures(profiles.get(p.id)),f=','const visual=p=>projectedVisual(p.id),f=');
  await writeFile(learningFile,learning);

  const bundles={};
  for(const [mode,tree] of [['reference',reference],['prepared',candidate]]){
    const driver=join(tree,'miniapp/prices/projection_staging_driver.mjs');await cp(join(ROOT,'miniapp/prices/projection_staging_driver.mjs'),driver);
    await cp(join(ROOT,'miniapp/prices/projection_fixture.mjs'),join(tree,'miniapp/prices/projection_fixture.mjs'));
    const entry="import {createWorker} from '../cloudflare/worker.mjs';\nimport {observeD1} from '../cloudflare/d1_budget.mjs';\nimport {createProjectionStagingDriver} from './projection_staging_driver.mjs';\n"+
      (mode==='prepared'?"import {projectionStore} from './projection_adapter.mjs';\n":'')+
      'export default createProjectionStagingDriver({worker:createWorker(),observeD1,buildLabel:'+JSON.stringify(buildLabel)+(mode==='prepared'?',storeFactory:projectionStore':'')+'});\n';
    const entryFile=join(tree,'miniapp/prices/projection_entry.mjs');await writeFile(entryFile,entry);
    const built=await build({absWorkingDir:tree,entryPoints:[entryFile],bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent',define:{__WB_PROJECTION_ALGORITHM__:JSON.stringify(algorithm)}});
    const code=built.outputFiles[0].text,file=join(output,mode+'.mjs');await writeFile(file,code);
    const config={name:'wb-finds-price-fixture-staging',account_id:'a4f7cbd9ad379d4b18087b99e9839205',main:file,compatibility_date:'2026-09-01',workers_dev:false,preview_urls:false,routes:[],send_metrics:false,
      vars:{PRICE_LOCAL_STAGING:'1',SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:fixture-passive-price',MINIAPP_BOT_USERNAME:'fixture_bot',PRICE_OBSERVATION_ENABLED:'0',PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:CORE},
      d1_databases:[{binding:'DB',database_name:'wb-finds-price-fixture-staging',database_id:CORE}],triggers:{crons:[]},observability:{enabled:true,head_sampling_rate:1}};
    await writeFile(join(output,mode+'.wrangler.json'),JSON.stringify(config,null,2));bundles[mode]={sha256:sha(code),bytes:Buffer.byteLength(code),path:file};
  }
  const manifest={status:'LOCAL_PREPARED_NOT_DEPLOYED',base:PRICE_INTEGRITY_BASE,pricePatch:PRICE_INTEGRITY_PATCH_SHA256,algorithm,dependencyHashes,buildLabel,
    excludesAllPriorCpuPatches:true,observerEnabled:false,productionChanged:false,realRequests:0,worker:'wb-finds-price-fixture-staging',databaseId:CORE,newResources:0,bundles,
    safety:{noPublicURL:true,noCron:true,noAI:true,noRealTelegram:true,noRealWB:true,originalScheduledBoundary:true,requiresSeparateOwnerDeploymentApproval:true}};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));return {...manifest,referenceDir:reference,candidateDir:candidate};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const result=await buildProjectionStaging({outDir:process.argv[2]});console.log(JSON.stringify(result,null,2));}
