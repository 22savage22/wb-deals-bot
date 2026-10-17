// Reproducible LOCAL report. Original exports/votes are read-only; personal
// results are written only to the ignored repository-local .test-temp folder.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildTasteReport,normalizeTasteInput} from './taste_report.mjs';
import {recommendForProfiles} from './recommendations.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function boundedJson(file){const info=await fs.stat(file);if(info.size>1000000)throw Error('LOCAL_INPUT_TOO_LARGE');const bytes=await fs.readFile(file);return {bytes,data:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''))};}
export async function analyzeLocalTaste({inputPath=path.join(root,'.test-temp/value-taste/ratings.json'),exportPath=null,now=Date.now()}={}){
  const input=await boundedJson(inputPath),report=(await boundedJson(path.join(root,'docs/shadow-20261011/report.json'))).data;
  const visual=(await boundedJson(path.join(root,'docs/shadow-20261011/reviewed-visual.json'))).data;
  const source=(await boundedJson(path.join(root,'docs/shadow-20261011/price-check.json'))).data;
  const traitsById={};
  for(const p of report.products){const traits=visual.profiles[p.id];if(!traits||p.imageHash!==traits.imageHash)continue;try{if(sha(await fs.readFile(path.join(root,'docs/shadow-20261011/photos',p.id+'.webp')))===p.imageHash)traitsById[p.id]=traits;}catch{/* Missing photo, no evidence. */}}
  const tasteReport=buildTasteReport(input.data,report.products,{now,traitsById});
  let exportVerification=null;
  if(exportPath){const other=await boundedJson(exportPath),a=normalizeTasteInput(input.data,{products:report.products,now,traitsById}),b=normalizeTasteInput(other.data,{products:report.products,now,traitsById});
    // Features/profiles from a download do not establish truth. Compare votes
    // and minimal archives after independent server-side normalization.
    exportVerification={version:other.data.version,sha256:sha(other.bytes),sameCurrentVotes:JSON.stringify(a.state.ratings)===JSON.stringify(b.state.ratings),sameArchive:JSON.stringify(a.archive)===JSON.stringify(b.archive),inputRows:b.validation.inputRows,invalidRows:b.validation.invalidRows};
  }
  const output={version:1,mode:'SHADOW',generatedAt:now,inputSha256:sha(input.bytes),inputUnchanged:sha(await fs.readFile(inputPath))===sha(input.bytes),exportVerification,
    analysis:{candidateCount:report.products.length,candidateHash:sha(JSON.stringify(report.products.map(p=>[p.id,p.imageHash,p.category,p.price,p.observedAt]))),revision:input.data.localRevision||0,source,reviewedVisualProducts:Object.keys(traitsById).length,additionalAiCalls:0,productionWrites:0},
    tasteReport,recommendationsByProfile:recommendForProfiles(report.products,input.data,{now,traitsById,legacyCounter:report.comparison?.legacyCounter||0})};
  return output;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length>4)throw Error('USE_INPUT_AND_OPTIONAL_EXPORT_ONLY');
  const result=await analyzeLocalTaste({...(process.argv[2]?{inputPath:path.resolve(process.argv[2])}:{}),...(process.argv[3]?{exportPath:path.resolve(process.argv[3])}:{})});
  const directory=path.join(root,'.test-temp/value-taste');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'analysis.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({inputUnchanged:result.inputUnchanged,exportVerification:result.exportVerification,counts:result.tasteReport.counts,sharedPositive:result.tasteReport.common.liked.length,sharedNegative:result.tasteReport.common.disliked.length,differences:result.tasteReport.differences.length,source:result.analysis.source.http,output:'.test-temp/value-taste/analysis.json',additionalAiCalls:0,productionWrites:0}));
}
