// Exact-resource guard for the owner's explicitly authorized staging only.
// No credentials in source/args/output; official Wrangler keyring OAuth is reused.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareStaging,ROOT,OUT,ACCOUNT} from './prepare_staging.mjs';
import {STAGING_WORKER} from './staging_worker.mjs';
const config=path.join(OUT,'wrangler.json');
function cli(args,{json=false}={}){
  const env={...process.env,XDG_CONFIG_HOME:path.join(ROOT,'.test-temp/style-auth'),WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true',TEMP:path.join(ROOT,'.test-temp'),TMP:path.join(ROOT,'.test-temp')};
  for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'])delete env[key];
  const r=spawnSync(process.execPath,[path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),...args,'--config',config],{env,cwd:ROOT,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)throw Error('STAGING_CLI_FAILED: '+args.slice(0,2).join(' ')+' (raw output withheld)');
  if(json)try{return JSON.parse(r.stdout);}catch{throw Error('STAGING_CLI_JSON_INVALID');}return r.stdout;
}
export function verifyVersion(version,id){
  const value=version.resources?.bindings,bindings=Array.isArray(value)?value:Object.entries(value??{}).map(([name,b])=>({name,...b}));
  if(!bindings.length)throw Error('STAGING_BINDINGS_UNAVAILABLE');
  const db=bindings.find(b=>b.name==='DB');if(db?.type!=='d1'||db.id!==id)throw Error('STAGING_DB_BINDING_MISMATCH');
  const allowed=new Set(['DB','ASSETS','CF_VERSION','RATE_LIMITER','STYLE_STAGING','STYLE_STAGING_DB_ID','PUBLIC_BOT_ID','FEATURE_PREVIEW','MINIAPP_BOT_USERNAME']);
  if(bindings.some(b=>!allowed.has(b.name)||['secret_text','ai','service'].includes(b.type)))throw Error('STAGING_UNEXPECTED_BINDING');
  const handlers=version.resources?.script?.handlers;
  if(!Array.isArray(handlers)||handlers.length!==1||handlers[0]!=='fetch')throw Error('STAGING_UNEXPECTED_HANDLER');
}
async function main(){
  const deploy=process.argv.includes('--deploy');await prepareStaging();
  if(!deploy){cli(['deploy','--dry-run','--outdir',path.join(OUT,'bundle')]);console.log('STYLE_STAGING_DRY_RUN_OK: separate entrypoint/assets; no secrets, Cron, AI or Telegram sender');return;}
  const branch=spawnSync('git',['branch','--show-current'],{cwd:ROOT,encoding:'utf8',timeout:5000});
  if(branch.stdout.trim()!=='codex/superfind-my-style-preview-20261014')throw Error('OWN_PR13_BRANCH_REQUIRED');
  const dirty=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:ROOT,encoding:'utf8',timeout:5000});
  if(dirty.status!==0||dirty.stdout.trim())throw Error('CLEAN_COMMITTED_STAGING_SOURCE_REQUIRED');
  let dbs=cli(['d1','list','--json'],{json:true}),db=dbs.find(d=>d.name===STAGING_WORKER);
  if(!db){cli(['d1','create',STAGING_WORKER]);dbs=cli(['d1','list','--json'],{json:true});db=dbs.find(d=>d.name===STAGING_WORKER);}
  const id=db?.uuid;if(!id)throw Error('EXACT_STAGING_DATABASE_NOT_FOUND');await prepareStaging(id);
  // Exact config guards reject both known production and Vision database IDs.
  cli(['d1','execute',STAGING_WORKER,'--remote','--file',path.join(OUT,'seed.sql'),'--yes']);
  cli(['deploy']);const base='https://'+STAGING_WORKER+'.valeramyakishev000.workers.dev';
  const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(20000),redirect:'error'}),health=await response.json();
  if(!response.ok||!health.staging||health.database_id!==id||health.scheduled!==false||health.ai!==false||health.production!==false||!health.version)throw Error('STAGING_HEALTH_ISOLATION_FAILED');
  verifyVersion(cli(['versions','view',health.version,'--json'],{json:true}),id);
  for(const route of ['/api/admin/overview','/api/scheduler/tick','/telegram/main/webhook','/preview/session','/api/style/me']){
    const denied=await fetch(base+route,{signal:AbortSignal.timeout(10000),redirect:'error'});if(![401,403].includes(denied.status))throw Error('STAGING_AUTH_GUARD_FAILED');
  }
  const commit=spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).stdout.trim();
  const receipt={account:ACCOUNT,worker:STAGING_WORKER,database:id,version:health.version,url:base,commit,auth:'TELEGRAM_ED25519',real_accounts_tested:0,production_deployed:false,telegram_sends:0,ai_calls:0};
  await fs.writeFile(path.join(OUT,'deployment.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message.startsWith('STAGING_')||e.message.endsWith('_REQUIRED')||e.message.endsWith('_FOUND')?e.message:'STAGING_OPERATION_FAILED; no blind retry, credentials withheld');process.exitCode=1;});
