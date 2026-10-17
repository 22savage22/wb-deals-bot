// Prepared composition LOCAL fixtures, NOT a production deployment or real
// Telegram-account proof. No WB/Telegram/AI/network call is made by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createProductionFeatures} from './production_worker.mjs';
import featureWorker from './worker.mjs';
import {LocalD1} from './local_d1.mjs';
import {hmac} from '../cloudflare/auth.mjs';

const request=(path,method='GET',raw='')=>new Request('https://production.unit'+path,{method,headers:{'X-Telegram-Init-Data':raw}});
const forbiddenDB=()=>({prepare(){throw Error('HELPER_MUST_STAY_OFF');}});
const fixtureContext=()=>{const pending=[];return {pending,ctx:{waitUntil:promise=>pending.push(promise)}};};
async function signed(token,id){
  const fields=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id}),query_id:'LOCAL_PRODUCTION_UNIT_FIXTURE'});
  const check=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>key+'='+value).join('\n');
  const hash=await hmac(await hmac('WebAppData',token),check);fields.set('hash',Buffer.from(hash).toString('hex'));return fields.toString();
}
test('all flags OFF forwards original fetch request/env/ctx and exact response without D1/helpers',async()=>{
  const env={DB:forbiddenDB(),STYLE_CATALOGUE_REFRESH_ENABLED:'1'},r=request('/api/me'),context=fixtureContext(),response=Response.json({existing:true});let calls=0;
  const core={async fetch(got,e,ctx){calls++;assert.equal(got,r);assert.equal(e,env);assert.equal(ctx,context.ctx);return response;}};
  const composed=createProductionFeatures(core,{fetch(){throw Error('FEATURE_MUST_STAY_OFF');}});
  assert.equal(await composed.fetch(r,env,context.ctx),response);assert.equal(calls,1);assert.equal(context.pending.length,0);
});
test('all flags OFF preserves original Cron result and controller/env/ctx with zero optional SQL',async()=>{
  const env={DB:forbiddenDB(),STYLE_CATALOGUE_REFRESH_ENABLED:'1'},controller={scheduledTime:20*60000},context=fixtureContext(),receipt={existingScheduler:true};let calls=0;
  const composed=createProductionFeatures({async scheduled(c,e,ctx){calls++;assert.equal(c,controller);assert.equal(e,env);assert.equal(ctx,context.ctx);return receipt;}});
  assert.equal(await composed.scheduled(controller,env,context.ctx),receipt);assert.equal(calls,1);assert.equal(context.pending.length,0);
});
test('disabled new APIs/shell/photos return404 without reaching original helper or D1',async()=>{
  const composed=createProductionFeatures({fetch(){throw Error('CORE_MUST_NOT_HANDLE_NEW_DISABLED_ROUTES');}},{fetch(){throw Error('FEATURE_MUST_STAY_OFF');}}),env={DB:forbiddenDB()};
  for(const path of ['/api/style/me','/api/admin/superfind','/style','/superfind','/style-images/123/'+'a'.repeat(64)+'.webp','/feature/app.js','/style-photos/123.webp','/style-navigation.js'])assert.equal((await composed.fetch(request(path),env)).status,404,path);
});
test('feature flags require exact string1 and UI flag scripts do not authorize any admin API',async()=>{
  const composed=createProductionFeatures({fetch(){throw Error('NO_CORE_CALL');}},{fetch(){throw Error('NO_FEATURE_CALL');}});
  for(const value of [undefined,'0','true',true,1]){
    const env={DB:forbiddenDB(),SUBSCRIBER_STYLE_ENABLED:value,SUPERFIND_PREVIEW_ENABLED:value};
    assert.equal((await composed.fetch(request('/api/style/me'),env)).status,404);assert.equal((await composed.fetch(request('/api/admin/superfind'),env)).status,404);
    assert.match(await(await composed.fetch(request('/style-flags.js'),env)).text(),/__WB_STYLE_ENABLED__=false/);
    assert.match(await(await composed.fetch(request('/admin/feature-flags.js'),env)).text(),/__WB_SUPERFIND_PREVIEW__=false/);
  }
});
test('existing webhook/admin/search/reaction routes are delegated unchanged even when subscriber features are enabled',async()=>{
  let calls=0;const response=new Response('existing'),core={async fetch(){calls++;return response;}},composed=createProductionFeatures(core,{fetch(){throw Error('FEATURE_MUST_NOT_INTERCEPT_EXISTING');}});
  const env={DB:forbiddenDB(),SUBSCRIBER_STYLE_ENABLED:'1',SUPERFIND_PREVIEW_ENABLED:'1'};
  for(const path of ['/telegram/main/webhook','/telegram/webhook','/api/admin/overview','/api/admin/selection/quality','/api/scheduler/tick','/api/catalog'])assert.equal(await composed.fetch(request(path),env),response,path);
  assert.equal(calls,6);
});
test('core Cron failure propagates unchanged and optional source cannot run before a successful posting cycle',async()=>{
  const failure=Error('LOCAL_CORE_FAILURE');let queries=0;const context=fixtureContext(),env={SUBSCRIBER_STYLE_ENABLED:'1',STYLE_CATALOGUE_REFRESH_ENABLED:'1',DB:{prepare(){queries++;throw Error('MUST_NOT_RUN');}}};
  const composed=createProductionFeatures({async scheduled(){throw failure;}});
  await assert.rejects(composed.scheduled({scheduledTime:20*60000},env,context.ctx),error=>error===failure);assert.equal(queries,0);assert.equal(context.pending.length,0);
});
test('optional catalogue SQL failure is detached and cannot turn a successful post receipt into a Cron failure',async()=>{
  const order=[],context=fixtureContext(),receipt={message_id:999,LOCAL_FIXTURE:true},env={SUBSCRIBER_STYLE_ENABLED:'1',STYLE_CATALOGUE_REFRESH_ENABLED:'1',DB:{prepare(){order.push('optional-SQL');throw Error('LOCAL_OPTIONAL_UNAVAILABLE');}}};
  const composed=createProductionFeatures({async scheduled(){order.push('core-post');return receipt;}});
  assert.equal(await composed.scheduled({scheduledTime:20*60000},env,context.ctx),receipt);assert.deepEqual(order,['core-post','optional-SQL']);assert.equal(context.pending.length,1);await Promise.all(context.pending);
});
test('optional catalogue work is skipped between its20minute slots',async()=>{
  const context=fixtureContext(),receipt={existing:true},composed=createProductionFeatures({async scheduled(){return receipt;}});
  assert.equal(await composed.scheduled({scheduledTime:21*60000},{SUBSCRIBER_STYLE_ENABLED:'1',STYLE_CATALOGUE_REFRESH_ENABLED:'1',DB:forbiddenDB()},context.ctx),receipt);assert.equal(context.pending.length,0);
});
test('prepared feature routes use public HMAC vs main-owner HMAC, never UI flag or client ID authorization',async()=>{
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const env={DB:db,SUBSCRIBER_STYLE_ENABLED:'1',SUPERFIND_PREVIEW_ENABLED:'1',MINIAPP_BOT_TOKEN:'LOCAL_PUBLIC_NOT_A_REAL_TOKEN',TG_BOT_TOKEN:'LOCAL_MAIN_NOT_A_REAL_TOKEN',MINIAPP_ADMIN_ID:'12345678',STYLE_STAGING:'1',STAGING_OWNER_PREVIEW:'1'};
  const composed=createProductionFeatures({fetch(){throw Error('NEW_ROUTES_ONLY');}},featureWorker),owner=12345678;
  try{
    const pub=await signed(env.MINIAPP_BOT_TOKEN,owner),main=await signed(env.TG_BOT_TOKEN,owner),nonOwner=await signed(env.TG_BOT_TOKEN,87654321);
    assert.equal((await composed.fetch(request('/api/style/me','GET',pub),env)).status,200);
    assert.equal((await composed.fetch(request('/api/style/me','GET',main),env)).status,401);
    assert.equal((await composed.fetch(request('/api/admin/superfind','GET',pub),env)).status,401);
    assert.equal((await composed.fetch(request('/api/admin/superfind','GET',nonOwner),env)).status,403);
    assert.equal((await composed.fetch(request('/api/admin/superfind','GET',main),env)).status,200);
    assert.equal((await composed.fetch(request('/api/admin/superfind?user_id='+owner),env)).status,401);
    assert.equal(env.STYLE_STAGING,'1','Wrapper mutated its caller environment');
  }finally{db.close();}
});
test('prepared shell routes reuse same-origin assets without mutating existing public/admin entrypoints',async()=>{
  const paths=[],env={SUBSCRIBER_STYLE_ENABLED:'1',SUPERFIND_PREVIEW_ENABLED:'1',DB:forbiddenDB(),ASSETS:{async fetch(r){paths.push(new URL(r.url).pathname);return new Response('LOCAL_SHELL');}}};
  const composed=createProductionFeatures({fetch(){throw Error('NEW_SHELL_ONLY');}});
  for(const path of ['/style','/style/','/superfind'])assert.equal((await composed.fetch(request(path),env)).status,200);
  assert.deepEqual(paths,['/style/index.html','/style/index.html','/style/index.html']);
});
