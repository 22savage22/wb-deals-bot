// LOCAL cryptographic/SQLite/API fixtures. Not real Telegram accounts, remote
// D1 billing or a subscriber-count/capacity claim. No network or AI calls.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {LocalD1} from './local_d1.mjs';
import {createProductionFeatures} from './production_worker.mjs';
import {hmac} from '../cloudflare/auth.mjs';
import {verifyTelegramSignature,telegramPublicUser} from './telegram_signature.mjs';

const PUBLIC='LOCAL_UNIVERSAL_PUBLIC_FIXTURE_NOT_A_BOT_TOKEN',MAIN='LOCAL_UNIVERSAL_MAIN_FIXTURE_NOT_A_BOT_TOKEN';
const BOT='8636930701',OWNER=98765432,NOW=Math.floor(Date.now()/1000);
async function signed(id,{token=PUBLIC,date=NOW}={}){
  const fields=new URLSearchParams({auth_date:String(date),user:JSON.stringify({id}),query_id:'LOCAL_UNIVERSAL_FIXTURE'});
  const check=[...fields].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
  fields.set('hash',Buffer.from(await hmac(await hmac('WebAppData',token),check)).toString('hex'));return fields.toString();
}
async function fixture(){
  const root=fileURLToPath(new URL('../../.test-temp/universal-style/',import.meta.url));await fs.mkdir(root,{recursive:true});
  const dir=await fs.mkdtemp(path.join(root,'case-')),file=path.join(dir,'state.sqlite');let db=new LocalD1(file);
  db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const categories=['Футболки','Худи','Кеды','Сумки','Ремни','Серьги','Куртки','Блузки'];
  const products=categories.map((category,i)=>({product:{id:i+1,name:'LOCAL SYNTHETIC '+(i+1),category,categoryVerified:true,
    imageHash:(i+1).toString(16).padStart(64,'0'),image:`https://basket-01.wbbasket.ru/vol0/part0/${i+1}/images/big/1.webp`,
    displayImage:`/style-photos/${i+1}.webp`,price:null,priceSource:'unknown',available:null},visual:null}));
  for(const {product:p} of products)await db.prepare('INSERT INTO feature_catalog VALUES(?,?,?,?)').bind(p.id,JSON.stringify(p),'null',Date.now()).run();
  await db.prepare("INSERT INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind(JSON.stringify({products})).run();
  const app=createProductionFeatures({fetch(){throw Error('EXISTING_PRODUCTION_PATH_NOT_IN_THIS_FIXTURE');}});
  const env=()=>({DB:db,SUBSCRIBER_STYLE_ENABLED:'1',SUPERFIND_PREVIEW_ENABLED:'1',MINIAPP_BOT_TOKEN:PUBLIC,TG_BOT_TOKEN:MAIN,MINIAPP_ADMIN_ID:String(OWNER)});
  const call=async(id,route,method='GET',data,authOptions={})=>{
    const response=await app.fetch(new Request('https://local-universal.invalid'+route,{method,
      headers:{'X-Telegram-Init-Data':await signed(id,authOptions),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined}),env());
    return {status:response.status,json:await response.json()};
  };
  return {get db(){return db;},call,async restart(){db.close();db=new LocalD1(file);},close(){db.close();}};
}

test('any signed subscriber receives an independent persistent profile; no owner ID or registration is required',async()=>{
  const f=await fixture(),users=[101,19485762,777000333,5000000001,987650004321,900000000003,22334455,OWNER+1];
  const expected=new Map();try{
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_accounts').get().n,0);
    for(const uid of users){const me=await f.call(uid,'/api/style/me');assert.equal(me.status,200);assert.equal(me.json.version,0);assert.equal(me.json.rated,0);}
    // Opening only reads defaults; it does not require an administrator to add IDs.
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_accounts').get().n,0);
    for(const [i,uid] of users.entries()){
      const filters={audience:'all',groups:[],maxPrice:1000+i};expected.set(uid,filters);
      // Deliberately reuse request IDs across users: receipts must be user-scoped.
      assert.equal((await f.call(uid,'/api/style/filters','PUT',{version:0,requestId:'same-filters-request-all-users',filters})).status,200);
      assert.equal((await f.call(uid,'/api/style/vote','POST',{version:1,requestId:'same-vote-request-for-all-users',id:i+1,action:i%2?'dislike':'like'})).status,200);
      assert.equal((await f.call(uid,'/api/style/favorite','POST',{version:2,requestId:'same-save-request-for-all-users',id:i+1,saved:true})).status,200);
    }
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_accounts').get().n,users.length);
    await f.restart();
    for(const [i,uid] of users.entries()){
      const me=await f.call(uid,'/api/style/me'),saved=await f.call(uid,'/api/style/favorites');
      assert.equal(me.status,200);assert.equal(me.json.version,3);assert.equal(me.json.rated,1);assert.deepEqual(me.json.filters,expected.get(uid));
      assert.equal(saved.status,200);assert.deepEqual(saved.json.items.map(p=>p.id),[i+1]);
      const vote=f.db.sqlite.prepare('SELECT pid,action FROM style_votes WHERE user_id=?').get(uid);assert.equal(vote.pid,i+1);assert.equal(vote.action,i%2?'dislike':'like');
    }
    const victim=users[0],attacker=users[1];
    const forgedSelector=await f.call(attacker,'/api/style/favorites?user_id='+victim);assert.deepEqual(forgedSelector.json.items.map(p=>p.id),[2]);
    assert.equal((await f.call(attacker,'/api/style/vote','POST',{version:3,requestId:'forged-user-in-body-request',id:1,action:'like',user_id:victim})).status,400);
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_votes WHERE user_id=?').get(attacker).n,1);
    const before=f.db.sqlite.prepare('SELECT * FROM style_accounts WHERE user_id=?').get(attacker);
    assert.equal((await f.call(victim,'/api/style/history','DELETE',{version:3,requestId:'erase-only-this-subscriber'})).status,200);
    assert.equal((await f.call(victim,'/api/style/me')).json.rated,0);assert.deepEqual((await f.call(victim,'/api/style/favorites')).json.items,[]);
    assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM style_accounts WHERE user_id=?').get(attacker),before);
    assert.deepEqual((await f.call(attacker,'/api/style/favorites')).json.items.map(p=>p.id),[2]);
    for(const uid of users){
      assert.equal((await f.call(uid,'/api/admin/superfind')).status,401,'Public-bot signature is not admin authentication');
      assert.equal((await f.call(uid,'/api/admin/superfind','GET',undefined,{token:MAIN})).status,403,'Main-bot non-owner cannot administer');
    }
  }finally{f.close();}
});

test('forged, expired, wrong-bot and plain user IDs cannot create subscriber accounts',async()=>{
  const f=await fixture();try{const beforeQueries=f.db.queries.length;
    assert.equal((await f.call(123,'/api/style/me','GET',undefined,{token:MAIN})).status,401);
    assert.equal((await f.call(123,'/api/style/me','GET',undefined,{date:NOW-4000})).status,401);
    assert.equal((await f.call(-1,'/api/style/me')).status,401);
    const app=createProductionFeatures({fetch(){throw Error('UNUSED');}}),env={DB:f.db,SUBSCRIBER_STYLE_ENABLED:'1',MINIAPP_BOT_TOKEN:PUBLIC};
    for(const raw of ['user_id=123',JSON.stringify({user_id:123}),(await signed(123)).replace('LOCAL_UNIVERSAL_FIXTURE','TAMPERED')]){
      const r=await app.fetch(new Request('https://local-universal.invalid/api/style/me?user_id='+OWNER,{headers:{'X-Telegram-Init-Data':raw}}),env);assert.equal(r.status,401);
    }
    assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM style_accounts').get().n,0);
    assert.equal(f.db.queries.length,beforeQueries,'Unauthenticated identities must be rejected before any D1 query');
  }finally{f.close();}
});

test('Ed25519 identity validation accepts diverse signed users with no human ID allowlist; official verifier rejects fixture keys',async()=>{
  const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  for(let i=0;i<32;i++){
    const id=1000000000+i*7919,fields=new URLSearchParams({auth_date:String(NOW),user:JSON.stringify({id}),query_id:'LOCAL_ED25519_FIXTURE'});
    const text=BOT+':WebAppData\n'+[...fields].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n');
    fields.set('signature',Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(text))).toString('base64url'));
    assert.equal(await verifyTelegramSignature(fields.toString(),BOT,keys.publicKey,NOW),id);
    if(i===0)await assert.rejects(telegramPublicUser(fields.toString(),BOT),'Fixture keys MUST NOT authorize staging');
  }
});

test('public My Style works even when an owner ID is not configured',async()=>{
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const app=createProductionFeatures({fetch(){throw Error('UNUSED');}}),env={DB:db,SUBSCRIBER_STYLE_ENABLED:'1',MINIAPP_BOT_TOKEN:PUBLIC};
  try{for(const id of [2,OWNER+555,800000000012]){
    const r=await app.fetch(new Request('https://local-universal.invalid/api/style/me',{headers:{'X-Telegram-Init-Data':await signed(id)}}),env);assert.equal(r.status,200);
    const saved=await app.fetch(new Request('https://local-universal.invalid/api/style/filters',{method:'PUT',headers:{'X-Telegram-Init-Data':await signed(id),'Content-Type':'application/json'},
      body:JSON.stringify({version:0,requestId:'automatic-profile-no-owner-list',filters:{audience:'all',groups:[]}})}),env);assert.equal(saved.status,200);
    assert.ok(db.sqlite.prepare('SELECT user_id FROM style_accounts WHERE user_id=?').get(id));
  }}finally{db.close();}
});
