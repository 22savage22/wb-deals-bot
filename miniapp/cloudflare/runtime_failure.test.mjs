import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRuntimeFailure} from './runtime_failure.mjs';
import worker from './worker.mjs';
import {ReadBudgetError} from './read_guard.mjs';

test('keeps finite cause classifications without serializing secrets or arbitrary names',()=>{
  const secret='Bearer private-token https://private.example/?cookie=private';
  const cause=new SyntaxError(secret),outer=new Error(secret,{cause});outer.name=secret;outer.stack=secret;outer.body=secret;
  const result=safeRuntimeFailure(outer,'header');
  assert.deepEqual(result,{stage:'header',causes:[{type:'Error',classification:'UNCLASSIFIED'},{type:'SyntaxError',classification:'SYNTAX_ERROR'}],cpu_signal:false});
  assert.equal(JSON.stringify(result).includes('private'),false);
});
test('does not infer CPU exhaustion from generic runtime or network errors',()=>{
  for(const text of ['RUNTIME_UNAVAILABLE','CPU metrics pending','execution time unknown','fetch failed'])assert.equal(safeRuntimeFailure(new Error(text)).cpu_signal,false);
  const limit=Object.assign(new Error('private'),{code:1102});assert.equal(safeRuntimeFailure(limit).cpu_signal,true);
  assert.equal(safeRuntimeFailure(new Error('Worker exceeded CPU time limit.')).cpu_signal,true);
});
test('retains quota and admission causes, caps cyclic chains and rejects arbitrary stages',()=>{
  const quota=new Error("D1_ERROR: exceeded D1 free tier daily row write limit private");
  assert.equal(safeRuntimeFailure(quota).causes[0].classification,'D1_DAILY_QUOTA_EXCEEDED');
  const guard=new ReadBudgetError();guard.cause=guard;
  assert.deepEqual(safeRuntimeFailure(guard,'secret'),{stage:'runtime',causes:[{type:'ReadBudgetError',classification:'D1_READ_BUDGET'}],cpu_signal:false});
});
test('scheduled boundary logs safe root cause before replacing the public exception',async()=>{
  const messages=[],original=console.error,log=console.log;console.error=(...args)=>messages.push(args);console.log=()=>{};
  try{
    const env={SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare(){return {bind(){return this;},async all(){throw new SyntaxError('secret-value');},async run(){throw new SyntaxError('secret-value');}};}}};
    await assert.rejects(worker.scheduled({scheduledTime:Date.now()},env),/^Error: RUNTIME_UNAVAILABLE$/);
    const serialized=JSON.stringify(messages);assert.match(serialized,/SYNTAX_ERROR/);assert.match(serialized,/scheduled/);assert.equal(serialized.includes('secret-value'),false);
  }finally{console.error=original;console.log=log;}
});
test('a failed budget settlement cannot erase the earlier scheduler failure from safe diagnostics',async()=>{
  const messages=[],original=console.error,log=console.log;console.error=(...args)=>messages.push(args);console.log=()=>{};
  try{
    const env={SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare(sql){return {bind(){return this;},async all(){throw new SyntaxError('secret-primary');},async run(){if(sql.startsWith('UPDATE worker_read_budget'))throw new TypeError('secret-settlement');return {meta:{changes:1,rows_read:0,rows_written:1}};}};}}};
    await assert.rejects(worker.scheduled({scheduledTime:Date.now()},env),/RUNTIME_UNAVAILABLE/);
    const serialized=JSON.stringify(messages);assert.match(serialized,/SCHEDULER_PRIMARY_ERROR/);assert.match(serialized,/SYNTAX_ERROR/);assert.match(serialized,/TYPE_ERROR/);assert.equal(serialized.includes('secret-'),false);
  }finally{console.error=original;console.log=log;}
});
