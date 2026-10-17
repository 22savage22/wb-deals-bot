// Explicit offline setup; HTTP GET/opening galleries never initializes a test.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createExperiment,summarizeExperiment} from './prospective_experiment.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const statePath=path.join(root,'.test-temp/value-taste/prospective-test.json');
async function verifiedProducts(report,dir){
  const rows=[];
  for(const p of report.products){
    if(!/^[a-f0-9]{64}$/.test(p.imageHash||''))continue;
    try{const bytes=await fs.readFile(path.join(dir,'photos',`${p.id}.webp`));if(createHash('sha256').update(bytes).digest('hex')===p.imageHash)rows.push(p);}catch{/* A missing photo is not a test candidate. */}
  }return rows;
}
export async function prepareProspective(){
  try{const saved=JSON.parse(await fs.readFile(statePath,'utf8'));console.log(JSON.stringify({EXPERIMENT_REUSED:saved.id,revision:saved.revision,ratings:saved.ratings.length,overwritten:false}));return saved;}catch(e){if(e.code!=='ENOENT')throw e;}
  const trainingBytes=await fs.readFile(path.join(root,'.test-temp/value-taste/ratings.json'));
  const training=JSON.parse(trainingBytes);
  const trainingReport=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-20261011/report.json'),'utf8'));
  const report=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-prospective-20261011/report.json'),'utf8'));
  const trainingProducts=await verifiedProducts(trainingReport,path.join(root,'docs/shadow-20261011'));
  const products=await verifiedProducts(report,path.join(root,'docs/shadow-prospective-20261011'));
  const visual=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-20261011/reviewed-visual.json'),'utf8')).profiles||{};
  const sha=createHash('sha256').update(trainingBytes).digest('hex');
  const frozen=createExperiment(products,training,{id:'prospective-20261011-'+sha.slice(0,12),trainingProducts,traitsById:visual,now:Date.now(),target:20,min:15,legacyCounter:trainingReport.comparison?.legacyCounter||0});
  const experiment={...frozen,trainingFileHash:sha,candidateHash:createHash('sha256').update(JSON.stringify(frozen.products.map(p=>[p.id,p.imageHash,p.category,p.price,p.observedAt]))).digest('hex')};
  await fs.mkdir(path.dirname(statePath),{recursive:true});
  // Exclusive creation: never clobber another simultaneous setup or real votes.
  await fs.writeFile(statePath,JSON.stringify(experiment)+'\n',{flag:'wx'});
  console.log(JSON.stringify({EXPERIMENT_CREATED:experiment.id,TRAINING_HASH:sha,CANDIDATES:experiment.candidateIds.length,TRAINING_PRODUCTS:trainingProducts.length,PHOTO_PRODUCTS:products.length,summary:summarizeExperiment(experiment),productionWrites:0}));
  return experiment;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareProspective();
