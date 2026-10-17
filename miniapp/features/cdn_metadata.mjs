// Bounded operator enrichment from the official photo card origin, not Vision.
// Never infers cut/style/color or price from a title. No proxy/cookie/block bypass.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {metadataURL,cardAudience} from './catalogue_source.mjs';
export {metadataURL,cardAudience};
export async function collectMetadata(products,{fetcher=fetch,limit=80}={}){
  if(!Array.isArray(products)||products.length>120||!Number.isSafeInteger(limit)||limit<0||limit>80)throw Error('METADATA_BATCH_LIMIT');
  const entries={},errors=[];
  for(const p of products.slice(0,limit)){
    let url;try{url=metadataURL(p.image,p.id);}catch{errors.push({id:p.id,error:'UNTRUSTED_SOURCE'});continue;}
    try{
      const r=await fetcher(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(8000)});
      if(!r.ok){errors.push({id:p.id,status:r.status});if([403,429].includes(r.status))break;continue;}
      const card=await r.json(),audience=cardAudience(card,p.id);
      if(Number(card.nm_id)!==p.id){errors.push({id:p.id,error:'NMID_MISMATCH'});continue;}
      entries[p.id]={audience:audience??'unknown',category:typeof card.subj_name==='string'?card.subj_name.slice(0,100):null,source:'official_wb_card_metadata',sourceURL:url,observedAt:Date.now(),imageHash:p.imageHash};
    }catch{errors.push({id:p.id,error:'REQUEST_FAILED'});if(errors.filter(e=>e.error==='REQUEST_FAILED').length>=2)break;}
  }
  return {entries,errors,attempted:Object.keys(entries).length+errors.length,aiCalls:0,priceEvidence:'NONE'};
}
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--collect')throw Error('EXPLICIT_COLLECT_FLAG_REQUIRED');
  const products=[];for(const group of ['shadow-20261011','shadow-prospective-20261011'])for(const p of JSON.parse(await fs.readFile(path.join(ROOT,'docs',group,'report.json'),'utf8')).products)if(!products.some(q=>q.id===p.id))products.push(p);
  const out=await collectMetadata(products),file=path.join(ROOT,'.test-temp/style-staging/cdn-metadata.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(out,null,2));
  console.log(JSON.stringify({source:'official_wb_card_metadata',attempted:out.attempted,confirmed:Object.values(out.entries).filter(r=>r.audience!=='unknown').length,unknown:Object.values(out.entries).filter(r=>r.audience==='unknown').length,errors:out.errors,aiCalls:0,currentPricesConfirmed:0}));
}
