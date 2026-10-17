// Offline/operator helpers only. Exact staging D1, official keyring OAuth.
// Never imported by a Worker, no tokens or raw CLI output in receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const STAGE='wb-finds-style-staging',DBID='43861c0c-aa50-4e5e-9014-7b36bd319e5b';
const config=path.join(ROOT,'.test-temp/style-staging/wrangler.json');
export async function stagingCLI(args,{json=true}={}){
  const c=JSON.parse(await fs.readFile(config,'utf8'));
  if(c.name!==STAGE||c.account_id!=='a4f7cbd9ad379d4b18087b99e9839205'||c.d1_databases?.length!==1||c.d1_databases[0].database_id!==DBID||c.d1_databases[0].database_name!==STAGE)throw Error('EXACT_STAGING_CONFIG_REQUIRED');
  const env={...process.env,XDG_CONFIG_HOME:path.join(ROOT,'.test-temp/style-auth'),WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true',TEMP:path.join(ROOT,'.test-temp'),TMP:path.join(ROOT,'.test-temp')};
  for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CLOUDFLARE_EMAIL'])delete env[key];
  const r=spawnSync(process.execPath,[path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),...args,'--config',config,...(json?['--json']:[])],{cwd:ROOT,env,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
  if(r.error||r.status!==0)throw Error('STAGING_OPERATOR_REQUEST_FAILED; raw CLI/credentials withheld, no blind retry');
  if(!json)return;
  try{return JSON.parse(r.stdout);}catch{throw Error('STAGING_OPERATOR_RESULT_INVALID');}
}
export async function execute(sql){return stagingCLI(['d1','execute',STAGE,'--remote','--command',sql]);}
export async function backup(){
  const out=path.join(ROOT,'.test-temp/style-backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  await fs.mkdir(out,{recursive:true});const file=path.join(out,'staging.sql');
  await stagingCLI(['d1','export',STAGE,'--remote','--output',file],{json:false});
  const bytes=await fs.readFile(file),db=new DatabaseSync(':memory:');let integrity,foreignKeys,tables;
  try{db.exec(bytes.toString('utf8'));integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;foreignKeys=db.prepare('PRAGMA foreign_key_check').all().length;tables=db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;}finally{db.close();}
  if(integrity!=='ok'||foreignKeys!==0)throw Error('STAGING_BACKUP_RESTORE_CHECK_FAILED');
  const receipt={scope:'EXACT_STAGING_ONLY',database:DBID,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),integrity,foreignKeys,tables,privateBackupDirectory:out,productionChanged:false};
  await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));return receipt;
}
export async function migrateStaging(){
  const {prepareStaging,OUT}=await import('./prepare_staging.mjs');await prepareStaging(DBID);
  await stagingCLI(['d1','execute',STAGE,'--remote','--file',path.join(OUT,'seed.sql'),'--yes'],{json:false});
  return {scope:'EXACT_STAGING_ONLY',migration:'APPLIED',productionChanged:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!['--backup','--migrate'].includes(process.argv[2]))throw Error('EXPLICIT_STAGING_OPERATION_REQUIRED');
  (process.argv[2]==='--backup'?backup():migrateStaging()).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('STAGING_OPERATOR_NOT_CONFIRMED; no retry or production access');process.exitCode=1;});
}
