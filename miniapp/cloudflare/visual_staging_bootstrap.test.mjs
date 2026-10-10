import test from 'node:test';
import assert from 'node:assert/strict';
import {pinnedDatabaseId,verifyUploadedBindings,requireStagingBuild,requireVersionUrls,uploadReceipt,safeBuildError,STAGING_DB_ID} from './bootstrap-visual-staging.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {stagingMigrations} from './prepare-visual-staging-migrations.mjs';
import {isolatedEnvironment,absentWorker,WORKER,verifyStandaloneBindings} from './deploy-visual-standalone.mjs';
const id='11111111-1111-4111-8111-111111111111';
test('owner-provided D1 is pinned in the generated binding and another/production database is refused',()=>{
  assert.equal(pinnedDatabaseId(),STAGING_DB_ID);
  for(const wrong of [id,'d73d252d-3948-425b-b7c3-b65d0f5c6e5f'])assert.throws(()=>pinnedDatabaseId({VISUAL_STAGING_DB_ID:wrong}),/another database refused/);
  const root=readFileSync('wrangler.jsonc','utf8');
  const result=spawnSync(process.execPath,['miniapp/cloudflare/prepare-visual-staging.mjs'],{encoding:'utf8',env:{...process.env,VISUAL_STAGING_DB_ID:STAGING_DB_ID}});
  assert.equal(result.status,0);const config=JSON.parse(readFileSync('.test-temp/visual-staging/wrangler.jsonc','utf8'));
  assert.equal(config.d1_databases.length,1);assert.equal(config.d1_databases[0].database_id,STAGING_DB_ID);assert.equal(config.ai.binding,'AI');
  assert.equal(config.triggers,undefined);assert.equal(config.assets,undefined);assert.equal(readFileSync('wrangler.jsonc','utf8'),root);
});
test('uploaded binding/handler checks refuse production D1, absent AI, scheduled exports and the main branch',()=>{
  const version={id,resources:{bindings:[{type:'d1',name:'DB',id:STAGING_DB_ID},{type:'ai',name:'AI'}],script:{handlers:['fetch']}}};
  verifyUploadedBindings(version,id);
  for(const mutate of [v=>v.resources.bindings[0].id='d73d252d-3948-425b-b7c3-b65d0f5c6e5f',v=>v.resources.bindings.pop(),v=>v.resources.script.handlers.push('scheduled'),v=>v.id=STAGING_DB_ID]){
    const invalid=structuredClone(version);mutate(invalid);assert.throws(()=>verifyUploadedBindings(invalid,id),/not isolated/);
  }
  assert.throws(()=>requireStagingBuild({WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',CLOUDFLARE_API_TOKEN:'synthetic-not-real'}),/preview build/);
  assert.throws(()=>requireStagingBuild({WORKERS_CI:'1',WORKERS_CI_BRANCH:'codex/visual-enrichment-v2'}),/credential unavailable/);
  assert.throws(()=>requireVersionUrls({previews_enabled:false}),/no production deployment or setting changed/);
  requireVersionUrls({previews_enabled:true});
  const preview='https://11111111-wb-finds-miniapp.valeramyakishev000.workers.dev';
  assert.deepEqual(uploadReceipt(JSON.stringify({type:'version-upload',version_id:id,preview_url:preview})),{version_id:id,preview_url:preview});
  assert.throws(()=>uploadReceipt(JSON.stringify({type:'version-upload',version_id:id,preview_url:'https://wb-finds-miniapp.valeramyakishev000.workers.dev'})),/production not deployed/);
});

test('standalone staging deployment never targets the production Worker or its configuration',()=>{
  const root=readFileSync('wrangler.jsonc','utf8');
  const result=spawnSync(process.execPath,['miniapp/cloudflare/prepare-visual-staging.mjs','--standalone'],{encoding:'utf8'});
  assert.equal(result.status,0);
  const config=JSON.parse(readFileSync('.test-temp/visual-staging-standalone/wrangler.jsonc','utf8'));
  assert.equal(config.name,'wb-finds-visual-staging');assert.equal(config.d1_databases[0].database_id,STAGING_DB_ID);
  assert.equal(config.ai.binding,'AI');assert.equal(config.triggers,undefined);assert.equal(config.assets,undefined);
  assert.equal(config.keep_vars,false);assert.equal(config.vars.TG_BOT_TOKEN,undefined);
  assert.equal(readFileSync('wrangler.jsonc','utf8'),root);
});

test('standalone helper never imports deployment/runtime credentials from another agent',()=>{
  const env=isolatedEnvironment({CLOUDFLARE_API_TOKEN:'synthetic',CLOUDFLARE_API_KEY:'synthetic',TG_BOT_TOKEN:'synthetic',MINIAPP_BOT_TOKEN:'synthetic',MINIAPP_SYNC_KEY:'synthetic',PATH:process.env.PATH});
  for(const key of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','MINIAPP_SYNC_KEY'])assert.equal(env[key],undefined);
  assert.equal(WORKER,'wb-finds-visual-staging');assert.match(env.XDG_CONFIG_HOME,/\.test-temp[\\/]config$/);
  assert.equal(absentWorker({status:1,stderr:'Worker does not exist [code: 10007]'}),true);
  for(const result of [{status:0,stdout:'[]'},{status:1,stderr:'Authentication failed [code: 10000]'},{status:1,stderr:'timeout'}])assert.equal(absentWorker(result),false);
  const version={id,resources:{bindings:[{type:'d1',name:'DB',id:STAGING_DB_ID},{type:'ai',name:'AI'}],script:{handlers:['fetch']}}};
  verifyStandaloneBindings(version,id);
  for(const secret of ['TG_BOT_TOKEN','MINIAPP_BOT_TOKEN','CLOUDFLARE_API_TOKEN']){
    const unsafe=structuredClone(version);unsafe.resources.bindings.push({type:'secret_text',name:secret});
    assert.throws(()=>verifyStandaloneBindings(unsafe,id),/unexpected binding or credential/);
  }
});
test('bootstrap error output never contains raw provider/credential details',()=>{
  assert.doesNotMatch(safeBuildError(new Error('Bearer synthetic-secret; url and headers')),/synthetic-secret|Bearer|headers/);
  assert.equal(safeBuildError(new Error('Worker API HTTP 403; required Account → Workers Scripts Edit')),'Worker API HTTP 403; required Account → Workers Scripts Edit');
  assert.doesNotMatch(safeBuildError(new Error('Worker API HTTP 403; required Account → Workers Scripts Edit synthetic-secret')),/synthetic-secret/);
  assert.match(safeBuildError(new Error('Staging version upload failed; requires Account → Workers Scripts Edit; production not deployed')),/Workers Scripts Edit/);
});

test('four staged migrations initialize an empty database idempotently with SHADOW and Visual off',async()=>{
  const files=await stagingMigrations();assert.equal(files.length,4);
  const db=new DatabaseSync(':memory:');try{
    for(let pass=0;pass<2;pass++)for(const file of files)db.exec(file.sql);
    assert.equal(JSON.parse(db.prepare('SELECT config FROM learning_state WHERE id=1').get().config).mode,'SHADOW');
    assert.equal(db.prepare('SELECT enabled FROM visual_state WHERE id=1').get().enabled,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduler_inventory').get().n,0);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='visual_daily_products'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='visual_neuron_budget'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='visual_budget_holds'").get());
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='products'").get(),undefined);
  }finally{db.close();}
});
