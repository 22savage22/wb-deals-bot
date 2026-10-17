// Explicit local read-only audit. No callbacks/votes, downloads, AI, fitting or output files.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {auditFirstPass,assessNextPool} from './prospective_diagnostics.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async relative=>{const bytes=await fs.readFile(path.join(root,relative));return {bytes,json:JSON.parse(bytes),hash:sha(bytes)};};
export async function runProspectiveAudit(){
  const input=await read('.test-temp/value-taste/prospective-test.json'),history=await read('.test-temp/value-taste/ratings.json');
  if(input.json.trainingFileHash!==history.hash)throw Error('AUDIT_TRAINING_HASH_CHANGED');
  const report=await read('docs/shadow-prospective-20261011/report.json'),old=await read('docs/shadow-20261011/report.json');
  const visual=await read('docs/shadow-20261011/reviewed-visual.json'),photoHashesById={};
  for(const product of report.json.products){
    if(!Number.isSafeInteger(product.id)||product.id<=0)throw Error('AUDIT_INVALID_PHOTO_ID');
    try{photoHashesById[product.id]=sha(await fs.readFile(path.join(root,'docs/shadow-prospective-20261011/photos',`${product.id}.webp`)));}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(input.json.products.some(product=>photoHashesById[product.id]!==product.imageHash))throw Error('AUDIT_FIRST_PASS_PHOTO_MISMATCH');
  const audit=auditFirstPass(input.json),pool=assessNextPool(report.json.products,history.json,{exposedProducts:input.json.products,
    historicalProducts:old.json.products,photoHashesById,traitsById:visual.json.profiles??{}});
  const trainingVisualByGroup={};
  for(const product of Object.values(visual.json.profiles??{}))trainingVisualByGroup[product.group]=(trainingVisualByGroup[product.group]??0)+1;
  // Detect concurrent edits, rather than returning mixed first/current observations.
  if(sha(await fs.readFile(path.join(root,'.test-temp/value-taste/prospective-test.json')))!==input.hash||
    sha(await fs.readFile(path.join(root,'.test-temp/value-taste/ratings.json')))!==history.hash)throw Error('AUDIT_INPUT_CHANGED_DURING_READ');
  return {experimentId:audit.experimentId,revision:input.json.revision,firstPassPhotoHashesVerified:input.json.products.length,
    profiles:Object.fromEntries(Object.entries(audit.profiles).map(([person,p])=>[person,{rated:p.evaluated,positive:p.positive,negative:p.negative,
      legacyTop5:p.top5.legacy.positive,newTop5:p.top5.new.positive,classification:p.classification,errors:p.errors,
      unknownReasons:p.unknownReasons,unknownCategoryEvidence:p.unknownCategoryEvidence,categoryOnlyPredictions:p.categoryOnlyPredictions,
      candidateVisualProfiles:p.reviewedCandidateProfiles,newTop5MaxSameCategoryRun:p.top5.new.maxSameCategoryRun,
      constantCriteria:p.constantCriteria,ties:p.ties,correctionsAfterFirstPass:p.correctionsAfterFirstPass}])),
    agreement:Object.fromEntries(Object.entries(audit.agreement).map(([key,ids])=>[key,ids.length])),nextPool:pool,
    trainingVisualByGroup,proof:{trainingFileHash:history.hash,experimentFileHash:input.hash,
      frozenHash:sha(JSON.stringify(input.json.frozen)),inputsUnchanged:true,trainingFeedbackAdded:0,rankingsChanged:0,
      sourceRequests:0,aiCalls:0,productionWrites:0},newQualityClaim:null};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runProspectiveAudit(),null,2));
