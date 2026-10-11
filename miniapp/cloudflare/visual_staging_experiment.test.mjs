import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initExperiment,experimentStatus,checkInputs,responseDiagnostic,EXPERIMENT,EXPERIMENT_PRODUCTS,reserveExperiment,settleExperiment} from './visual_staging_experiment.mjs';
import {VISUAL_MODEL,visualInputs} from './visual_enrichment.mjs';
import {normalizeAnalysis} from './visual_features.mjs';
function env(){
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE visual_queue(pid INTEGER PRIMARY KEY,state TEXT,retry_at INTEGER,attempts INTEGER,error TEXT);CREATE TABLE visual_inference_usage(pid INTEGER,usage TEXT)");
  const wrap=(s,a=[])=>({bind(...v){return wrap(s,v);},async first(){return db.prepare(s).get(...a)||null;},async all(){return {results:db.prepare(s).all(...a)};},async run(){return {meta:{changes:Number(db.prepare(s).run(...a).changes)}};}});
  return {db,VISUAL_STAGING:'isolated',VISUAL_STAGING_DB_ID:'5779987d-1100-45ad-8cd4-9df9c1436a20',DB:{prepare:wrap,async batch(st){db.exec('BEGIN');try{const r=[];for(const s of st)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
}
test('bounded Gemma inputs only: no multiple photos, thinking, oversized text or uncapped output',()=>{
  const i={...visualInputs(new Uint8Array([1]),'apparel'),max_completion_tokens:600};checkInputs(VISUAL_MODEL,i);
  for(const change of [x=>x.messages[0].content.push(x.messages[0].content[1]),x=>x.messages[0].content[0].text='x'.repeat(4097),x=>x.max_completion_tokens=601,x=>x.chat_template_kwargs.enable_thinking=true,x=>x.messages.push(x.messages[0])]){const x=structuredClone(i);change(x);assert.throws(()=>checkInputs(VISUAL_MODEL,x));}
  assert.throws(()=>checkInputs('@cf/meta/llama-3.2-11b-vision-instruct',i));assert.throws(()=>checkInputs(VISUAL_MODEL,{}));
});
test('separate150 ledger settles actual cost, no identical-image retry and persists across restart/day',async()=>{
  const e=env();await initExperiment(e);
  const id=await reserveExperiment(e,EXPERIMENT_PRODUCTS[0].hash);await settleExperiment(e,id,15,{});
  assert.equal((await experimentStatus(e)).charged,15);await initExperiment(e);assert.equal((await experimentStatus(e)).calls,1);
  await assert.rejects(()=>reserveExperiment({...e},EXPERIMENT_PRODUCTS[0].hash),/REPEAT_REFUSED/);
  e.db.prepare('UPDATE visual_experiment SET charged=41 WHERE id=?').run(EXPERIMENT);
  await assert.rejects(()=>reserveExperiment(e,EXPERIMENT_PRODUCTS[1].hash),/BUDGET_REFUSED/);e.db.close();
});
test('unknown metering keeps110 reservation/hold; diagnostics never include provider text',async()=>{
  const e=env();await initExperiment(e);const id=await reserveExperiment(e,EXPERIMENT_PRODUCTS[0].hash);
  await settleExperiment(e,id,null,responseDiagnostic({response:'Bearer synthetic-secret'}));
  const s=await experimentStatus(e);assert.equal(s.charged,110);assert.ok(s.hold);assert.doesNotMatch(JSON.stringify(s),/synthetic-secret|Bearer/);
  await settleExperiment(e,id,10,{});assert.equal((await experimentStatus(e)).charged,110);assert.ok((await experimentStatus(e)).hold);
  await assert.rejects(()=>reserveExperiment({...e},EXPERIMENT_PRODUCTS[1].hash),/BUDGET_REFUSED/);e.db.close();
});
test('structural/field diagnostics do not manufacture profiles or repair JSON',()=>{
  assert.equal(responseDiagnostic({response:'{"group":"apparel"'}).json_parse_ok,false);
  for(const raw of ['',null,'```json\n{}\n```','{"group":"apparel","fields":{}}.','[]'])assert.throws(()=>normalizeAnalysis(raw));
  const d=responseDiagnostic({response:{group:'apparel',fields:{neckline:{value:'off_shoulder',confidence:.95,evidence:'Visible bare shoulders'},color:{value:'black',confidence:.95,evidence:'Black garment body'}}}});
  assert.equal(d.rejected[0].reason,'UNSUPPORTED_VALUE');assert.equal(d.rejected[0].field,'neckline');assert.equal(d.accepted_fields,1);
});
test('only remaining pinned hashes; prior ledger/failed attempts never reset; max3',async()=>{
  const e=env();await initExperiment(e);
  e.db.prepare('INSERT INTO visual_experiment VALUES(?,104.6454553604126,8,?)').run('gemma-native-20261010-500','');
  e.db.prepare('INSERT INTO visual_queue VALUES(1113687154,?,0,1,?)').run('pending','VISUAL_INVALID_PROFILE');
  await initExperiment(e);assert.equal(e.db.prepare('SELECT calls FROM visual_experiment WHERE id=?').get('gemma-native-20261010-500').calls,8);assert.equal(e.db.prepare('SELECT attempts FROM visual_queue').get().attempts,1);
  await assert.rejects(()=>reserveExperiment(e,'not-allowed'),/IMAGE_BOUND_REFUSED/);
  for(const p of EXPERIMENT_PRODUCTS){const id=await reserveExperiment(e,p.hash);await settleExperiment(e,id,10,{});}
  assert.equal((await experimentStatus(e)).calls,3);e.db.close();
});
test('parallel claims serialize; known over-reserve cost holds; settling twice never credits budget',async()=>{
  const e=env();await initExperiment(e);const id=await reserveExperiment(e,EXPERIMENT_PRODUCTS[0].hash);
  await assert.rejects(()=>reserveExperiment({...e},EXPERIMENT_PRODUCTS[1].hash),/BUDGET_REFUSED/);
  await settleExperiment(e,id,111,{});assert.equal((await experimentStatus(e)).hold,'provider_exceeded_reserve');
  await settleExperiment(e,id,10,{});assert.equal((await experimentStatus(e)).charged,111);e.db.close();
});
