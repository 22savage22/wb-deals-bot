// Offline release preparation only. No auth, requests, DB mutation or deployment.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {PASSIVE_SCHEMA,PASSIVE_LIMITS} from './passive_store.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const ACCOUNT='a4f7cbd9ad379d4b18087b99e9839205';
const PROTECTED=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','43861c0c-aa50-4e5e-9014-7b36bd319e5b']);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v)&&!PROTECTED.has(v);
const safe=v=>"'"+String(v).replaceAll("'","''")+"'";
export function passiveReleasePlan({databaseId,stagingDatabaseId,stagingCollectorDatabaseId,runId,startedAt,expiresAt}={}){
 if(![databaseId,stagingDatabaseId,stagingCollectorDatabaseId].every(uuid)||new Set([databaseId,stagingDatabaseId,stagingCollectorDatabaseId]).size!==3)throw Error('THREE_SEPARATE_APPROVED_PRICE_DATABASES_REQUIRED');
 if(typeof runId!=='string'||!/^price_[a-zA-Z0-9_-]{8,80}$/.test(runId))throw Error('EXPLICIT_PRICE_RUN_REQUIRED');
 if(!Number.isSafeInteger(startedAt)||!Number.isSafeInteger(expiresAt)||startedAt<1e11||expiresAt<=startedAt||expiresAt-startedAt>86400000)throw Error('BOUNDED_REVIEWED_RUN_REQUIRED');
 const nonce=randomUUID(),day=new Date(startedAt).toISOString().slice(0,10),reserve=PASSIVE_LIMITS.startReserve;
 const admitted=`EXISTS(SELECT 1 FROM passive_write_budget WHERE day=${safe(day)} AND admission_nonce=${safe(nonce)})`;
 // A new isolated database needs no historical cleanup. This explicit operator
 // bootstrap keeps the full reservation; runtime capture settles its own writes.
 const startSQL=`-- RUN ONLY AFTER separate owner approval; never on main/Visual/MyStyle D1.\nINSERT OR IGNORE INTO passive_write_budget(day) VALUES(${safe(day)});\nUPDATE passive_write_budget SET reserved_writes=reserved_writes+${reserve},admission_nonce=${safe(nonce)} WHERE day=${safe(day)} AND meter_state='known' AND reserved_writes+${reserve}<=2980 AND NOT EXISTS(SELECT 1 FROM passive_runs WHERE run_id=${safe(runId)}) AND NOT EXISTS(SELECT 1 FROM passive_control c JOIN passive_runs r ON r.run_id=c.active_run_id WHERE c.id=1 AND r.status='active' AND r.expires_at>${startedAt});\nINSERT OR IGNORE INTO passive_runs(run_id,started_at,expires_at,status,admission_nonce) SELECT ${safe(runId)},${startedAt},${expiresAt},'active',${safe(nonce)} WHERE ${admitted} AND (SELECT run_rows FROM passive_stats WHERE id=1)<28;\nUPDATE passive_control SET active_run_id=${safe(runId)} WHERE id=1 AND EXISTS(SELECT 1 FROM passive_runs WHERE run_id=${safe(runId)} AND admission_nonce=${safe(nonce)});\nSELECT run_id,status,response_count,started_at,expires_at FROM passive_runs WHERE run_id=${safe(runId)};\n`;
 const common={account_id:ACCOUNT,compatibility_date:'2026-09-01',workers_dev:false,preview_urls:false,routes:[],send_metrics:false,triggers:{crons:[]},observability:{enabled:false}};
 const flags={PRICE_OBSERVATION_RUN_ID:runId,PRICE_OBSERVATION_STARTED_AT:String(startedAt),PRICE_OBSERVATION_EXPIRES_AT:String(expiresAt)};
 const collector={...common,name:'wb-finds-price-observer',main:'./collector-entry.mjs',d1_databases:[{binding:'PRICE_DB',database_name:'wb-finds-price-audit',database_id:databaseId}],vars:{PRICE_CAPTURE_ENABLED:'0',PRICE_PASSIVE_ENABLED:'false',PRICE_ISOLATED:'true',PRICE_DATABASE_ID:databaseId,PRICE_OBSERVATION_RUN_ID:runId}};
 const stagingCollector={...collector,name:'wb-finds-price-observer-staging',main:'./staging-collector-entry.mjs',d1_databases:[{binding:'PRICE_DB',database_name:'wb-finds-price-audit-staging',database_id:stagingCollectorDatabaseId}],vars:{...collector.vars,PRICE_DATABASE_ID:stagingCollectorDatabaseId}};
 const staging={...common,name:'wb-finds-price-fixture-staging',main:path.join(ROOT,'miniapp/prices/passive_staging_runtime.mjs'),d1_databases:[{binding:'DB',database_name:'wb-finds-price-fixture-staging',database_id:stagingDatabaseId}],services:[{binding:'PRICE_OBSERVER',service:stagingCollector.name}],vars:{...flags,PRICE_LOCAL_STAGING:'1',PRICE_OBSERVATION_ENABLED:'0',SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:fixture-passive-price',MINIAPP_BOT_USERNAME:'fixture_bot'}};
 const entry=id=>`import {createPassivePriceWorker} from ${JSON.stringify(path.join(ROOT,'miniapp/prices/passive_worker.mjs').replaceAll('\\','/'))};\nexport default createPassivePriceWorker({approvedDatabaseId:${JSON.stringify(id)}});\n`;
 return {collector,stagingCollector,staging,startSQL,collectorEntry:entry(databaseId),stagingCollectorEntry:entry(stagingCollectorDatabaseId),
  productionFragment:{services:[{binding:'PRICE_OBSERVER',service:collector.name}],vars:{...flags,PRICE_OBSERVATION_ENABLED:'0'}},
  migration:PASSIVE_SCHEMA+'\n',approvalRequired:true,deployed:false,additionalWBRequests:0,
  gates:['account_free_plan_and_all_database_usage','dedicated_database_identity_and_schema','isolated_remote_staging_and_cpu','current_worker_version_and_main_D1_backup_bookmark','owner_production_and_observation_approval']};
}
export async function preparePassive(options,{out=path.join(ROOT,'.test-temp/passive-release')}={}){
 const plan=passiveReleasePlan(options);await mkdir(out,{recursive:true});
 const files={'collector-entry.mjs':plan.collectorEntry,'staging-collector-entry.mjs':plan.stagingCollectorEntry,'collector.wrangler.json':JSON.stringify(plan.collector,null,2),'staging-collector.wrangler.json':JSON.stringify(plan.stagingCollector,null,2),'staging.wrangler.json':JSON.stringify(plan.staging,null,2),'production-fragment.OFF.json':JSON.stringify(plan.productionFragment,null,2),'migration.sql':plan.migration,'reviewed-start.DO-NOT-RUN.sql':plan.startSQL,'release-gates.json':JSON.stringify({gates:plan.gates,approvalRequired:true,deployed:false},null,2)};
 for(const [name,content] of Object.entries(files))await writeFile(path.join(out,name),content,{flag:'wx'});
 return {out,files:Object.keys(files),approvalRequired:true,deployed:false,additionalWBRequests:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [databaseId,stagingDatabaseId,stagingCollectorDatabaseId,runId,started,expires]=process.argv.slice(2);
 console.log(JSON.stringify(await preparePassive({databaseId,stagingDatabaseId,stagingCollectorDatabaseId,runId,startedAt:Number(started),expiresAt:Number(expires)})));
}
