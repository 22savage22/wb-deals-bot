// Offline fixtures only. Never add synthetic ratings to the actual local file,
// Telegram, D1, production scheduler or the user's owner/wife profiles.
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSameCandidates} from './comparison.mjs';
import {choose} from '../cloudflare/native_scheduler.mjs';
import {rankProduct} from './ranking.mjs';
import {createTasteState,setTasteRating,buildTasteProfile} from './taste.mjs';

const NOW=Date.parse('2026-10-11T12:00:00Z');
const DAY=86400000;
const product=(id,patch={})=>({id,name:`Футболка мужская Unit ${id}`,category:'Футболки',categoryVerified:true,type:'Футболки',query:'футболка мужская',price:650,oldPrice:100000,rating:4.7,reviews:100,available:null,observedAt:NOW-3*DAY,priceSource:'legacy_snapshot',currency:'RUB',variantKey:'unknown',context:null,image:`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`,history:[{at:NOW-8*DAY,price:800,source:'legacy_observation',variantKey:'unknown',context:null}],...patch});
const rowsOf=products=>products.map(p=>({pid:p.id,topic:p.query||p.category,title_key:String(p.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),checked_at:Math.floor(p.observedAt/1000),data:JSON.stringify({id:p.id,title:p.name,image:p.image,category:p.category,query:p.query})}));
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;}

test('both algorithms inspect exactly the original candidate ids and factual snapshot values',()=>{
  const pool=[product(1),product(2,{name:'Платье женское Unit',category:'Платья',query:'платье женское',price:1200}),product(3,{name:'Сумка женская Unit',category:'Сумки',query:'сумка женская',price:300})];
  const result=compareSameCandidates(pool,{now:NOW,legacyCounter:2});
  assert.equal(result.sameCandidateSet,true);
  assert.deepEqual(result.candidateIds,pool.map(p=>p.id));
  assert.deepEqual(result.assessments.map(row=>row.id),pool.map(p=>p.id));
  assert.equal(result.legacyPick,choose(rowsOf(pool),[],2).pid);
  assert.ok(result.candidateIds.includes(result.legacyPick));
  for(const assessment of result.assessments){const original=pool.find(p=>p.id===assessment.id),expected=rankProduct(original,{now:NOW,comparables:pool,seenIds:[],recent:[]});assert.deepEqual(assessment,expected);assert.equal(assessment.value.price.price,original.price);assert.equal(assessment.value.price.observedAt,new Date(original.observedAt).toISOString());}
});

test('comparison cannot mutate frozen cards, nested history, ordering, or taste profile',()=>{
  const pool=freeze([product(2),product(1)]),before=JSON.stringify(pool),profile=freeze(buildTasteProfile(createTasteState(),'owner'));
  const profileBefore=JSON.stringify(profile);
  assert.doesNotThrow(()=>compareSameCandidates(pool,{now:NOW,profile,legacyCounter:0}));
  assert.equal(JSON.stringify(pool),before);
  assert.equal(JSON.stringify(profile),profileBefore);
});

test('historical review order is not publication permission or a claim of current bargains',()=>{
  const pool=[product(1),product(2,{price:100,rating:5})];
  const result=compareSameCandidates(pool,{now:NOW});
  assert.equal(result.reviewOnly,true);
  assert.equal(result.publicationAuthority,'LEGACY_UNCHANGED');
  assert.equal(result.mode,'SHADOW');
  assert.equal(result.newPick,null);
  assert.deepEqual(result.selected,[]);
  assert.deepEqual(new Set(result.reviewOrder),new Set([1,2]));
  assert.ok(result.assessments.every(row=>!row.eligible&&row.score===null&&row.value.price.valid===false&&row.criteria.priceConfidence===0));
  assert.ok(result.assessments.every(row=>row.value.rejectedReasons.includes('price_not_fresh_verified')&&row.value.rejectedReasons.includes('availability_unknown')));
  assert.match(result.comparisonNote,/не replay production/);
  assert.match(result.comparisonNote,/не разрешает публикацию/);
});

test('no invented uplift, style profile, observed price refresh, or seller-discount reward',()=>{
  const plain=[product(1,{oldPrice:undefined})],claimed=[product(1,{oldPrice:1000000})];
  const first=compareSameCandidates(plain,{now:NOW}),second=compareSameCandidates(claimed,{now:NOW});
  assert.equal(first.assessments[0].reviewScore,second.assessments[0].reviewScore);
  for(const result of [first,second]){
    assert.ok(!Object.hasOwn(result,'uplift'));
    assert.ok(!Object.hasOwn(result,'improvementPercent'));
    assert.ok(!Object.hasOwn(result,'accuracy'));
    assert.equal(result.assessments[0].taste,null);
    assert.equal(result.assessments[0].value.price.observedAt,new Date(NOW-3*DAY).toISOString());
    assert.equal(result.assessments[0].value.history.known,false);
    assert.equal(result.assessments[0].value.market.known,false);
    assert.equal(result.assessments[0].criteria.preferences,50);
  }
});

test('owner and wife are neutral until genuine fixture ratings; no audience spillover or guessed style',()=>{
  const pool=Array.from({length:6},(_,index)=>product(index+1,{observedAt:NOW-1000}));
  let state=createTasteState();
  const initialOwner=compareSameCandidates(pool,{now:NOW,profile:buildTasteProfile(state,'owner')});
  const initialWife=compareSameCandidates(pool,{now:NOW,profile:buildTasteProfile(state,'wife')});
  assert.ok(initialOwner.assessments.every(row=>row.taste.score===0&&!row.taste.configured));
  assert.ok(initialWife.assessments.every(row=>row.taste.score===0&&!row.taste.configured));
  for(let id=1;id<=5;id++){
    state=setTasteRating(state,{profile:'owner',nmId:id,action:'like',product:pool[id-1]},{now:NOW}).state;
    state=setTasteRating(state,{profile:'wife',nmId:id,action:'dislike',product:pool[id-1]},{now:NOW}).state;
  }
  const owner=buildTasteProfile(state,'owner'),wife=buildTasteProfile(state,'wife'),audience=buildTasteProfile(state,'audience');
  const ownerResult=compareSameCandidates(pool,{now:NOW,profile:owner}),wifeResult=compareSameCandidates(pool,{now:NOW,profile:wife});
  assert.ok(ownerResult.assessments.every(row=>row.taste.score>0&&row.criteria.preferences>50));
  assert.ok(wifeResult.assessments.every(row=>row.taste.score<0&&row.criteria.preferences<50));
  assert.equal(audience.sampleProducts,0);
  for(const profile of [owner,wife]){assert.ok(profile.unknown.includes('style'));assert.ok(profile.unknown.includes('color'));assert.ok(profile.unknown.includes('fit'));assert.ok(!profile.evidence.some(row=>row.key.startsWith('visual.')));}
  assert.deepEqual(ownerResult.candidateIds,wifeResult.candidateIds);
  // Owner ratings do not alter Legacy selection or promote stale source prices.
  assert.equal(ownerResult.legacyPick,wifeResult.legacyPick);
  assert.equal(ownerResult.newPick,null);
  assert.equal(wifeResult.newPick,null);
});

test('deterministic explicit legacyCounter preserves the existing diversity cycle',()=>{
  const pool=[product(1),product(2,{name:'Платье женское',category:'Платья',query:'платье женское'}),product(3,{name:'Сумка женская',category:'Сумки',query:'сумка женская'}),product(4,{name:'Ремень женский',category:'Ремни',query:'ремень женский'}),product(5,{name:'Кепка женская',category:'Кепки',query:'кепка женская'}),product(6,{name:'Серьги женские',category:'Серьги',query:'серьги женские'})];
  for(const [counter,expectedId] of [[0,3],[1,1],[2,2],[5,4],[10,5],[15,6],[20,3]]){
    const first=compareSameCandidates(pool,{now:NOW,legacyCounter:counter}),second=compareSameCandidates(pool,{now:NOW,legacyCounter:counter});
    assert.equal(first.legacyCounter,counter);
    assert.equal(first.legacyPick,expectedId);
    assert.deepEqual(first,second);
    assert.deepEqual(first.candidateIds,pool.map(p=>p.id));
  }
});

test('review sorting is deterministic with tie breaker and remains separate from eligibility',()=>{
  const pool=[product(9),product(2),product(7)];
  const result=compareSameCandidates(pool,{now:NOW});
  assert.deepEqual(result.reviewOrder,[2,7,9]);
  assert.deepEqual(result.candidateIds,[9,2,7]);
  assert.deepEqual(result.selected,[]);
  assert.ok(result.assessments.every(row=>row.reviewScore>=0&&row.score===null));
});

test('empty and bounded batches do not invent ids or run network calls',()=>{
  const previousFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=()=>{calls++;throw Error('OFFLINE_COMPARISON_MUST_NOT_FETCH');};
  try{
    const result=compareSameCandidates([],{now:NOW});
    assert.deepEqual(result.candidateIds,[]);
    assert.deepEqual(result.reviewOrder,[]);
    assert.equal(result.legacyPick,null);
    assert.equal(result.newPick,null);
    assert.doesNotThrow(()=>compareSameCandidates([product(1)],{now:NOW}));
    assert.throws(()=>compareSameCandidates(Array.from({length:101},(_,i)=>product(i+1)),{now:NOW}),/max100/);
    assert.equal(calls,0);
  }finally{globalThis.fetch=previousFetch;}
});
