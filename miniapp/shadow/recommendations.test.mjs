import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendForProfiles} from './recommendations.mjs';
import {createTasteState,setTasteRating,buildTasteProfile} from './taste.mjs';
import {rankProduct,compareShadow} from './ranking.mjs';
import {compareSameCandidates} from './comparison.mjs';
const now=1791724800000;
const names=['Альфа','Бета','Гамма','Дельта','Эпсилон','Дзета','Эта','Тета','Йота','Каппа','Лямбда','Омикрон'];
const products=Array.from({length:12},(_,i)=>({id:i+1,name:names[i],category:'Сумки',categoryVerified:true,price:200,available:null,rating:4.8,reviews:100,observedAt:now-864000000,priceSource:'legacy_snapshot',imageHash:String(i+1).padStart(64,'0'),image:`https://basket-01.wbbasket.ru/vol1/part1/${i+1}/images/big/1.webp`}));
const vote=(id,action,profile='owner')=>({nmId:id,action,profile,participant_id:profile==='owner'?'local-owner':'local-wife',ts:now-1000,features:{'visual.style=gothic':1}});
const input=ratings=>({version:2,ratings,profiles:{owner:{preferred:[{key:'visual.style=gothic'}]}}});

test('same candidate pool, explicit negatives cannot be rescued by positive category or score',()=>{
  const state=input([vote(1,'like'),vote(2,'more'),vote(3,'like'),vote(4,'like'),vote(5,'dislike'),vote(6,'block_similar')]);
  const x=recommendForProfiles(products,state,{now});
  assert.equal(x.owner.items.length,12);assert.deepEqual(x.owner.items.map(r=>r.id),products.map(p=>p.id));
  for(const id of [5,6]){assert.ok(!x.owner.newIds.includes(id));assert.equal(x.owner.items.find(r=>r.id===id).newRank,null);assert.equal(x.owner.items.find(r=>r.id===id).exclusion,'EXPLICIT_NEGATIVE');}
  assert.equal(x.owner.metrics.explicitNegativesExcluded,2);assert.equal(x.owner.metrics.freshPublishable,0);
  assert.ok(x.owner.items.every(r=>r.traits.length===0));assert.equal(x.owner.metrics.newItemGeneralizationProven,false);
});
test('owner/wife votes do not leak; liked items are labelled memory and unknown proposals separate',()=>{
  const x=recommendForProfiles(products,input([vote(1,'like'),vote(1,'dislike','wife')]),{now});
  assert.ok(x.owner.newIds.includes(1));assert.ok(!x.wife.newIds.includes(1));
  assert.match(x.owner.items.find(r=>r.id===1).reason,/не доказательство/);
  assert.equal(x.owner.metrics.knownPositiveSelected,1);assert.equal(x.owner.metrics.unratedSelected,9);
  assert.equal(x.owner.metrics.transferEvidenceSelected,0);
});
test('quality cannot be compensated by direct like; stale price is review-only, never eligibility',()=>{
  const poor=products.map(p=>p.id===1?{...p,reviews:1}:p),x=recommendForProfiles(poor,input([vote(1,'more')]),{now});
  assert.ok(!x.owner.newIds.includes(1));assert.equal(x.owner.items.find(r=>r.id===1).exclusion,'QUALITY_OR_STOCK_GATE');
  assert.ok(x.owner.items.every(r=>!r.eligibleForPublication));assert.equal(x.owner.metrics.freshPublishable,0);
});
test('leave-one-out removes exact item plus evidence, absent support is not correct prediction',()=>{
  const x=recommendForProfiles(products,input([vote(1,'like'),vote(2,'like'),vote(3,'like'),vote(4,'dislike'),vote(5,'dislike')]),{now});
  assert.equal(x.owner.holdout.tested,5);assert.equal(x.owner.holdout.supported,0);assert.equal(x.owner.holdout.correct,0);assert.equal(x.owner.holdout.unknown,5);
  const y=recommendForProfiles(products,input(products.slice(0,7).map(p=>vote(p.id,'dislike'))),{now});
  assert.equal(y.owner.holdout.supported,7);assert.equal(y.owner.holdout.correct,7);assert.equal(y.owner.holdout.incorrect,0);
});
test('fully rated slate cannot prove recommendation of new things and input is immutable',()=>{
  const data=input(products.map(p=>vote(p.id,p.id%2?'like':'dislike','wife'))),before=JSON.stringify(data),catalog=JSON.stringify(products);
  const x=recommendForProfiles(products,data,{now});assert.equal(x.wife.metrics.unrated,0);assert.equal(x.wife.metrics.unratedSelected,0);assert.match(x.wife.note,/НЕ доказывает/);
  assert.equal(JSON.stringify(data),before);assert.equal(JSON.stringify(products),catalog);
});
test('mismatched cached image traits cannot enter candidate score or explanation',()=>{
  const traitsById={1:{group:'bag',imageHash:'b'.repeat(64),reviewed:true,cacheVerified:true,fields:{color:{value:'black',confidence:.95,evidence:'Clearly visible black front'}}}};
  const x=recommendForProfiles(products,input([vote(1,'like')]),{now,traitsById});assert.deepEqual(x.owner.items[0].traits,[]);
});
test('neutral ablation shares hard constraints and direct memory with feature model',()=>{
  const x=recommendForProfiles(products,input([vote(1,'like'),vote(2,'dislike'),vote(3,'block_similar')]),{now});
  for(const id of [2,3]){assert.ok(!x.owner.baselineIds.includes(id));assert.ok(!x.owner.newIds.includes(id));}
  assert.deepEqual(x.owner.baselineIds,x.owner.newIds);
});
test('held out identical images/families cannot leak labels into training',()=>{
  const copy=products.map(p=>p.id===2?{...p,imageHash:products[0].imageHash}:p),x=recommendForProfiles(copy,input(copy.slice(0,6).map(p=>vote(p.id,'like'))),{now});
  assert.deepEqual(x.owner.holdout.predictions.find(p=>p.id===1).excludedTrainingIds,[1,2]);
  assert.equal(x.owner.holdout.predictions.find(p=>p.id===1).supported,false);
});
test('batch/limit/counter bounds cannot trigger unbounded scoring',()=>{
  assert.throws(()=>recommendForProfiles([...products,...Array.from({length:100},(_,i)=>({...products[0],id:i+30}))],input([]),{now}),/INVALID_OPTIONS/);
  assert.throws(()=>recommendForProfiles(products,input([]),{now,limit:11}),/INVALID_OPTIONS/);
  assert.throws(()=>recommendForProfiles(products,input([]),{now,legacyCounter:-1}),/INVALID_OPTIONS/);
});
test('all SHADOW selection paths reject exact dislike despite positive category; no blanket ban',()=>{
  const fresh=products.map(p=>({...p,available:true,priceSource:'wb_card',currency:'RUB',observedAt:now}));
  let state=createTasteState();for(let i=1;i<=6;i++)state=setTasteRating(state,{profile:'owner',nmId:i,action:i===6?'dislike':'like',product:fresh[i-1]},{now:now-1}).state;
  const profile=buildTasteProfile(state,'owner'),bad=rankProduct(fresh[5],{now,profile});
  assert.ok(bad.taste.score>0);assert.equal(bad.taste.rejected,true);assert.equal(bad.taste.blocked,false);assert.equal(bad.eligible,false);
  assert.ok(rankProduct(fresh[6],{now,profile}).eligible);
  assert.ok(!compareShadow(fresh,{now,profile}).selected.includes(6));assert.ok(!compareSameCandidates(fresh,{now,profile}).reviewOrder.includes(6));
});
