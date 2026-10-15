// Explicit unit fixtures, NOT proof of real Telegram-account testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {verifyTelegramSignature,telegramPublicUser} from './telegram_signature.mjs';
import staging,{PUBLIC_BOT_ID,assertStaging} from './staging_worker.mjs';
import {configuration} from './prepare_staging.mjs';
import {createWorker} from '../cloudflare/worker.mjs';
import {LocalD1} from './local_d1.mjs';
import {forgetSubscriber} from './store.mjs';
import {verifyVersion} from './staging_tool.mjs';
const NOW=Math.floor(Date.now()/1000),encoder=new TextEncoder();
async function signed(id=101,patch={},bot=PUBLIC_BOT_ID){
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const fields=new URLSearchParams({auth_date:String(NOW),user:JSON.stringify({id}),query_id:'unit-fixture',...patch});
  const check=bot+':WebAppData\n'+[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const signature=await crypto.subtle.sign('Ed25519',keys.privateKey,encoder.encode(check));
  fields.set('signature',Buffer.from(signature).toString('base64url'));fields.set('hash','a'.repeat(64));return {raw:fields.toString(),key:keys.publicKey};
}
test('official Ed25519 construction rejects altered identity/bot/date/duplicate/foreign key',async()=>{
  const {raw,key}=await signed();assert.equal(await verifyTelegramSignature(raw,PUBLIC_BOT_ID,key,NOW),101);
  for(const changed of [raw.replace('%3A101','%3A102'),raw+'&user=%7B%22id%22%3A102%7D',raw.replace('signature=','signature=x')])await assert.rejects(verifyTelegramSignature(changed,PUBLIC_BOT_ID,key,NOW));
  await assert.rejects(verifyTelegramSignature(raw,'123456789',key,NOW));await assert.rejects(verifyTelegramSignature(raw,PUBLIC_BOT_ID,key,NOW+3601));
  await assert.rejects(telegramPublicUser(raw,PUBLIC_BOT_ID));
});
test('staging has no Cron and rejects privileged bindings and protected database IDs',()=>{
  const safe={STYLE_STAGING:'1',PUBLIC_BOT_ID,STYLE_STAGING_DB_ID:'11111111-1111-4111-8111-111111111111'};assert.doesNotThrow(()=>assertStaging(safe));assert.equal(staging.scheduled,undefined);
  for(const key of ['AI','TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','MINIAPP_SYNC_KEY','SCHEDULER_DRIVER'])assert.throws(()=>assertStaging({...safe,[key]:'forbidden'}));
  for(const id of ['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20']){assert.throws(()=>configuration(id));assert.throws(()=>assertStaging({...safe,STYLE_STAGING_DB_ID:id}));}
  const c=configuration(safe.STYLE_STAGING_DB_ID);assert.deepEqual(c.triggers.crons,[]);assert.equal(c.ai,undefined);assert.equal(c.services,undefined);
});
test('all administrative/webhook/scheduler/sync/session paths denied before D1',async()=>{
  const env={STYLE_STAGING:'1',FEATURE_PREVIEW:'1',PUBLIC_BOT_ID,STYLE_STAGING_DB_ID:'11111111-1111-4111-8111-111111111111',DB:{prepare(){throw Error('MUST_NOT_READ');}}};
  for(const path of ['/admin','/api/admin/overview','/api/admin/superfind','/telegram/main/webhook','/telegram/webhook','/api/sync','/api/scheduler/tick','/preview/session','/superfind'])assert.equal((await staging.fetch(new Request('https://stage.test'+path),env,{})).status,403,path);
  assert.equal((await staging.fetch(new Request('https://stage.test/api/style/me',{headers:{'X-Telegram-Init-Data':'forged'}}),env,{})).status,401);
});
test('public API composition keeps favorites/preferences/outfits auth and does not grant owner access',async()=>{
  const db=new LocalD1();db.exec(await fs.readFile(new URL('../cloudflare/schema.sql',import.meta.url),'utf8'));
  db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const core=createWorker(async raw=>{if(raw!=='unit-signed-session')throw Error('bad');return 101;});
  try{
    const req=(url,method='GET',data)=>new Request('https://stage.test'+url,{method,headers:{'X-Telegram-Init-Data':'unit-signed-session','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
    assert.equal((await core.fetch(req('/api/me'),{DB:db},{})).status,200);
    assert.equal((await core.fetch(req('/api/preferences','PUT',{budget:5000,occasion:'office'}),{DB:db},{})).status,200);
    assert.equal((await core.fetch(req('/api/admin/overview'),{DB:db,MINIAPP_ADMIN_ID:101},{})).status,401);
    const me=await (await core.fetch(req('/api/me'),{DB:db},{})).json();assert.equal(me.preferences.occasion,'office');
  }finally{db.close();}
});
test('privacy deletion is scoped, persistent and stale requests cannot restore erased data',async()=>{
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  try{for(const uid of [101,202]){db.sqlite.prepare('INSERT INTO style_accounts(user_id,version) VALUES(?,3)').run(uid);db.sqlite.prepare("INSERT INTO style_votes VALUES(?,1,'like','{}',1)").run(uid);db.sqlite.prepare('INSERT INTO style_saved VALUES(?,1,1)').run(uid);}
    await forgetSubscriber(db,101);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=101').get().n,0);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM style_saved WHERE user_id=101').get().n,0);assert.equal(db.sqlite.prepare('SELECT version FROM style_accounts WHERE user_id=101').get().version,4);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=202').get().n,1);
  }finally{db.close();}
});
test('uploaded version attestation rejects a cron, production binding or hidden credential',()=>{
  const id='11111111-1111-4111-8111-111111111111',v={resources:{bindings:[{name:'DB',type:'d1',id}],script:{handlers:['fetch']}}};assert.doesNotThrow(()=>verifyVersion(v,id));
  for(const binding of [{name:'AI',type:'ai'},{name:'TG_BOT_TOKEN',type:'secret_text'},{name:'PRODUCTION',type:'service'}])assert.throws(()=>verifyVersion({resources:{...v.resources,bindings:[...v.resources.bindings,binding]}},id));
  assert.throws(()=>verifyVersion({resources:{...v.resources,script:{handlers:['fetch','scheduled']}}},id));
});
