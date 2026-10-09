// Runs only in the existing managed Workers Builds preview job. Uses its
// deployment credential in memory, never the old WB Vision AI token.
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const STAGING_DB_NAME='wb-finds-visual-staging';
export const ACCOUNT='a4f7cbd9ad379d4b18087b99e9839205';
const productionDB='d73d252d-3948-425b-b7c3-b65d0f5c6e5f';
const validID=id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id||'')&&id!==productionDB;

export function requireStagingBuild(env){
  if(env.WORKERS_CI!=='1'||env.WORKERS_CI_BRANCH!=='codex/visual-enrichment-v2')throw new Error('Use the existing managed preview build on codex/visual-enrichment-v2 only');
  if(!env.CLOUDFLARE_API_TOKEN)throw new Error('Existing managed build credential unavailable; no new token or login attempted');
}
export async function getStagingDatabase(api){
  const databases=await api('GET','/d1/database?per_page=100');
  if(!Array.isArray(databases)||databases.length>=100)throw new Error('D1 inventory cannot be safely resolved in one bounded request');
  const matches=databases.filter(db=>db.name===STAGING_DB_NAME);
  if(matches.length>1)throw new Error('Ambiguous staging database; no resource changed');
  const database=matches[0]||await api('POST','/d1/database',{name:STAGING_DB_NAME});
  if(database.name!==STAGING_DB_NAME||!validID(database.uuid))throw new Error('Separate staging D1 identity required; production refused');
  return database.uuid;
}
export function requireVersionUrls(settings){
  if(settings?.previews_enabled!==true)throw new Error('Enable Version URLs for this Worker before staging; no production deployment or setting changed');
}
export function uploadReceipt(text){
  const rows=text.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const row=rows.findLast(value=>value.type==='version-upload');
  if(!row||!/^[a-f0-9-]{36}$/.test(row.version_id||'')||!/^https:\/\/[a-f0-9]{8}-wb-finds-miniapp\.valeramyakishev000\.workers\.dev$/.test(row.preview_url||''))throw new Error('Staging version URL unavailable; production not deployed');
  return {version_id:row.version_id,preview_url:row.preview_url};
}
export function safeBuildError(error){
  const message=error?.message||'';
  const allowed=new Set([
    'Use the existing managed preview build on codex/visual-enrichment-v2 only',
    'Existing managed build credential unavailable; no new token or login attempted',
    'D1 inventory cannot be safely resolved in one bounded request',
    'Ambiguous staging database; no resource changed',
    'Separate staging D1 identity required; production refused',
    'D1 transport failed; no retry attempted',
    'D1 response could not be safely decoded',
    'Staging version upload failed; requires Account → Workers Scripts Edit; production not deployed',
    'Staging version URL unavailable; production not deployed',
    'Staging health could not be verified; no retry attempted; production not deployed',
    'Enable Version URLs for this Worker before staging; no production deployment or setting changed'
  ]);
  return allowed.has(message)||/^(?:D1 (?:list|create) HTTP [1-5]\d{2}; required Account → D1 (?:Read\/Edit|Edit)|Version URL settings HTTP [1-5]\d{2}; required Account → Workers Scripts Edit)$/.test(message)?message:'Staging bootstrap failed; no credential or raw provider error printed';
}
async function main(){
  requireStagingBuild(process.env);
  const token=process.env.CLOUDFLARE_API_TOKEN;
  const api=async(method,path,body)=>{
    const operation=method==='GET'?'list':'create';let response;
    try{response=await fetch('https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new Error('D1 transport failed; no retry attempted');}
    let result;try{result=await response.json();}catch{throw new Error('D1 response could not be safely decoded');}
    if(!response.ok||result.success!==true)throw new Error(path.startsWith('/workers/')?'Version URL settings HTTP '+response.status+'; required Account → Workers Scripts Edit':'D1 '+operation+' HTTP '+response.status+'; required Account → D1 '+(method==='GET'?'Read/Edit':'Edit'));
    return result.result;
  };
  requireVersionUrls(await api('GET','/workers/scripts/wb-finds-miniapp/subdomain'));
  const database_id=await getStagingDatabase(api);
  process.env.VISUAL_STAGING_DB_ID=database_id;
  await import('./prepare-visual-staging.mjs');
  const outputPath=resolve('.test-temp/visual-staging-upload.jsonl');await writeFile(outputPath,'');
  const uploaded=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','versions','upload','--config','.test-temp/visual-staging/wrangler.jsonc','--preview-alias','visual-stage'],{encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error',WRANGLER_LOG_SANITIZE:'true',WRANGLER_OUTPUT_FILE_PATH:outputPath}});
  // Keep CLI output private. Return only an allowlisted preview URL/UUID.
  if(uploaded.error||uploaded.status!==0)throw new Error('Staging version upload failed; requires Account → Workers Scripts Edit; production not deployed');
  const {version_id,preview_url}=uploadReceipt(await readFile(outputPath,'utf8'));
  let health;try{
    const response=await fetch(preview_url+'/api/health',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error();health=await response.json();
    if(health.staging!==true||health.scheduled!==false||health.deployment_id!==version_id)throw new Error();
  }catch{throw new Error('Staging health could not be verified; no retry attempted; production not deployed');}
  const receipt={database_name:STAGING_DB_NAME,database_id,preview_url,deployment_id:health.deployment_id,production_deployed:false};
  await mkdir('.test-temp',{recursive:true});await writeFile('.test-temp/visual-staging-bootstrap.json',JSON.stringify(receipt,null,2)+'\n');
  console.log('VISUAL_STAGING_BOOTSTRAP',JSON.stringify(receipt));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(safeBuildError(error));process.exitCode=1;});
