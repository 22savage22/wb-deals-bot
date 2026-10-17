// Operator-only live proof, exact staging. Reads PUBLIC native catalogue once;
// does not query private production D1 or change any production configuration.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {execute,ROOT,DBID} from './staging_ops.mjs';
import {collectNewCatalogueProducts} from './catalogue_source.mjs';
import {ingestVerifiedProducts} from './catalogue_adapter.mjs';
const literal=v=>v===null?'NULL':typeof v==='number'&&Number.isFinite(v)?String(v):typeof v==='string'?"'"+v.replaceAll("'","''")+"'":(()=>{throw Error('SQL_BIND_TYPE');})();
function compiled(sql,args){let i=0;const out=sql.replace(/\?/g,()=>literal(args[i++]));if(i!==args.length)throw Error('SQL_BIND_COUNT');return out.replace(/;\s*$/,'')+';';}
export function remoteStageDB(){
  const costs={queries:0,rows_read:0,rows_written:0},unwrap=results=>{
    for(const r of results){if(r.success===false||!Number.isFinite(r.meta?.rows_read)||!Number.isFinite(r.meta?.rows_written))throw Error('D1_RESULT_NOT_CONFIRMED');costs.queries++;costs.rows_read+=r.meta.rows_read;costs.rows_written+=r.meta.rows_written;}
    return results;
  };
  const statement=(sql,args=[])=>({sql,args,bind(...a){return statement(sql,a);},async all(){return unwrap(await execute(compiled(sql,args)))[0];},async first(){return (await this.all()).results?.[0]??null;},async run(){return this.all();}});
  return {costs,prepare:statement,async batch(items){return unwrap(await execute(items.map(s=>compiled(s.sql,s.args)).join('\n')));}};
}
export async function checkNewCatalogue(){
  const db=remoteStageDB(),canary=await db.prepare("SELECT value FROM feature_meta WHERE key='style_staging_database'").first();
  if(canary?.value!==DBID)throw Error('EXACT_STAGING_CANARY_REQUIRED');
  const known=(await db.prepare('SELECT id FROM feature_catalog ORDER BY id LIMIT 1000').all()).results.map(r=>r.id);
  const response=await fetch('https://wb-finds-miniapp.valeramyakishev000.workers.dev/api/catalog',{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw Error('PUBLIC_CATALOG_UNAVAILABLE');const catalog=await response.json();
  // Slot only proposes candidates, never category/visual proof. Official metadata
  // in collectNewCatalogueProducts must independently confirm fashion eligibility.
  const slots=new Set(),candidates=(catalog.products??[]).filter(p=>{
    if(!Number.isSafeInteger(p.id)||p.id<=0||known.includes(p.id)||!['top','bottom','shoes','bag','accessory','dress'].includes(p.slot)||slots.has(p.slot)||!/^https:\/\/basket-\d{2,3}\.wbbasket\.ru\//.test(p.image??''))return false;
    slots.add(p.slot);return true;
  }).slice(0,3);
  if(candidates.length!==3)throw Error('INSUFFICIENT_NEW_PUBLIC_CANDIDATES');
  const now=Date.now();
  await db.batch(candidates.map(p=>db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at')
    .bind(p.id,JSON.stringify({...p,price:null,priceSource:'unknown',available:null}),Math.floor(now/1000))));
  const found=await collectNewCatalogueProducts(db,candidates.map(p=>p.id),{enabled:true});
  const receipt={scope:'EXACT_STAGING_ONLY',database:DBID,candidates:candidates.map(p=>p.id),source:{...found,entries:undefined},products:[],ingest:null,actualD1:db.costs,productionChanged:false,aiCalls:0};
  if(found.entries.length){
    receipt.ingest=await ingestVerifiedProducts(db,found.entries,{enabled:true});
    const rows=(await db.prepare('SELECT id,data FROM feature_catalog WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(found.entries.map(e=>e.product.id))).all()).results;
    receipt.products=rows.map(r=>{const p=JSON.parse(r.data);return {id:p.id,name:p.name,category:p.category,audience:p.audience,image:p.image,displayImage:p.displayImage,imageHash:p.imageHash,price:p.price,priceSource:p.priceSource,photoVerifiedAt:p.photoVerifiedAt};});
  }
  if(receipt.products.some(p=>known.includes(p.id)))throw Error('NEW_PRODUCT_PROOF_FAILED');
  const file=path.join(ROOT,'.test-temp/style-staging/new-catalogue-proof.json');await fs.writeFile(file,JSON.stringify(receipt,null,2));
  return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--remote-staging')throw Error('EXPLICIT_REMOTE_STAGING_FLAG_REQUIRED');
  checkNewCatalogue().then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('NEW_STAGING_CATALOGUE_NOT_CONFIRMED; no blind retry, credentials withheld');process.exitCode=1;});
}
