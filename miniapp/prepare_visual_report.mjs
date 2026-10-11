// Artifact generation only. No AI, cloud writes, credentials or image fetching.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gallery} from './visual_gallery.mjs';
const prior=JSON.parse(readFileSync('.test-temp/gemma-500-20261010/report.json','utf8'));
const current=JSON.parse(readFileSync('.test-temp/gemma-150-20261011/report.json','utf8'));
const verificationPath='.test-temp/gemma-150-20261011/verification.json';
const verification=existsSync(verificationPath)?JSON.parse(readFileSync(verificationPath,'utf8')):null;
if(verification?.error||verification&&(!verification.final_profiles||!verification.final_experiment||!verification.final_status))throw Error('Incomplete final verification');
const persisted=verification?.final_profiles||current.all_profiles;
const experiment=verification?.final_experiment||current.experiment;
const status=verification?.final_status||current.status;
const samples=JSON.parse(readFileSync('miniapp/cloudflare/visual_staging_samples.json','utf8')).products;
const results=samples.map(p=>{
  const recent=current.results.find(x=>x.nmId===p.id);
  if(recent?.profile)return recent;
  const saved=persisted.find(x=>x.images?.[0]?.hash===p.hash);
  const old=prior.results.find(x=>x.nmId===p.id);
  if(old?.profile){
    if(!saved||JSON.stringify(saved)!==JSON.stringify(old.profile))throw Error('Previously saved profile changed');
    return {...old,cache:verification?verification.cache_checks.some(x=>x.nmId===p.id&&x.same_profile):old.cache,origin:'prior_native_cache_preserved'};
  }
  const cacheCheck=verification?.cache_checks.find(x=>x.nmId===p.id&&x.same_profile);
  if(saved&&verification)return {nmId:p.id,title:p.title,image_url:p.image,profile:saved,state:cacheCheck?'cached':'complete',cache:!!cacheCheck,d1:cacheCheck?.d1,origin:'final_read_only_D1_verification',note:cacheCheck?'Persistent cache replay; zero extra AI':'Single remaining authorized attempt; persistent profile/provider receipt confirmed'};
  if(saved)return {nmId:p.id,title:p.title,image_url:p.image,profile:saved,state:'persisted',cache:false,recovered_from_d1:true,origin:'new_profile_confirmed_by_read_only_D1',note:'AI POST response lost; persistent profile/provider receipt present; cache replay not completed'};
  return {nmId:p.id,title:p.title,image_url:p.image,state:'not_analysed',error:'TLS_STOP_NO_AI_ATTEMPT',cache:false};
});
const report={results,experiment:{...experiment,calls_receipts:[...prior.experiment.calls_receipts,...experiment.calls_receipts]},additional_experiment:experiment,prior_experiment:prior.experiment,status:{deployment_id:status?.deployment_id,river_mode:status?.river_mode,enabled:status?.enabled,automatic_analysis_allowed:status?.automatic_analysis_allowed,budget_hold:status?.budget_hold,neurons_charged:status?.neurons_charged},stop_reason:verification?'':current.stop_reason,transport_error:verification?null:current.diagnostic?.detail,finished_at:verification?.finished_at||current.finished_at,production_changed:false,cache_verification:verification?{products:verification.cache_checks.length,extra_ai_calls:verification.cache_experiment.calls-verification.before_experiment.calls,extra_neurons:verification.cache_experiment.charged-verification.before_experiment.charged,extra_rows_written:verification.cache_checks.reduce((a,v)=>a+v.d1.rows_written,0),rows_read:verification.cache_checks.reduce((a,v)=>a+v.d1.rows_read,0)}:null,previous_transport_stop:{phase:current.diagnostic?.phase,detail:current.diagnostic?.detail,ai_calls:current.experiment.calls},remaining_single_attempt:!!verification?.attempt_started};
report.neurons_total_gemma=prior.experiment.charged+experiment.charged;
writeFileSync('.test-temp/gemma-150-20261011/combined-report.json',JSON.stringify(report,null,2));
const {html,quality}=gallery(report);let packed=html;
for(const p of samples){
  const bytes=readFileSync(`.test-temp/vision-test-20261010/${p.id}.webp`);
  if(createHash('sha256').update(bytes).digest('hex')!==p.hash)throw Error('Report photograph hash changed');
  packed=packed.replaceAll(`/photos/${p.id}.webp`,'data:image/webp;base64,'+bytes.toString('base64'));
}
mkdirSync('docs/vision-gemma-20261011',{recursive:true});
writeFileSync('docs/vision-gemma-20261011/gallery.html',packed);
writeFileSync('docs/vision-gemma-20261011/report.json',JSON.stringify({...report,quality},null,2));
console.log(JSON.stringify({profiles:quality.profiles,additional_neurons:experiment.charged,gemma_total_neurons:report.neurons_total_gemma,quality,photographs:samples.length,production_changed:false}));
