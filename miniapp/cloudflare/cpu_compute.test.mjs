import test from 'node:test';
import assert from 'node:assert/strict';
import {loadComputeModules,syntheticComputeFixture,computeStages,probeImmutableAggregate} from './cpu_compute_probe.mjs';
import {productType,summariseVotes} from './audience_quality.mjs';
import {features,shadowChoice} from './learning.mjs';

test('the same ordered type rules compile once lazily, then reuse non-stateful matchers',async()=>{
 const quality=await import('./audience_quality.mjs?cpu-rule-reuse'),Original=globalThis.RegExp;let constructors=0;
 globalThis.RegExp=new Proxy(Original,{construct(target,args,newTarget){constructors++;assert.equal(args[1],'u');return Reflect.construct(target,args,newTarget);}});
 try{
  assert.equal(quality.productType({title:'Учебник',category:'Учебники'}),'textbooks');assert.equal(constructors,0);
  const cases=[['Футболка','tshirt'],['Лонгслив','longsleeve'],['Худи','hoodie'],['Джинсы','jeans'],['Платье','dress'],['Юбка','skirt'],['Блузка','blouse'],['Куртка','outerwear'],['Свитер','knitwear'],['Брюки','trousers'],['Кроссовки','shoes'],['Сумка для учебников','bag'],['Кольцо','accessory']];
  for(let n=0;n<3;n++)for(const [title,want] of cases)assert.equal(quality.productType({title,category:'другое'}),want);
  assert.equal(constructors,13);
 }finally{globalThis.RegExp=Original;}
});
test('current-vote memo preserves every parse and all 500 contributions, bounded to own string data in this call',()=>{
 const data=JSON.stringify({id:1,title:'Футболка',category:'Футболки'}),rows=Array.from({length:500},(_,n)=>({pid:n%4+1,voter:'synthetic'+n,sentiment:n%2?'d':'l',data}));
 const parse=JSON.parse,normalize=String.prototype.normalize;let parses=0,folds=0;
 JSON.parse=function(...args){parses++;return Reflect.apply(parse,this,args);};String.prototype.normalize=function(...args){folds++;return Reflect.apply(normalize,this,args);};
 let result;try{result=summariseVotes(rows);}finally{JSON.parse=parse;String.prototype.normalize=normalize;}
 assert.equal(parses,500);assert.equal(folds,4);assert.equal(result.sampled_votes,500);assert.equal(result.truncated,true);assert.equal(result.likes,250);assert.equal(result.dislikes,250);assert.equal(result.traits.get('type:tshirt').people,500);assert.equal(result.items.size,4);
 const changed=rows.map(r=>({...r,data:JSON.stringify({title:'Сумка',category:'Сумки'})}));assert.equal(summariseVotes(changed).traits.has('type:bag'),true);
});
test('accessors and object inputs are evaluated without stale type memo; malformed JSON is not repaired',()=>{
 let reads=0;const row={pid:1,voter:'synthetic',sentiment:'l',get data(){reads++;return JSON.stringify({title:reads<4?'Футболка':'Сумка',category:'другое'});}};
 const result=summariseVotes([row,row]);assert.equal(reads,4);assert.equal(result.traits.get('type:tshirt').likes,1);assert.equal(result.traits.get('type:bag').likes,1);
 const object={title:'Футболка',category:'другое'},first={pid:2,voter:'synthetic2',sentiment:'d',data:object};assert.equal(summariseVotes([first]).traits.has('type:tshirt'),true);object.title='Сумка';assert.equal(summariseVotes([first]).traits.has('type:bag'),true);
 assert.equal(summariseVotes([{...first,data:'{'},{...first,data:'null'},{...first,sentiment:'unknown'}]).sampled_votes,3);assert.equal(summariseVotes([{...first,data:'{'}]).items.size,0);
});
test('public feature clock keeps real zone and DST semantics, invalid zones still reject',()=>{
 const p={title:'Женская футболка',category:'Футболки',query:'футболка',product:250,rating:4.9,feedbacks:120};
 for(const [iso,zone,hour,weekday] of [['2026-03-08T06:59:00Z','America/New_York',1,6],['2026-03-08T07:00:00Z','America/New_York',3,6],['2026-10-25T00:59:00Z','Europe/Berlin',2,6],['2026-10-25T01:00:00Z','Europe/Berlin',2,6],['2026-10-22T20:00:00Z','Asia/Kolkata',1,4],['2026-10-22T00:00:00Z','Europe/Moscow',3,3]]){
  const f=features(p,Date.parse(iso)/1000,.25,zone);assert.equal(f.hour,hour);assert.equal(f.weekday,weekday);assert.equal(f.feedback_rate,.25);assert.equal(f.audience,'women');assert.equal(f.price,Math.log1p(250)/12);
 }
 assert.throws(()=>features(p,1,.5,'Invalid/Not_A_Zone'),RangeError);
});
test('SHADOW uses one clock per explicit ts/zone and preserves candidates, SQL, stable ties and source inputs',async()=>{
 const modules=await loadComputeModules(),f=syntheticComputeFixture(modules),before=JSON.stringify({rows:f.rows,votes:f.votes,profiles:f.profiles,state:f.state});
 f.state.model=JSON.stringify({...f.model,weights:{},intercept:0});let calls=0;const format=Intl.DateTimeFormat.prototype.formatToParts;
 Intl.DateTimeFormat.prototype.formatToParts=function(...args){calls++;return Reflect.apply(format,this,args);};
 try{
  await shadowChoice(f.environment,[...f.rows,{pid:999999,data:'INVALID AFTER THE EXISTING 300 CANDIDATE BOUND'}],f.rows[5],f.ts,'America/New_York');assert.equal(calls,1);
  assert.equal(f.statements.length,4);const write=f.statements.at(-1);assert.equal(write.method,'run');assert.equal(write.args[0],f.rows[5].pid);assert.equal(write.args[2],f.rows[5].pid);assert.equal(write.args[3],f.rows[0].pid);assert.equal(write.args[5],.5);assert.equal(JSON.parse(write.args[6]).hour,8);
  f.resetStatements();await shadowChoice(f.environment,f.rows.slice(0,20),f.rows[0],f.ts+3600,'America/New_York');assert.equal(calls,2);assert.equal(JSON.parse(f.statements.at(-1).args[6]).hour,9);
  features(f.products[0],f.ts);features(f.products[0],f.ts);assert.equal(calls,4);
 }finally{Intl.DateTimeFormat.prototype.formatToParts=format;}
 // Only the test changed the model; no runtime input mutation.
 f.state.model=JSON.stringify(f.model);assert.equal(JSON.stringify({rows:f.rows,votes:f.votes,profiles:f.profiles,state:f.state}),before);
});
test('synthetic attribution fixture routes exact cached ids and complete compute is deterministic at 20 and 300',async()=>{
 const m=await loadComputeModules(),f=syntheticComputeFixture(m),stages=computeStages(m,f);
 assert.equal(f.rows.length,300);assert.equal(f.votes.length,500);assert.equal(f.profiles.length,300);assert.equal((await m.visual.cachedProfiles(f.environment,f.rows.slice(0,20).map(r=>r.pid))).size,20);
 for(const size of [20,300]){const a=await stages['fullCompute'+size](),b=await stages['fullCompute'+size]();assert.equal(a,b);assert.equal(f.statements.length,7);assert.ok(f.statements.every(s=>!s.sql.includes('CREATE')));}
 assert.equal(productType(f.products[0]),'tshirt');
});
test('representation experiment preserves the entire frozen aggregate including Maps, without adding a runtime cache',async()=>{
 const modules=await loadComputeModules(),fixture=syntheticComputeFixture(modules),report=await probeImmutableAggregate(modules,fixture);
 assert.equal(report.sameAggregate,true);assert.equal(report.sameChoice,true);assert.equal(report.currentVotes,500);assert.equal(report.profiles,300);assert.ok(report.bytes>1000);
 assert.equal(fixture.statements.length,3);assert.ok(fixture.statements.every(s=>s.method==='all'));
});
