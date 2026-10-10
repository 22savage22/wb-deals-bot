// Isolated staging only. Never reads a global token or deploys production.
// Default is dry-run. --deploy creates/updates the named staging Worker;
// --test additionally runs the fixed sample after a fresh free-budget check.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {verifyUploadedBindings,STAGING_DB_ID,ACCOUNT} from './bootstrap-visual-staging.mjs';

export const WORKER='wb-finds-visual-staging';
const CONFIG='.test-temp/visual-staging-standalone/wrangler.jsonc';
const URL_BASE='https://'+WORKER+'.valeramyakishev000.workers.dev';
export function verifyStandaloneBindings(version,expectedId){
  verifyUploadedBindings(version,expectedId);
  const allowed=new Set(['DB','AI','CF_VERSION','VISUAL_STAGING','VISUAL_STAGING_DB_ID','MINIAPP_SYNC_KEY']);
  const value=version.resources.bindings;
  const bindings=Array.isArray(value)?value:Object.entries(value||{}).map(([name,b])=>({name,...b}));
  if(bindings.some(b=>!allowed.has(b.name)||b.type==='secret_text'&&b.name!=='MINIAPP_SYNC_KEY'))throw new Error('Standalone staging has an unexpected binding or credential; stopped safely');
}
export function isolatedEnvironment(parent=process.env){
  const env={...parent,XDG_CONFIG_HOME:resolve('.test-temp/config'),TEMP:resolve('.test-temp'),TMP:resolve('.test-temp'),WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG_PATH:resolve('.test-temp/visual-standalone.log')};
  for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL','MINIAPP_SYNC_KEY','TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','WRANGLER_API_ENVIRONMENT','WRANGLER_OUTPUT_FILE_PATH'])delete env[key];
  return env;
}
function cli(args,env,input){
  return spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args,'--config',CONFIG],{env,input,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
}
function requireCLI(result,operation){
  if(result.error||result.status!==0)throw new Error(operation+' failed; credential and raw CLI output withheld');
  return result.stdout;
}
function jsonOutput(result,operation){
  const text=requireCLI(result,operation);try{return JSON.parse(text);}catch{throw new Error(operation+' returned unrecognized JSON; stopped safely');}
}
export function absentWorker(result){
  // Only the provider's specific unknown-script error permits creation.
  return result.status!==0&&/\b10007\b/.test((result.stdout||'')+(result.stderr||''));
}
async function main(){
  const deploy=process.argv.includes('--deploy'),test=process.argv.includes('--test');
  if(test&&!deploy)throw new Error('--test requires an explicit isolated --deploy');
  const branch=spawnSync('git',['branch','--show-current'],{encoding:'utf8',timeout:10000});
  if(branch.status!==0||branch.stdout.trim()!=='codex/visual-staging-agent-20261010')throw new Error('Own isolated staging branch required');
  const env=isolatedEnvironment();await mkdir(env.TEMP,{recursive:true});
  requireCLI(spawnSync(process.execPath,['miniapp/cloudflare/prepare-visual-staging.mjs','--standalone'],{env,encoding:'utf8',timeout:10000}),'Staging config preparation');
  if(!deploy){requireCLI(cli(['deploy','--dry-run','--outdir','.test-temp/visual-standalone-build'],env),'Staging dry-run');console.log('STAGING_DRY_RUN_OK: native AI, pinned staging D1, fetch only');return;}
  const listed=cli(['versions','list','--json'],env);
  if(!absentWorker(listed)){
    const versions=jsonOutput(listed,'Staging version inventory');
    for(const version of versions.slice(0,10))verifyStandaloneBindings(jsonOutput(cli(['versions','view',version.id,'--json'],env),'Existing staging bindings'),version.id);
  }
  requireCLI(cli(['deploy'],env),'Isolated staging deployment');
  // Fresh key is passed over stdin and child environment only. It is not an
  // API token, not the production sync secret, and is never printed/written.
  let key=randomBytes(32).toString('base64url');
  try{
    requireCLI(cli(['secret','put','MINIAPP_SYNC_KEY'],env,key+'\n'),'Staging authentication secret');
    const response=await fetch(URL_BASE+'/api/health',{redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('Staging health failed');const health=await response.json();
    if(health.staging!==true||health.scheduled!==false||health.database_id!==STAGING_DB_ID||!health.deployment_id)throw new Error('Staging health isolation failed');
    verifyStandaloneBindings(jsonOutput(cli(['versions','view',health.deployment_id,'--json'],env),'Uploaded staging bindings'),health.deployment_id);
    const receipt={worker:WORKER,account_id:ACCOUNT,database_id:STAGING_DB_ID,deployment_id:health.deployment_id,url:URL_BASE,production_deployed:false,ai_calls:0};
    await writeFile('.test-temp/visual-staging-bootstrap.json',JSON.stringify(receipt,null,2)+'\n');
    console.log('STAGING_DEPLOY_OK',JSON.stringify(receipt));
    if(test){
      const result=spawnSync('python',['-B','miniapp/visual_staging_check.py'],{env:{...env,MINIAPP_SYNC_KEY:key,VISUAL_STAGING_URL:URL_BASE},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
      // Runner output is deliberately safe and contains only public profiles.
      if(result.stdout)process.stdout.write(result.stdout);
      if(result.error||result.status!==0)throw new Error('Staging real-data test incomplete; inspect safe receipt before retry');
    }
  }finally{key='';}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error instanceof TypeError?'Staging transport failed; no blind retry':error.message);process.exitCode=1;});
