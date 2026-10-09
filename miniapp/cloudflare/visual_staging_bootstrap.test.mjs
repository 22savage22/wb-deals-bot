import test from 'node:test';
import assert from 'node:assert/strict';
import {getStagingDatabase,requireStagingBuild,requireVersionUrls,uploadReceipt,safeBuildError,STAGING_DB_NAME} from './bootstrap-visual-staging.mjs';
const id='11111111-1111-4111-8111-111111111111';
test('managed staging database creation is exact, bounded and reuses existing resources',async()=>{
  const calls=[],api=async(method,path,body)=>{calls.push({method,path,body});return method==='GET'?[]:{name:STAGING_DB_NAME,uuid:id};};
  assert.equal(await getStagingDatabase(api),id);assert.equal(calls.length,2);assert.deepEqual(calls[1].body,{name:STAGING_DB_NAME});
  let reads=0;assert.equal(await getStagingDatabase(async method=>{reads++;assert.equal(method,'GET');return [{name:STAGING_DB_NAME,uuid:id}];}),id);assert.equal(reads,1);
});
test('staging bootstrap refuses production identities, ambiguity, transport failures and the main branch',async()=>{
  await assert.rejects(getStagingDatabase(async()=>[{name:STAGING_DB_NAME,uuid:'d73d252d-3948-425b-b7c3-b65d0f5c6e5f'}]),/production refused/);
  await assert.rejects(getStagingDatabase(async()=>[{name:STAGING_DB_NAME,uuid:id},{name:STAGING_DB_NAME,uuid:id}]),/Ambiguous/);
  let n=0;await assert.rejects(getStagingDatabase(async()=>{n++;throw new Error('transport');}),/transport/);assert.equal(n,1);
  assert.throws(()=>requireStagingBuild({WORKERS_CI:'1',WORKERS_CI_BRANCH:'main',CLOUDFLARE_API_TOKEN:'synthetic-not-real'}),/preview build/);
  assert.throws(()=>requireStagingBuild({WORKERS_CI:'1',WORKERS_CI_BRANCH:'codex/visual-enrichment-v2'}),/credential unavailable/);
  assert.throws(()=>requireVersionUrls({previews_enabled:false}),/no production deployment or setting changed/);
  requireVersionUrls({previews_enabled:true});
  const preview='https://11111111-wb-finds-miniapp.valeramyakishev000.workers.dev';
  assert.deepEqual(uploadReceipt(JSON.stringify({type:'version-upload',version_id:id,preview_url:preview})),{version_id:id,preview_url:preview});
  assert.throws(()=>uploadReceipt(JSON.stringify({type:'version-upload',version_id:id,preview_url:'https://wb-finds-miniapp.valeramyakishev000.workers.dev'})),/production not deployed/);
});
test('bootstrap error output never contains raw provider/credential details',()=>{
  assert.doesNotMatch(safeBuildError(new Error('Bearer synthetic-secret; url and headers')),/synthetic-secret|Bearer|headers/);
  assert.equal(safeBuildError(new Error('D1 create HTTP 403; required Account → D1 Edit')),'D1 create HTTP 403; required Account → D1 Edit');
  assert.doesNotMatch(safeBuildError(new Error('D1 create HTTP 403; required Account → D1 Edit synthetic-secret')),/synthetic-secret/);
  assert.match(safeBuildError(new Error('Staging version upload failed; requires Account → Workers Scripts Edit; production not deployed')),/Workers Scripts Edit/);
});
