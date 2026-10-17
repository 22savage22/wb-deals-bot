// Infrastructure fixtures only. They never stand in for real owner/wife votes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFirstPass,assessNextPool} from './prospective_diagnostics.mjs';
import {createExperiment,rateExperiment} from './prospective_experiment.mjs';
import {createTasteState,setTasteRating} from './taste.mjs';
const NOW=Date.parse('2026-10-12T12:00:00Z');
const categories=['Футболки','Кроссовки','Сумки','Серьги'];
const card=(id,category='Футболки')=>({id,name:`Разные реальные вещи fixture ${id}`,brand:`brand-${id}`,category,categoryVerified:true,
  image:`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`,localPhoto:`photos/${id}.webp`,
  imageHash:id.toString(16).padStart(64,'0'),photoVerifiedAt:NOW-10});
const old=Array.from({length:6},(_,i)=>card(i+1));
const pool=Array.from({length:40},(_,i)=>card(100+i,categories[i%4]));
function initial(){let history=createTasteState();for(const p of old)for(const person of ['owner','wife'])history=setTasteRating(history,{profile:person,nmId:p.id,product:p,action:person==='owner'?'dislike':'like'},{now:NOW-100}).state;
  return createExperiment(pool,history,{id:'audit-fixture',now:NOW,trainingProducts:old});}
function completed(actionFor=(person)=>person==='owner'?'dislike':'like'){let state=initial();for(const person of ['owner','wife'])for(const id of state.candidateIds)state=rateExperiment(state,{experimentId:state.id,profile:person,id,action:actionFor(person,id),revision:state.revision,requestId:`vote-${state.revision}`},{now:NOW+state.revision+1}).state;return state;}
test('first-pass audit recomputes receipts, preserves separate people, counts unknown honestly',()=>{
  const state=completed(),bytes=JSON.stringify(state),audit=auditFirstPass(state);
  assert.equal(audit.profiles.owner.evaluated,20);assert.equal(audit.profiles.owner.classification.defined,5);
  assert.equal(audit.profiles.owner.classification.unknown,15);assert.equal(audit.profiles.owner.classification.conditionalAccuracy,null);
  assert.equal(audit.profiles.owner.categoryOnlyPredictions,5);assert.equal(audit.profiles.owner.reviewedCandidateProfiles,0);
  assert.deepEqual(audit.profiles.owner.supportedFeatureFamilies,{category:5});
  assert.equal(audit.agreement.opposite.length,20);assert.deepEqual(audit.agreement.bothPositive,[]);
  assert.equal(audit.newQualityClaim,null);assert.equal(audit.rankingsChanged,0);assert.equal(JSON.stringify(state),bytes);
});
test('later corrections/undo do not masquerade as a new blind pass or alter initial metrics',()=>{
  let state=completed();const before=auditFirstPass(state),id=state.candidateIds[0];
  state=rateExperiment(state,{experimentId:state.id,profile:'owner',id,action:'undo',revision:state.revision,requestId:'later-undo'},{now:NOW+1000}).state;
  const after=auditFirstPass(state);assert.deepEqual(after.profiles.owner.classification,before.profiles.owner.classification);
  assert.deepEqual(after.profiles.owner.top5,before.profiles.owner.top5);assert.equal(after.profiles.owner.evaluated,20);
  assert.equal(after.profiles.owner.correctionsAfterFirstPass,1);assert.deepEqual(after.profiles.wife,before.profiles.wife);
});
test('missing first-pass receipt or inconsistent persisted metric fails closed',()=>{
  assert.throws(()=>auditFirstPass(initial()),/FIRST_PASS_INCOMPLETE/);
  const state=structuredClone(completed());state.completion.wife.firstResults.classification.correct++;
  assert.throws(()=>auditFirstPass(state),/RECEIPT_MISMATCH/);
});
test('receipt cannot weaken canonical accuracy minimum or relabel top1 as top5',()=>{
  const complete=completed();
  for(const corrupt of [
    s=>{s.completion.owner.firstResults.classification.accuracyMinimum=1;},
    s=>{s.completion.owner.firstResults.classification.accuracy=1;},
    s=>{s.completion.owner.firstResults.legacy.topK=1;s.completion.owner.firstResults.new.topK=1;},
    s=>{s.completion.owner.firstResults.new.topIds=s.completion.owner.firstResults.new.topIds.slice(0,1);},
    s=>{s.completion.owner.firstResults.legacy.negativeInTopK=0;},
  ]){const state=structuredClone(complete);corrupt(state);assert.throws(()=>auditFirstPass(state),/RECEIPT_MISMATCH/);}
});
test('unknown reason distinguishes absent category from insufficient category evidence',()=>{
  const state=completed(),audit=auditFirstPass(state);assert.equal(audit.profiles.owner.unknownCategoryEvidence.absent,15);
  assert.ok(audit.profiles.owner.unknown.every(row=>row.categorySupport===0&&row.reason==='no_matching_evidence'));
});
test('false positives/negatives and category evidence are separated by person',()=>{
  const state=completed((person,id)=>id===100?(person==='owner'?'like':'block_similar'):(person==='owner'?'dislike':'like'));
  const audit=auditFirstPass(state);
  assert.equal(audit.profiles.owner.errors.length,1);assert.equal(audit.profiles.owner.errors[0].type,'false_negative');
  assert.equal(audit.profiles.wife.errors.length,1);assert.equal(audit.profiles.wife.errors[0].type,'false_positive');
  assert.deepEqual(audit.profiles.wife.errors[0].matchedFeatures.map(row=>row.key),['category=Футболки']);
  assert.equal(audit.profiles.owner.errors[0].actualAction,'like');assert.equal(audit.profiles.wife.errors[0].actualAction,'block_similar');
});
test('support below minimum is not mislabeled missing or silently promoted to a prediction',()=>{
  let history=createTasteState();const training=old.map((p,i)=>({...p,category:i<4?'Футболки':'Кроссовки'}));
  for(const p of training)for(const person of ['owner','wife'])history=setTasteRating(history,{profile:person,nmId:p.id,product:p,action:'like'},{now:NOW-100}).state;
  let state=createExperiment(pool,history,{id:'low-support',now:NOW,trainingProducts:training});
  for(const person of ['owner','wife'])for(const id of state.candidateIds)state=rateExperiment(state,{experimentId:state.id,profile:person,id,action:'like',revision:state.revision,requestId:`low-${state.revision}`},{now:NOW+state.revision+1}).state;
  const audit=auditFirstPass(state);assert.equal(audit.profiles.wife.unknownCategoryEvidence.below_minimum,5);
  assert.ok(audit.profiles.wife.unknown.filter(row=>row.category==='Кроссовки').every(row=>row.categorySupport===2&&row.requiredCategorySupport===3));
});
const hashes=rows=>Object.fromEntries(rows.map(p=>[p.id,p.imageHash]));
test('next holdout excludes both profiles, archives and ALL exposure even without surviving votes',()=>{
  const history={ratings:[{profile:'owner',nmId:100},{profile:'wife',nmId:101}],archive:[{profile:'wife',nmId:102}]};
  const options={exposedProducts:[pool[3]],historicalProducts:pool.slice(0,3),photoHashesById:hashes(pool)};
  const result=assessNextPool(pool,history,options);assert.equal(result.verifiedUnseenPhotos,36);
  assert.equal(result.futureRankingsCreated,0);assert.equal(result.futureVotesCreated,0);
  assert.equal(result.ready,false);assert.ok(result.reasons.includes('REVIEWED_VISUAL_COVERAGE_INCOMPLETE'));
  assert.equal(result.unresolvedPriorMetadata,0);
});
test('number alone cannot launch a clothing-only broad fashion test or pad missing groups',()=>{
  const rows=Array.from({length:20},(_,i)=>card(500+i,i%2?'Худи':'Футболки'));
  const result=assessNextPool(rows,{ratings:[]},{photoHashesById:hashes(rows)});
  assert.equal(result.verifiedUnseenPhotos,20);assert.equal(result.selectedPhotos,16); // cap8 per category
  assert.deepEqual(result.missingGroups,['shoes','bags','accessories']);assert.equal(result.ready,false);
  assert.ok(result.reasons.includes('FASHION_GROUPS_MISSING'));
});
test('tampered/missing bytes and known photos are excluded, unresolved old family proof stays explicit',()=>{
  const bytes=hashes(pool);bytes[100]='f'.repeat(64);delete bytes[101];
  const result=assessNextPool(pool,{ratings:[{profile:'wife',nmId:999}]},{historicalProducts:[card(999)],photoHashesById:bytes});
  assert.equal(result.verifiedUnseenPhotos,38);
  const unresolved=assessNextPool(pool,{ratings:[{profile:'owner',nmId:998}]},{photoHashesById:hashes(pool)});
  assert.equal(unresolved.unresolvedPriorMetadata,1);assert.ok(unresolved.reasons.includes('HISTORICAL_FAMILY_METADATA_INCOMPLETE'));
  const oldImage=card(999);oldImage.imageHash=pool[0].imageHash;
  assert.equal(assessNextPool(pool,{ratings:[{profile:'wife',nmId:999}]},{historicalProducts:[oldImage],photoHashesById:hashes(pool)}).verifiedUnseenPhotos,39);
});
