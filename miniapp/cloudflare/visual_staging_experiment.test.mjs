import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {initExperiment,experimentalAI,experimentStatus,checkInputs,responseDiagnostic,EXPERIMENT} from './visual_staging_experiment.mjs';
import {VISUAL_MODEL,visualInputs} from './visual_enrichment.mjs';
import {normalizeAnalysis} from './visual_features.mjs';
function env(){
  const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE visual_queue(pid INTEGER PRIMARY KEY,state TEXT,retry_at INTEGER,attempts INTEGER,error TEXT);CREATE TABLE visual_inference_usage(pid INTEGER,usage TEXT)");
  const wrap=(s,a=[])=>({bind(...v){return wrap(s,v);},async first(){return db.prepare(s).get(...a)||null;},async all(){return {results:db.prepare(s).all(...a)};},async run(){return {meta:{changes:Number(db.prepare(s).run(...a).changes)}};}});
  return {db,VISUAL_STAGING:'isolated',VISUAL_STAGING_DB_ID:'5779987d-1100-45ad-8cd4-9df9c1436a20',DB:{prepare:wrap,async batch(st){db.exec('BEGIN');try{const r=[];for(const s of st)r.push(await s.run());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}},calls:0};
}
test('bounded Gemma inputs only: no Llama, multiple photos, thinking, oversized text or uncapped output',()=>{
  const i=visualInputs(new Uint8Array([1]),'apparel');checkInputs(VISUAL_MODEL,i);
  for(const change of [x=>x.messages[0].content.push(x.messages[0].content[1]),x=>x.messages[0].content[0].text='x'.repeat(4097),x=>x.max_completion_tokens=901,x=>x.chat_template_kwargs.enable_thinking=true,x=>x.messages.push(x.messages[0])]){const x=structuredClone(i);change(x);assert.throws(()=>checkInputs(VISUAL_MODEL,x));}
  assert.throws(()=>checkInputs('@cf/meta/llama-3.2-11b-vision-instruct',i));
});
test('separate500 ledger settles actual cost, no identical-image retry and persists across restart/day',async()=>{
  const e=env();await initExperiment(e);e.AI={async run(){e.calls++;return {usage:{neurons:15},response:'{}'};}};
  await experimentalAI(e).run(VISUAL_MODEL,visualInputs(new Uint8Array([1]),'apparel'));
  assert.equal((await experimentStatus(e)).charged,15);
  await initExperiment(e);assert.equal((await experimentStatus(e)).calls,1);
  await assert.rejects(()=>experimentalAI({...e}).run(VISUAL_MODEL,visualInputs(new Uint8Array([1]),'apparel')),/REPEAT_REFUSED/);assert.equal(e.calls,1);
  e.db.prepare('UPDATE visual_experiment SET charged=301 WHERE id=?').run(EXPERIMENT);
  await assert.rejects(()=>experimentalAI(e).run(VISUAL_MODEL,visualInputs(new Uint8Array([2]),'bag')),/BUDGET_REFUSED/);assert.equal(e.calls,1);e.db.close();
});
test('unknown metering retains reserve and locks experiment; raw provider text never in diagnostic',async()=>{
  const e=env();await initExperiment(e);e.AI={async run(){e.calls++;return {response:'Bearer synthetic-secret'};}};
  await experimentalAI(e).run(VISUAL_MODEL,visualInputs(new Uint8Array([1]),'apparel'));
  const s=await experimentStatus(e);assert.equal(s.charged,200);assert.ok(s.hold);assert.doesNotMatch(JSON.stringify(s),/synthetic-secret|Bearer/);
  await assert.rejects(()=>experimentalAI({...e}).run(VISUAL_MODEL,visualInputs(new Uint8Array([2]),'bag')),/BUDGET_REFUSED/);assert.equal(e.calls,1);e.db.close();
});
test('provider-envelope metering and structural JSON diagnostics do not manufacture profiles',async()=>{
  const e=env();await initExperiment(e);e.AI={async run(){return Response.json({result:{response:'{}'},usage:{neurons:12}});}};
  await experimentalAI(e).run(VISUAL_MODEL,visualInputs(new Uint8Array([1]),'apparel'));assert.equal((await experimentStatus(e)).charged,12);e.db.close();
  assert.equal(responseDiagnostic({response:'{"group":"apparel"'}).json_parse_ok,false);
  for(const raw of ['',null,'```json\n{}\n```','{"group":"apparel","fields":{}}.','[]'])assert.throws(()=>normalizeAnalysis(raw));
  assert.deepEqual(normalizeAnalysis({group:'apparel',fields:{color:{value:'black',confidence:.7,evidence:'Visible black body'},fit:{value:'regular'},material:{value:'cotton',confidence:1,evidence:'Cotton guessing'}}}).fields,{});
});
