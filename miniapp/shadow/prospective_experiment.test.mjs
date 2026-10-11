// Unit fixtures only, not actual votes/photos or persisted experiment files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExperiment,rateExperiment,summarizeExperiment,EXPERIMENT_LIMITS} from './prospective_experiment.mjs';
import {createTasteState,setTasteRating} from './taste.mjs';
const NOW=Date.parse('2026-10-12T12:00:00Z');
const categories=['Футболки','Кроссовки','Сумки','Браслеты'];
const card=(id,category='Футболки',patch={})=>({id,name:`${category} новое изделие ${id}`,category,categoryVerified:true,brand:`fixture-brand-${id}`,image:`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`,localPhoto:`photos/${id}.webp`,imageHash:id.toString(16).padStart(64,'0'),photoVerifiedAt:NOW-50,rating:4.7,...patch});
const pool=Array.from({length:40},(_,i)=>card(100+i,categories[i%4]));
const old=Array.from({length:12},(_,i)=>card(i+1,i<6?'Футболки':'Кроссовки'));
const rawVote=(nmId,action='like',profile='owner',patch={})=>({profile,participant_id:`local-${profile}`,nmId,action,ts:NOW-1000,...patch});
function training(){let state=createTasteState();for(const product of old)for(const profile of ['owner','wife'])state=setTasteRating(state,{profile,nmId:product.id,product,action:(profile==='owner')===(product.category==='Футболки')?'like':'dislike'},{now:NOW-1000}).state;return state;}
const make=(products=pool,input=training(),patch={})=>createExperiment(products,input,{id:'fixture-experiment',now:NOW,trainingProducts:old,...patch});
const submit=(state,id,action='like',profile='owner',requestId=`request-${state.revision}`)=>rateExperiment(state,{experimentId:state.id,profile,id,action,revision:state.revision,requestId},{now:NOW+state.revision+1});

test('balanced20 unseen same-pool frozen ranks preserve independent owner/wife training',()=>{
  const state=make();assert.equal(state.candidateIds.length,20);assert.equal(state.selection.ready,true);assert.equal(state.selection.mode,'PHOTO_TASTE');
  assert.equal(state.selection.publicationAuthority,'NONE');assert.deepEqual(state.ratings,[]);assert.equal(state.revision,0);
  for(const profile of ['owner','wife']){
    const comparison=state.frozen.comparisons[profile];assert.deepEqual(comparison.candidateIds,state.candidateIds);
    for(const algorithm of ['legacy','new'])assert.deepEqual([...comparison[algorithm].order].sort((a,b)=>a-b),[...state.candidateIds].sort((a,b)=>a-b));
    assert.equal(state.frozen.profiles[profile].sampleProducts,12);assert.ok(state.frozen.profiles[profile].unknown.includes('style'));
    assert.ok(comparison.new.predictions.every(row=>row.publicationEligible===false));
  }
  assert.deepEqual(state.frozen.comparisons.owner.legacy,state.frozen.comparisons.wife.legacy);
  assert.notDeepEqual(state.frozen.comparisons.owner.new.order,state.frozen.comparisons.wife.new.order);
  assert.deepEqual(state.frozen.trainingState.audience,[]);
});

test('exclude every prior rating from either person including archived/expired ids, images/families',()=>{
  const history=training(),archived=card(50,'Книги');history.archive=[rawVote(50,'dislike','wife',{ts:NOW-100*86400000})];
  const familyOld={...old[0],brand:'brand-confirmed',name:'Футболка женская базовая хлопковая длинный рукав размер L'};
  const familyNew=card(901,'Футболки',{brand:familyOld.brand,name:'Футболка женская базовая хлопковая длинный рукав размер M'});
  const imageCopy=card(902,'Сумки',{imageHash:old[1].imageHash});
  const extra=[old[0],card(50),familyNew,imageCopy,card(903,'Сумки',{familyVerified:true,familyId:'same-parent'})];
  const previous=card(7,'Кроссовки',{familyVerified:true,familyId:'same-parent'}); // different category must NOT become a family.
  const state=make([...extra,...pool],history,{trainingProducts:[familyOld,...old.slice(1).map(p=>p.id===7?previous:p),archived]});
  for(const id of [1,50,901,902])assert.ok(!state.candidateIds.includes(id));
  assert.ok(state.frozen.excludedIds.includes(50));
  assert.equal(state.selection.rejectionCounts.PRIOR_RATED_NMID,2);assert.equal(state.selection.rejectionCounts.PRIOR_RATED_IMAGE,1);assert.equal(state.selection.rejectionCounts.PRIOR_RATED_NEAR_FAMILY,1);
  assert.ok(!state.selection.rejected.some(row=>row.id===903));
});

test('past test ratings exclude exposure only and never join frozen personal training',()=>{
  const priorTestRatings=[{profile:'wife',nmId:100,action:'more',ts:NOW-5}];
  const state=make(pool,training(),{priorTestRatings});assert.ok(!state.candidateIds.includes(100));
  assert.ok(state.frozen.excludedIds.includes(100));assert.equal(state.frozen.trainingState.ratings.length,24);
  assert.ok(!state.frozen.trainingState.ratings.some(row=>row.nmId===100));
});

test('unresolved archived metadata is reported honestly while its prior nmId remains excluded',()=>{
  const input=training();input.archive=[rawVote(500,'dislike','wife')];
  const state=make(pool,input);assert.ok(state.frozen.excludedIds.includes(500));
  assert.deepEqual(state.selection.exclusionProof.unresolvedPriorIds,[500]);assert.equal(state.selection.exclusionProof.resolvedMetadata,12);assert.equal(state.selection.exclusionProof.priorRatedIds,13);
  assert.match(state.selection.exclusionProof.note,/cannot be compared/);
});

test('photo proof/quality exclusions stay strict while UNKNOWN reviews/stock remain not publication-eligible',()=>{
  const invalid=[card(700,'Футболки',{available:false}),card(701,'Сумки',{rating:3.9}),card(702,'Браслеты',{reviews:0}),card(703,'Кроссовки',{price:0}),card(704,'Футболки',{imageHash:undefined}),card(705,'Футболки',{categoryVerified:false}),card(706,'Футболки',{photoVerifiedAt:NOW+10})];
  const state=make([...invalid,...pool]);assert.ok(state.products.every(product=>product.id<700));
  for(const reason of ['KNOWN_UNAVAILABLE','KNOWN_BAD_RATING','KNOWN_BAD_REVIEWS','KNOWN_INVALID_PRICE','PHOTO_NOT_VERIFIED','CATEGORY_NOT_CONFIRMED','PHOTO_TIMESTAMP_IN_FUTURE'])assert.equal(state.selection.rejectionCounts[reason],1);
  assert.ok(state.products.every(product=>product.reviews===undefined&&product.available===undefined&&product.price===undefined));
  assert.ok(state.frozen.comparisons.owner.new.predictions.every(row=>!row.publicationEligible&&row.price.valid===false));
});

test('deduplicate exact photos and conservative near-families within test, shortage never pads',()=>{
  const sparse=[...pool.slice(0,10),card(900,'Сумки',{imageHash:pool[2].imageHash}),pool[0]];
  const state=make(sparse);assert.equal(state.candidateIds.length,10);assert.equal(new Set(state.products.map(product=>product.imageHash)).size,10);
  assert.equal(state.selection.shortfall,10);assert.equal(state.selection.minimumShortfall,5);assert.equal(state.selection.ready,false);
  let rated=state;for(const id of rated.candidateIds)rated=submit(rated,id).state;
  const summary=summarizeExperiment(rated).profiles.owner;assert.equal(summary.complete,true);assert.equal(summary.readyToCompare,false);assert.equal(summary.results,null);
  const empty=make([]);assert.equal(empty.candidateIds.length,0);assert.equal(summarizeExperiment(empty).profiles.owner.complete,false);
});

test('snapshots immutable, independent of input changes and arbitrary client-derived preferences',()=>{
  const input=training(),products=structuredClone(pool),traitsById={};const before=JSON.stringify({input,products,traitsById});
  const state=make(products,input,{traitsById});assert.equal(JSON.stringify({input,products,traitsById}),before);
  const frozen=JSON.stringify(state.frozen),ids=JSON.stringify(state.candidateIds);
  input.ratings[0].action='block_similar';products[0].name='Changed after freeze';traitsById[100]={reviewed:true,cacheVerified:true};
  assert.equal(JSON.stringify(state.frozen),frozen);assert.equal(JSON.stringify(state.candidateIds),ids);
  assert.throws(()=>{state.frozen.comparisons.owner.new.order[0]=999;},TypeError);assert.throws(()=>{state.products[0].name='Mutate';},TypeError);
  const restored=JSON.parse(JSON.stringify(state));assert.deepEqual(summarizeExperiment(restored),summarizeExperiment(state));
});

test('idempotency replay survives stale revision and duplicate action adds a receipt not another vote',()=>{
  const initial=make(),id=initial.candidateIds[0],input={experimentId:initial.id,profile:'owner',id,action:'like',revision:0,requestId:'one-request'};
  const first=rateExperiment(initial,input,{now:NOW+1});assert.equal(first.changed,true);assert.equal(first.feedbackChanged,true);assert.equal(first.state.ratings.length,1);
  const second=submit(first.state,id,'like','owner','new-request');assert.equal(second.changed,true);assert.equal(second.feedbackChanged,false);assert.equal(second.state.ratings.length,1);assert.equal(second.state.revision,2);
  const replay=rateExperiment(second.state,input,{now:NOW+10});assert.equal(replay.state,second.state);assert.equal(replay.changed,false);assert.deepEqual(replay.receipt,first.receipt);
  assert.throws(()=>rateExperiment(second.state,{...input,action:'dislike'},{now:NOW+2}),/IDEMPOTENCY_CONFLICT/);
  assert.throws(()=>rateExperiment(first.state,{...input,requestId:'other-request'},{now:NOW+2}),/REVISION_CONFLICT/);
});

test('changing/undoing test votes is isolated from training/predictions and the other person',()=>{
  const initial=make(),frozen=JSON.stringify(initial.frozen),id=initial.candidateIds[0];
  let state=submit(initial,id,'like').state;state=submit(state,id,'dislike','wife').state;state=submit(state,id,'dislike','owner').state;
  assert.deepEqual(summarizeExperiment(state).profiles.owner.ratings,[{id,action:'dislike'}]);assert.deepEqual(summarizeExperiment(state).profiles.wife.ratings,[{id,action:'dislike'}]);
  state=submit(state,id,'undo','owner').state;assert.equal(state.ratings.length,1);assert.equal(state.ratings[0].profile,'wife');
  assert.equal(JSON.stringify(state.frozen),frozen);assert.equal(state.frozen.trainingState.ratings.length,24);
  assert.equal(summarizeExperiment(state).profiles.owner.results,null);assert.equal(initial.ratings.length,0);
});

test('comparison hidden until all manifest votes, not a rendered subset or training sample count',()=>{
  let state=make();for(const id of state.candidateIds.slice(0,19))state=submit(state,id).state;
  const pending=summarizeExperiment(state).profiles.owner;assert.equal(pending.rated,19);assert.equal(pending.target,20);assert.equal(pending.complete,false);assert.equal(pending.readyToCompare,false);assert.equal(pending.results,null);
  assert.equal(pending.remaining.length,1);assert.equal(summarizeExperiment(state).profiles.wife.results,null);
  state=submit(state,pending.remaining[0],'dislike').state;const done=summarizeExperiment(state).profiles.owner;
  assert.equal(done.complete,true);assert.equal(done.readyToCompare,true);assert.equal(done.results.trainingFeedbackAdded,0);assert.equal(done.results.causalUplift,null);
  assert.equal(done.results.legacy.topK,5);assert.equal(done.results.legacy.positiveInTopK+done.results.legacy.negativeInTopK,5);
  assert.equal(done.results.new.predictions.length,20);assert.equal(summarizeExperiment(state).profiles.wife.readyToCompare,false);
  state=submit(state,state.candidateIds[0],'undo').state;assert.equal(summarizeExperiment(state).profiles.owner.results,null);
});

test('neutral/unconfigured model abstains, never counts unknown as correct or invents an uplift',()=>{
  let state=make(pool,createTasteState());for(const id of state.candidateIds)state=submit(state,id,'more').state;
  const result=summarizeExperiment(state).profiles.owner.results;
  assert.equal(result.classification.predicted,0);assert.equal(result.classification.abstained,20);assert.equal(result.classification.correct,0);assert.equal(result.classification.accuracy,null);assert.equal(result.causalUplift,null);
  assert.ok(result.new.predictions.every(row=>row.direction==='unknown'&&row.tasteScore===null));assert.equal(result.trainingFeedbackAdded,0);
});

test('first completed test is durable across corrections/undo/restart and never relabeled as blind',()=>{
  let state=make();for(const id of state.candidateIds)state=submit(state,id).state;
  const original=summarizeExperiment(state).profiles.owner,first=JSON.stringify(original.firstResults),firstAt=original.firstCompletedAt,firstRevision=original.firstRevision;
  assert.equal(original.evaluationPhase,'COMPLETED_FIRST_PASS');assert.equal(original.evaluationCorrections,0);assert.equal(firstAt,state.updatedAt);
  assert.equal(original.firstResults.legacy.positiveInTopK,5);assert.equal(original.firstResults.new.positiveInTopK,5);
  state=submit(state,state.candidateIds[0],'dislike').state;
  let summary=summarizeExperiment(state).profiles.owner;assert.equal(summary.evaluationPhase,'POST_COMPLETION_CORRECTIONS');assert.equal(summary.evaluationCorrections,1);assert.equal(summary.firstCompletedAt,firstAt);assert.equal(summary.firstRevision,firstRevision);assert.equal(JSON.stringify(summary.firstResults),first);
  state=submit(state,state.candidateIds[0],'undo').state;state=JSON.parse(JSON.stringify(state));
  summary=summarizeExperiment(state).profiles.owner;assert.equal(summary.readyToCompare,false);assert.equal(summary.results,null);assert.equal(summary.evaluationCorrections,2);assert.equal(JSON.stringify(summary.firstResults),first);assert.equal(summary.evaluationPhase,'POST_COMPLETION_CORRECTIONS');
  state=submit(state,state.candidateIds[0],'more').state;assert.equal(summarizeExperiment(state).profiles.owner.evaluationCorrections,3);assert.equal(JSON.stringify(summarizeExperiment(state).profiles.owner.firstResults),first);
  state=submit(state,state.candidateIds[0],'more').state;assert.equal(summarizeExperiment(state).profiles.owner.evaluationCorrections,3);assert.equal(summarizeExperiment(state).profiles.wife.firstCompletedAt,null);
});

test('older freshly-created empty manifest may upgrade on a write, but a rated one cannot fake first pass',()=>{
  const empty=JSON.parse(JSON.stringify(make()));delete empty.completion;const before=JSON.stringify(empty);
  assert.equal(summarizeExperiment(empty).profiles.owner.firstCompletedAt,null);assert.equal(JSON.stringify(empty),before);
  const next=submit(empty,empty.candidateIds[0]).state;assert.ok(next.completion);assert.equal(next.completion.owner.firstCompletedAt,null);
  const invalid=JSON.parse(JSON.stringify(next));delete invalid.completion;assert.throws(()=>summarizeExperiment(invalid),/COMPLETION_MIGRATION_REQUIRED/);
});

test('training/exposure sources malformed or ambiguous are rejected, options are bounded',()=>{
  assert.throws(()=>make(pool,{version:1,ratings:[rawVote(1),rawVote(1,'dislike')],audience:[]}),/INVALID_TRAINING_HISTORY/);
  assert.throws(()=>make(pool,{version:1,ratings:[rawVote(1,'like','audience')],audience:[]}),/INVALID_TRAINING_HISTORY/);
  assert.throws(()=>make(pool,training(),{priorTestRatings:[{profile:'owner',nmId:'100',action:'like',ts:NOW-1}]}),/INVALID_EXCLUSION_HISTORY/);
  for(const patch of [{target:21},{min:14},{id:'not a safe id'},{legacyCounter:-1},{now:-1},{maxPerCategory:100}])assert.throws(()=>make(pool,training(),patch),/INVALID_OPTIONS/);
  const state=make();for(const patch of [{profile:'audience'},{id:1},{action:'forged'},{revision:-1},{requestId:'invalid secret ?'},{experimentId:'different'}])assert.throws(()=>rateExperiment(state,{experimentId:state.id,profile:'owner',id:state.candidateIds[0],action:'like',revision:0,requestId:'valid-id',...patch},{now:NOW+1}),/INVALID_RATING/);
});

test('deterministic blind order is independent of algorithms, pure reads/writes never invoke network',()=>{
  const fetchBefore=globalThis.fetch;globalThis.fetch=()=>{throw Error('MUST_NOT_FETCH');};
  try{const a=make(),b=make(pool,training(),{legacyCounter:8});assert.deepEqual(a.blindOrders,b.blindOrders);
    const snapshot=JSON.stringify(a);summarizeExperiment(a);submit(a,a.candidateIds[0]);assert.equal(JSON.stringify(a),snapshot);
  }finally{globalThis.fetch=fetchBefore;}
});

test('durable idempotency receipts have a hard bound and cannot be silently evicted',()=>{
  let state=make();for(let i=0;i<EXPERIMENT_LIMITS.maxRequests;i++)state=submit(state,state.candidateIds[0],'like','owner',`bounded-${i}`).state;
  assert.equal(state.ratings.length,1);assert.equal(state.receipts.length,500);
  assert.throws(()=>submit(state,state.candidateIds[0],'like','owner','over-limit'),/REQUEST_LIMIT/);
  const first={experimentId:state.id,profile:'owner',id:state.candidateIds[0],action:'like',revision:0,requestId:'bounded-0'};
  assert.equal(rateExperiment(state,first,{now:NOW+1000}).changed,false);
});
