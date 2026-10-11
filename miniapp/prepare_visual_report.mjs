// Artifact generation only. No AI, cloud writes, credentials or image fetching.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gallery} from './visual_gallery.mjs';
const prior=JSON.parse(readFileSync('.test-temp/gemma-500-20261010/report.json','utf8'));
const current=JSON.parse(readFileSync('.test-temp/gemma-150-20261011/report.json','utf8'));
const samples=JSON.parse(readFileSync('miniapp/cloudflare/visual_staging_samples.json','utf8')).products;
const results=samples.map(p=>{
  const recent=current.results.find(x=>x.nmId===p.id);
  if(recent?.profile)return recent;
  const saved=current.all_profiles.find(x=>x.images?.[0]?.hash===p.hash);
  const old=prior.results.find(x=>x.nmId===p.id);
  if(old?.profile){
    if(!saved||JSON.stringify(saved)!==JSON.stringify(old.profile))throw Error('Previously saved profile changed');
    return {...old,origin:'prior_native_cache_preserved'};
  }
  if(saved)return {nmId:p.id,title:p.title,image_url:p.image,profile:saved,state:'persisted',cache:false,recovered_from_d1:true,origin:'new_profile_confirmed_by_read_only_D1',note:'AI POST response lost; persistent profile/provider receipt present; cache replay not completed'};
  return {nmId:p.id,title:p.title,image_url:p.image,state:'not_analysed',error:'TLS_STOP_NO_AI_ATTEMPT',cache:false};
});
const report={results,experiment:{...current.experiment,calls_receipts:[...prior.experiment.calls_receipts,...current.experiment.calls_receipts]},additional_experiment:current.experiment,prior_experiment:prior.experiment,status:{deployment_id:current.status?.deployment_id,river_mode:current.status?.river_mode,enabled:current.status?.enabled,budget_hold:current.status?.budget_hold,neurons_charged:current.status?.neurons_charged},stop_reason:current.stop_reason,transport_error:current.diagnostic?.detail,finished_at:current.finished_at,production_changed:false};
report.neurons_total_gemma=prior.experiment.charged+current.experiment.charged;
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
console.log(JSON.stringify({profiles:quality.profiles,additional_neurons:current.experiment.charged,gemma_total_neurons:report.neurons_total_gemma,quality,photographs:samples.length,production_changed:false}));
