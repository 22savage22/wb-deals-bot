// Genuine REMOTE D1 SQL costs, NOT a real Telegram-account/auth acceptance test.
// Traces the actual API/business code locally, replays identical parameterized
// SQL in the exact staging D1 under an inaccessible NEGATIVE technical user.
// No auth bypass/diagnostic HTTP route is deployed. No runtime token is used.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import features from './worker.mjs';import {LocalD1} from './local_d1.mjs';
import {prepareStaging,OUT} from './prepare_staging.mjs';import {withStagingBudget} from './staging_budget.mjs';
import {ADAPTER_SCHEMA} from './catalogue_adapter.mjs';import {signedPreviewData} from './preview_server.mjs';
import {execute,ROOT,DBID} from './staging_ops.mjs';
const UID=10001,REMOTE_UID=-17001317,TEST_DAY='1900-10-17',testKey='LOCAL-ONLY-COST-PROBE-NOT-A-REAL-BOT-TOKEN';
function traced(db){
  const log=[],original=new WeakMap();
  function statement(sql,args=[]){const inner=db.prepare(sql).bind(...args),s={bind(...a){return statement(sql,a);},async all(){log.push({sql,args});return inner.all();},async first(){log.push({sql,args});return inner.first();},async run(){log.push({sql,args});return inner.run();}};original.set(s,{inner,sql,args});return s;}
  return {log,DB:{prepare:statement,async batch(statements){for(const s of statements){const row=original.get(s);log.push({sql:row.sql,args:row.args});}return db.batch(statements.map(s=>original.get(s).inner));}}};
}
function literal(value){
  if(value===null)return 'NULL';if(typeof value==='number'&&Number.isFinite(value))return String(value===UID?REMOTE_UID:value);
  if(typeof value!=='string')throw Error('PROBE_UNSUPPORTED_SQL_BIND');
  const v=/^\d{4}-\d{2}-\d{2}$/.test(value)?TEST_DAY:value;return "'"+v.replaceAll("'","''")+"'";
}
function sqlText({sql,args}){let index=0;const text=sql.replace(/\?/g,()=>literal(args[index++]));if(index!==args.length)throw Error('PROBE_BIND_COUNT');return text.replace(/;\s*$/,'')+';';}
function actualCosts(results){
  if(!Array.isArray(results)||results.some(r=>r.success===false||!Number.isFinite(r.meta?.rows_read)||!Number.isFinite(r.meta?.rows_written)))throw Error('GENUINE_D1_METADATA_REQUIRED');
  return {queries:results.length,rows_read:results.reduce((n,r)=>n+r.meta.rows_read,0),rows_written:results.reduce((n,r)=>n+r.meta.rows_written,0)};
}
async function rowsClear(){const r=await execute(`SELECT (SELECT COUNT(*) FROM style_accounts WHERE user_id=${REMOTE_UID})+(SELECT COUNT(*) FROM style_votes WHERE user_id=${REMOTE_UID})+(SELECT COUNT(*) FROM style_saved WHERE user_id=${REMOTE_UID})+(SELECT COUNT(*) FROM feature_requests WHERE user_id=${REMOTE_UID}) AS n;`);return r[0]?.results?.[0]?.n===0;}
export async function runCostProbe(){
  await prepareStaging(DBID);const db=new LocalD1();db.exec(await fs.readFile(path.join(OUT,'seed.sql'),'utf8'));db.exec(ADAPTER_SCHEMA);
  db.exec('CREATE TABLE IF NOT EXISTS worker_read_budget(day TEXT NOT NULL,lane TEXT NOT NULL,reads INTEGER NOT NULL,writes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,lane));');
  const t=traced(db),env={DB:t.DB,FEATURE_PREVIEW:'1',MINIAPP_BOT_TOKEN:testKey,TG_BOT_TOKEN:'LOCAL-OWNER-ONLY',MINIAPP_ADMIN_ID:'10003',STYLE_STAGING_DB_ID:DBID};
  const auth=await signedPreviewData(UID,testKey),pid=db.sqlite.prepare('SELECT id FROM feature_catalog ORDER BY id LIMIT 1').get().id;
  const report={scope:'GENUINE_REMOTE_D1_SQL_REPLAY_NOT_TELEGRAM_E2E',realTelegramAccountsTested:0,httpSignatureValidation:'LOCAL_FIXTURE_ONLY',database:DBID,productionChanged:false,aiCalls:0,operations:[],cleaned:false};
  let admitted=false;
  try{
    if(!await rowsClear())throw Error('TECHNICAL_USER_ALREADY_EXISTS_DO_NOT_OVERWRITE');
    const cleanDay=await execute(`SELECT (SELECT COUNT(*) FROM feature_budget WHERE day='${TEST_DAY}')+(SELECT COUNT(*) FROM stage_request_budget WHERE day='${TEST_DAY}')+(SELECT COUNT(*) FROM worker_read_budget WHERE day='${TEST_DAY}') AS n;`);
    if(cleanDay[0]?.results?.[0]?.n!==0)throw Error('TECHNICAL_LEDGER_ALREADY_EXISTS_DO_NOT_OVERWRITE');admitted=true;
    const steps=[
      ['open_profile','/api/style/me','GET'],
      ['save_interests','/api/style/filters','PUT',{version:0,requestId:'cost-probe-interests-0001',filters:{audience:'all',groups:[]}}],
      ['load_20_photo_deck','/api/style/feed?mode=learn','GET'],
      ['like','/api/style/vote','POST',{version:1,requestId:'cost-probe-like-0000001',id:pid,action:'like'}],
      ['favorite','/api/style/favorite','POST',{version:2,requestId:'cost-probe-favorite-001',id:pid,saved:true}],
      ['lost_response_same_request_retry','/api/style/favorite','POST',{version:2,requestId:'cost-probe-favorite-001',id:pid,saved:true}],
      ['switch_to_dislike','/api/style/vote','POST',{version:3,requestId:'cost-probe-switch-00001',id:pid,action:'dislike'}],
      ['read_favorites','/api/style/favorites','GET'],
      ['unseen_recommendation_deck','/api/style/feed?mode=recommend','GET'],
      ['delete_own_history_and_favorites','/api/style/history','DELETE',{version:4,requestId:'cost-probe-delete-00001'}],
      ['reopen_deleted_profile','/api/style/me','GET']
    ];
    for(const [name,route,method,data] of steps){
      t.log.length=0;const req=new Request('https://local-probe.invalid'+route,{method,headers:{'X-Telegram-Init-Data':auth,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
      const response=await withStagingBudget(env,req,e=>features.fetch(req,e,{waitUntil(){throw Error('BACKGROUND_NOT_PART_OF_PROBE');}}));
      if(!response.ok)throw Error('LOCAL_TRACE_REQUEST_FAILED_'+response.status);
      const sql=t.log.map(sqlText).join('\n'),actual=actualCosts(await execute(sql));report.operations.push({name,path:route,method,...actual});
    }
    const check=await execute(`SELECT (SELECT version FROM style_accounts WHERE user_id=${REMOTE_UID}) AS revision,(SELECT COUNT(*) FROM style_votes WHERE user_id=${REMOTE_UID}) AS votes,(SELECT COUNT(*) FROM style_saved WHERE user_id=${REMOTE_UID}) AS favorites;`);
    const result=check[0]?.results?.[0];if(result?.revision!==5||result.votes!==0||result.favorites!==0)throw Error('REMOTE_STATE_DID_NOT_MATCH_TRACED_OPERATIONS');
    report.postDeletion={revision:result.revision,votes:0,favorites:0};
  }finally{
    db.close();
    if(admitted){
      await execute(`DELETE FROM style_votes WHERE user_id=${REMOTE_UID};DELETE FROM style_saved WHERE user_id=${REMOTE_UID};DELETE FROM feature_requests WHERE user_id=${REMOTE_UID};DELETE FROM style_accounts WHERE user_id=${REMOTE_UID};DELETE FROM feature_budget WHERE day='${TEST_DAY}';DELETE FROM stage_request_budget WHERE day='${TEST_DAY}';DELETE FROM worker_read_budget WHERE day='${TEST_DAY}';`);
      report.cleaned=await rowsClear();if(!report.cleaned)throw Error('TECHNICAL_PROBE_CLEANUP_NOT_CONFIRMED');
    }
    const out=path.join(ROOT,'.test-temp/style-staging/d1-cost-probe.json');await fs.writeFile(out,JSON.stringify(report,null,2));
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='--remote-staging')throw Error('EXPLICIT_REMOTE_STAGING_FLAG_REQUIRED');
  runCostProbe().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(String(e.message).startsWith('TECHNICAL_')||String(e.message).startsWith('REMOTE_')?e.message:'STAGING_COST_PROBE_NOT_CONFIRMED; raw credentials/CLI withheld');process.exitCode=1;});
}
