// Independent LOCAL security fixtures. No official signing key, genuine
// Telegram-account success, remote user or network request is fabricated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import staging,{PUBLIC_BOT_ID,assertStaging,verifyDatabase} from './staging_worker.mjs';
import {MAIN_BOT_ID,ownerPreviewEnabled,ownerPreviewRoute,stagingAdminUser} from './staging_owner.mjs';
import {verifyTelegramSignature,telegramPublicUser} from './telegram_signature.mjs';
import {STAGING_BUDGET_SCHEMA} from './staging_budget.mjs';
import {LocalD1} from './local_d1.mjs';

const DBID='11111111-1111-4111-8111-111111111111',OWNER='12345678',NOW=Math.floor(Date.now()/1000);
const safe=()=>({STYLE_STAGING:'1',FEATURE_PREVIEW:'1',PUBLIC_BOT_ID,STYLE_STAGING_DB_ID:DBID});
const owner=()=>({...safe(),STAGING_OWNER_PREVIEW:'1',MINIAPP_ADMIN_ID:OWNER});
async function signedFixture(botId=PUBLIC_BOT_ID,id=Number(OWNER)){
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),fields=new URLSearchParams({auth_date:String(NOW),user:JSON.stringify({id}),query_id:'LOCAL_UNIT_FIXTURE'});
  const check=botId+':WebAppData\n'+[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>key+'='+value).join('\n');
  const signature=await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(check));
  fields.set('signature',Buffer.from(signature).toString('base64url'));fields.set('hash','f'.repeat(64));return {raw:fields.toString(),key:keys.publicKey};
}
test('owner preview requires an explicit flag and a canonical positive runtime owner ID',()=>{
  assert.equal(ownerPreviewEnabled(safe()),false);assert.equal(ownerPreviewEnabled(owner()),true);
  for(const value of [undefined,'','0','00000','00001','-12345678','123.45','1e8','123456789012345','12345678x'])assert.equal(ownerPreviewEnabled({...owner(),MINIAPP_ADMIN_ID:value}),false,String(value));
  for(const flag of [undefined,'0','true',true])assert.equal(ownerPreviewEnabled({...owner(),STAGING_OWNER_PREVIEW:flag}),false,String(flag));
  assert.throws(()=>assertStaging({...owner(),MINIAPP_ADMIN_ID:'00000'}));
});
test('owner route allowlist has exact paths and methods, no native admin or background entrypoint',()=>{
  const valid=[['/api/admin/superfind','GET'],['/api/admin/superfind/settings','PUT'],['/api/admin/superfind/decision','POST'],['/api/admin/superfind/refresh','POST'],['/api/admin/superfind/job','GET']];
  for(const [path,method] of valid){assert.equal(ownerPreviewRoute(path,method),true);for(const wrong of ['GET','PUT','POST','DELETE','PATCH','HEAD'].filter(m=>m!==method))assert.equal(ownerPreviewRoute(path,wrong),false,path+' '+wrong);}
  for(const path of ['/api/admin/superfind/publish','/api/admin/superfind/','/api/admin/superfinder','/api/admin/overview','/api/scheduler/tick','/telegram/main/webhook','/__style-background/superfind'])for(const method of ['GET','POST'])assert.equal(ownerPreviewRoute(path,method),false,path);
});
test('Ed25519 verifies the exact bot binding; negative technical fixture IDs can never log in',async()=>{
  const main=await signedFixture(MAIN_BOT_ID),pub=await signedFixture(PUBLIC_BOT_ID),negative=await signedFixture(PUBLIC_BOT_ID,-42);
  assert.equal(await verifyTelegramSignature(main.raw,MAIN_BOT_ID,main.key,NOW),Number(OWNER));
  await assert.rejects(verifyTelegramSignature(main.raw,PUBLIC_BOT_ID,main.key,NOW));
  assert.equal(await verifyTelegramSignature(pub.raw,PUBLIC_BOT_ID,pub.key,NOW),Number(OWNER));
  await assert.rejects(verifyTelegramSignature(pub.raw,MAIN_BOT_ID,pub.key,NOW));
  await assert.rejects(verifyTelegramSignature(negative.raw,PUBLIC_BOT_ID,negative.key,NOW),/TELEGRAM_USER_INVALID/);
  // These self-signed unit fixtures MUST fail the official production key.
  await assert.rejects(telegramPublicUser(pub.raw,PUBLIC_BOT_ID));await assert.rejects(stagingAdminUser(main.raw,owner()));
  await assert.rejects(stagingAdminUser(main.raw,safe()),/OWNER_PREVIEW_DISABLED/);
});
test('signed public-bot unit fixture and forged identity cannot touch staging D1 or owner APIs',async()=>{
  const {raw}=await signedFixture();let queries=0;const env={...owner(),DB:{prepare(){queries++;throw Error('MUST_NOT_TOUCH_D1');}}};
  for(const session of [raw,'user_id='+OWNER,'','forged']){
    const req=path=>new Request('https://stage.test'+path,{headers:{'X-Telegram-Init-Data':session}});
    for(const path of ['/api/style/me','/api/style/feed','/api/me','/api/admin/superfind']){const r=await staging.fetch(req(path),env);assert.equal(r.status,401,path);assert.equal(r.headers.get('X-Style-D1-Queries'),'0');}
  }
  assert.equal(queries,0);
});
test('all native admin/scheduler/webhook and internal accounting URLs remain denied with owner preview enabled',async()=>{
  let queries=0;const env={...owner(),DB:{prepare(){queries++;throw Error('MUST_NOT_TOUCH_D1');}}};
  for(const path of ['/admin','/api/admin/overview','/api/admin/products','/api/admin/superfind/publish','/api/scheduler/tick','/api/sync','/telegram/main/webhook','/telegram/webhook','/preview/session','/__style-background/superfind']){
    for(const method of ['GET','POST'])assert.equal((await staging.fetch(new Request('https://stage.test'+path,{method}),env)).status,403,path+' '+method);
  }
  assert.equal(queries,0);assert.equal(staging.scheduled,undefined);
});
test('transient canary read failure is retried, not cached forever in a warm isolate',async()=>{
  let queries=0;const db={prepare(){return {async first(){queries++;if(queries===1)throw Error('LOCAL_TRANSIENT_FIXTURE');return {value:DBID};}};}},env={...safe(),DB:db};
  await assert.rejects(verifyDatabase(env),/LOCAL_TRANSIENT_FIXTURE/);await verifyDatabase(env);await verifyDatabase(env);assert.equal(queries,2);
});
test('canary mismatch remains fail closed but a corrected staging binding can recover',async()=>{
  let queries=0,canary='wrong';const db={prepare(){return {async first(){queries++;return {value:canary};}};}},env={...safe(),DB:db};
  await assert.rejects(verifyDatabase(env),/CANARY_MISMATCH/);canary=DBID;await verifyDatabase(env);assert.equal(queries,2);
});
test('budget admission on a misbound actual database cannot write even its preexisting ledger',async()=>{
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));db.exec(STAGING_BUDGET_SCHEMA);
  db.sqlite.prepare("INSERT INTO feature_meta VALUES('style_staging_database','WRONG_DATABASE')").run();
  const day=new Date().toISOString().slice(0,10);db.sqlite.prepare('INSERT INTO stage_request_budget VALUES(?,?,?)').run(day,77,8);
  try{const r=await staging.fetch(new Request('https://stage.test/api/health'),{...safe(),DB:db});assert.ok([429,503].includes(r.status));
    assert.deepEqual({...db.sqlite.prepare('SELECT reads,writes FROM stage_request_budget WHERE day=?').get(day)},{reads:77,writes:8});
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_accounts').get().n,0);
    assert.ok(db.queries.every(row=>row.changed===undefined||row.changed===0),'A misbound database was changed');
  }finally{db.close();}
});
