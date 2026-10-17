// Local unit fixtures only: synthetic metadata exercises accounting, NOT D1
// billing evidence or real Telegram-account authentication.
import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from './local_d1.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {createStagingBudget,STAGING_BUDGET_SCHEMA,stagingReservation,StagingBudgetError} from './staging_budget.mjs';

const DAY='2026-10-17',clock=()=>Date.parse(DAY+'T12:00:00Z'),request=(method='GET',path='/api/style/me')=>new Request('https://stage.test'+path,{method});
const DBID='11111111-1111-4111-8111-111111111111',scope=DB=>({DB,STYLE_STAGING_DB_ID:DBID});
function fixture({known=true}={}){
  const local=new LocalD1();local.exec(STAGING_BUDGET_SCHEMA+'CREATE TABLE samples(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE feature_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  local.sqlite.prepare("INSERT INTO feature_meta VALUES('style_staging_database',?)").run(DBID);
  // Deliberately synthetic, clearly labelled fixture result metadata. SQLite
  // does not expose Cloudflare rows_read or indexed row-write billing.
  const measured=(result,sql)=>known?{...result,meta:{...result.meta,rows_read:1,rows_written:/^(INSERT|UPDATE|DELETE)/i.test(sql.trim())?1:0}}:result;
  const db={prepare(sql){
    const wrap=statement=>({bind(...args){return wrap(statement.bind(...args));},async all(){return measured(await statement.all(),sql);},async run(){return measured(await statement.run(),sql);}});
    return wrap(local.prepare(sql));
  }};
  const ledger=()=>local.sqlite.prepare('SELECT reads,writes FROM stage_request_budget WHERE day=?').get(DAY);
  return {local,db,ledger,close:()=>local.close()};
}
test('staging budget includes physical reserve/operation/settlement in outer metadata without nested double counting',async()=>{
  const f=fixture();try{
    const outer=observeD1(f.db),budget=createStagingBudget({clock});
    const value=await budget(scope(outer.DB),request('POST'),async env=>{const nested=observeD1(env.DB);await nested.DB.prepare('INSERT INTO samples VALUES(?,?)').bind(1,'fixture').run();assert.equal(nested.metrics.queries,1);return 'accepted';});
    assert.equal(value,'accepted');assert.equal(outer.metrics.queries,3);assert.equal(outer.metrics.rows_read,3);assert.equal(outer.metrics.rows_written,3);
    // Ledger conservatively charges the settling allowance, not fictitious
    // exact billing. The independent outer meter retains genuine fixture totals.
    assert.deepEqual({...f.ledger()},{reads:6,writes:6});assert.ok(f.ledger().reads>=outer.metrics.rows_read);assert.ok(f.ledger().writes>=outer.metrics.rows_written);
  }finally{f.close();}
});
test('unknown metadata retains the entire reservation instead of billing zero',async()=>{
  const f=fixture({known:false});try{await createStagingBudget({clock})(scope(f.db),request(),async()=>{});assert.deepEqual({...f.ledger()},stagingReservation(request()));}finally{f.close();}
});
test('a failed operation keeps unknown reserve and future requests remain recoverable',async()=>{
  const f=fixture({known:false});try{
    const budget=createStagingBudget({clock});await assert.rejects(budget(scope(f.db),request('POST'),async()=>{throw Error('network fixture');}),/network fixture/);
    assert.deepEqual({...f.ledger()},stagingReservation(request('POST')));await budget(scope(f.db),request(),async()=>{});assert.equal(f.ledger().writes,80);
  }finally{f.close();}
});
test('full and first-day overlarge reservations are rejected before running the operation',async()=>{
  const f=fixture();try{
    let runs=0;const budget=createStagingBudget({clock,limits:{reads:2000,writes:16}});
    await assert.rejects(budget(scope(f.db),request('POST'),async()=>{runs++;}),StagingBudgetError);assert.equal(runs,0);assert.equal(f.ledger(),undefined);
    f.local.sqlite.prepare('INSERT INTO stage_request_budget VALUES(?,?,?)').run(DAY,2000,16);
    await assert.rejects(budget(scope(f.db),request(),async()=>{runs++;}),StagingBudgetError);assert.equal(runs,0);
  }finally{f.close();}
});
test('concurrent reservations cannot both spend the last staging funds',async()=>{
  const f=fixture({known:false});try{
    const budget=createStagingBudget({clock,limits:{reads:1000,writes:16}});let release;const gate=new Promise(resolve=>release=resolve);let running;
    const started=new Promise(resolve=>running=resolve),first=budget(scope(f.db),request(),async()=>{running();await gate;});await started;
    await assert.rejects(budget(scope(f.db),request(),async()=>{throw Error('MUST_NOT_RUN');}),StagingBudgetError);release();await first;
    assert.deepEqual({...f.ledger()},{reads:1000,writes:16});
  }finally{f.close();}
});
test('DELETE reservations include separate style bounds and the larger existing public save collection',()=>{
  assert.deepEqual(stagingReservation(request('DELETE','/api/style/history')),{reads:2200,writes:2400});
  assert.deepEqual(stagingReservation(request('DELETE','/api/me')),{reads:3000,writes:6500});
});
test('cold public catalogue GET reserves persisted snapshot/index writes rather than pretending to be read-only',()=>{
  assert.deepEqual(stagingReservation(request('GET','/api/catalog')),{reads:1000,writes:64});
  assert.deepEqual(stagingReservation(request('GET','/api/style/me')),{reads:1000,writes:16});
});
test('detached superfind job has a separate server-only accounting label and indexed-write reserve',()=>{
  assert.deepEqual(stagingReservation(request('POST','/__style-background/superfind')),{reads:2000,writes:512});
  assert.deepEqual(stagingReservation(request('GET','/__style-background/superfind')),{reads:1000,writes:16});
});
test('detached background work requires its own admission after HTTP202 has already settled',async()=>{
  const f=fixture({known:false});try{
    const budget=createStagingBudget({clock,limits:{reads:3000,writes:576}}),background=request('POST','/__style-background/superfind');
    const accepted=await budget(scope(f.db),request('POST','/api/admin/superfind/refresh'),async()=>({status:202}));assert.equal(accepted.status,202);
    let release,running;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>running=resolve);
    const task=budget(scope(f.db),background,async()=>{running();await gate;});await started;
    await assert.rejects(budget(scope(f.db),background,async()=>{throw Error('MUST_NOT_RUN');}),StagingBudgetError);
    release();await task;assert.deepEqual({...f.ledger()},{reads:3000,writes:576});
  }finally{f.close();}
});
test('overruns are visible and charged instead of being silently refunded',async()=>{
  const f=fixture();try{
    const reports=[],budget=createStagingBudget({clock,report:(...args)=>reports.push(args)}),db={prepare(sql){const original=f.db.prepare(sql);if(sql==='SELECT expensive')return {bind(){return this;},async all(){return {results:[{}],meta:{rows_read:1500,rows_written:0}};}};return original;}};
    await budget(scope(db),request(),env=>env.DB.prepare('SELECT expensive').all());assert.equal(reports[0][0],'STYLE_STAGE_BUDGET_OVERRUN');assert.equal(f.ledger().reads,1505);
  }finally{f.close();}
});
test('new UTC day is a separate staging allowance, not a production/account-wide quota reset claim',async()=>{
  const f=fixture({known:false});try{
    await createStagingBudget({clock})(scope(f.db),request(),async()=>{});
    await createStagingBudget({clock:()=>clock()+86400000})(scope(f.db),request(),async()=>{});
    assert.equal(f.local.sqlite.prepare('SELECT COUNT(*) AS n FROM stage_request_budget').get().n,2);
  }finally{f.close();}
});
test('wrong or absent staging canary cannot create or update any budget row',async()=>{
  const f=fixture();try{
    const budget=createStagingBudget({clock});let runs=0;
    f.local.sqlite.prepare("UPDATE feature_meta SET value='wrong-database' WHERE key='style_staging_database'").run();
    await assert.rejects(budget(scope(f.db),request(),async()=>{runs++;}),StagingBudgetError);assert.equal(f.ledger(),undefined);
    f.local.sqlite.prepare('INSERT INTO stage_request_budget VALUES(?,?,?)').run(DAY,123,12);
    await assert.rejects(budget(scope(f.db),request(),async()=>{runs++;}),StagingBudgetError);assert.deepEqual({...f.ledger()},{reads:123,writes:12});
    f.local.sqlite.prepare('DELETE FROM feature_meta').run();
    await assert.rejects(budget(scope(f.db),request(),async()=>{runs++;}),StagingBudgetError);assert.deepEqual({...f.ledger()},{reads:123,writes:12});assert.equal(runs,0);
  }finally{f.close();}
});
test('missing database identity is rejected without touching D1',async()=>{
  let queries=0;await assert.rejects(createStagingBudget({clock})({DB:{prepare(){queries++;}}},request(),async()=>{}),/STAGING_DATABASE_ID_REQUIRED/);assert.equal(queries,0);
});
