// Isolated, prospective PHOTO-TASTE experiment. No I/O, API credentials, AI,
// production writers or runtime learning. Authentication belongs to the caller.
// Candidate/product/trait evidence must be server-resolved, never client data.
import {selectFashionCalibration,fashionCategory} from './calibration.mjs';
import {normalizeTasteInput,trustedTraitsForProduct} from './taste_report.mjs';
import {buildTasteProfile,TASTE_ACTIONS} from './taste.mjs';
import {compareSameCandidates} from './comparison.mjs';
import {choose} from '../cloudflare/native_scheduler.mjs';
import {VALUE_POLICY} from './value.mjs';

export const EXPERIMENT_VERSION=1;
export const EXPERIMENT_LIMITS=Object.freeze({maxPool:1000,maxRequests:500,min:15,target:20,topK:5});
const profiles=['owner','wife'];
const positive=new Set(['like','more']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const validId=value=>Number.isSafeInteger(value)&&value>0&&value<1e12;
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const validTime=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000;
const token=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const canonical=value=>typeof value==='string'?value.normalize('NFKC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' '):'';
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const counts=rows=>Object.fromEntries([...TASTE_ACTIONS,'total'].map(action=>[action,action==='total'?rows.length:rows.filter(row=>row.action===action).length]));
const emptyCompletion=()=>({firstCompletedAt:null,firstRevision:null,firstRatings:null,firstResults:null,corrections:0,lastCorrectionAt:null});

function sourceRows(input){
  if(typeof input==='string')input=JSON.parse(input.replace(/^\uFEFF/u,''));
  const rows=[...input.ratings,...(input.archive??[])];
  if(rows.length>EXPERIMENT_LIMITS.maxPool)throw Error('EXPERIMENT_HISTORY_TOO_LARGE');
  return rows;
}
function familyTokens(product){
  return new Set(canonical(product.name??product.title).replace(/(?<![\p{L}\p{N}])(?:size|размер)\s*[\dа-яa-z/-]+/gu,' ').replace(/\b(?:xxxl|xxl|xl|xs|xxs|s|m|l)\b/gu,' ').replace(/[^\p{L}\p{N} ]/gu,' ').split(/\s+/u).filter(word=>word.length>1));
}
function sameFamily(a,b){
  if(canonical(a.category)!==canonical(b.category))return false;
  if(a.familyVerified===true&&b.familyVerified===true&&a.familyId!=null&&b.familyId!=null&&String(a.familyId)!==''&&String(a.familyId)===String(b.familyId))return true;
  const brand=canonical(a.brand);if(!brand||brand==='unknown'||brand!==canonical(b.brand))return false;
  const x=familyTokens(a),y=familyTokens(b);if(Math.min(x.size,y.size)<4)return false;
  return [...x].filter(word=>y.has(word)).length/Math.max(1,new Set([...x,...y]).size)>=.9;
}
function knownInvalid(product,now){
  if(product.available===false)return 'KNOWN_UNAVAILABLE';
  if(typeof product.price==='number'&&(!Number.isFinite(product.price)||product.price<=0))return 'KNOWN_INVALID_PRICE';
  if(typeof product.rating==='number'&&(!Number.isFinite(product.rating)||product.rating<VALUE_POLICY.minRating||product.rating>5))return 'KNOWN_BAD_RATING';
  if(typeof product.reviews==='number'&&(!Number.isSafeInteger(product.reviews)||product.reviews<VALUE_POLICY.minReviews))return 'KNOWN_BAD_REVIEWS';
  if(Number.isSafeInteger(product.photoVerifiedAt)&&product.photoVerifiedAt>now)return 'PHOTO_TIMESTAMP_IN_FUTURE';
  return null;
}
const snapshotKeys=['id','name','title','category','categoryVerified','brand','query','type','audience','price','priceSource','currency','observedAt','available','rating','reviews','variantKey','variants','history','context','priceBasis','priceCondition','packCount','image','localPhoto','imageHash','photoVerifiedAt','familyId','familyVerified'];
function snapshot(product){return clone(Object.fromEntries(snapshotKeys.filter(key=>Object.hasOwn(product,key)).map(key=>[key,product[key]])));}
function blindOrder(ids,seed){
  // Deterministic presentation order unrelated to either algorithm's ranks.
  // This is not cryptographic authentication or evidence of randomized A/B.
  const hash=text=>{let value=2166136261;for(const char of text)value=Math.imul(value^char.charCodeAt(0),16777619)>>>0;return value;};
  return [...ids].sort((a,b)=>hash(`${seed}:${a}`)-hash(`${seed}:${b}`)||a-b);
}
function legacyRanking(products,counter){
  let rows=products.map(product=>({pid:product.id,topic:product.query||product.category,title_key:canonical(product.name).replace(/[^\p{L}\p{N}]/gu,''),checked_at:Number.isFinite(product.observedAt)?Math.floor(product.observedAt/1000):0,data:JSON.stringify({id:product.id,title:product.name,image:product.image,category:product.category,query:product.query})}));
  const order=[];
  while(rows.length){const picked=choose(rows,[],counter+order.length);if(!picked)throw Error('EXPERIMENT_LEGACY_RANK_INCOMPLETE');order.push(picked.pid);rows=rows.filter(row=>row.pid!==picked.pid);}
  return {order,predictions:order.map((id,index)=>({id,rank:index+1,counter:counter+index,direction:'unknown',confidence:'not_a_classifier',reasons:['Frozen native Legacy diversity ranking; no personal like/dislike probability is claimed.']}))};
}
function newRanking(products,profile,traitsById,now,legacyCounter){
  const result=compareSameCandidates(products,{profile,traitsById,now,legacyCounter});
  const rows=[...result.assessments].sort((a,b)=>Number(!!a.taste?.blocked)-Number(!!b.taste?.blocked)||b.reviewScore-a.reviewScore||a.id-b.id);
  return {order:rows.map(row=>row.id),predictions:rows.map((row,index)=>({id:row.id,rank:index+1,direction:row.taste?.blocked?'negative':row.taste?.supported&&row.taste.score!==0?(row.taste.score>0?'positive':'negative'):'unknown',tasteScore:row.taste?.supported?row.taste.score:null,reviewScore:row.reviewScore,supported:!!row.taste?.supported,confidence:row.taste?.uncertainty??'not_configured',blocked:!!row.taste?.blocked,matchedFeatures:clone(row.taste?.matchedFeatures??[]),reasons:[...row.reasons],publicationEligible:row.eligible,price:clone(row.value.price),criteria:clone(row.criteria)}))};
}

/** Freeze the entire candidate batch and pre-test training snapshot once.
 * Missing reviews/stock/current price stay UNKNOWN in PHOTO_TASTE mode and
 * never grant publication approval. Known invalid items are excluded.
 */
export function createExperiment(products,trainingInput,{id,now=Date.now(),trainingProducts=products,traitsById={},target=20,min=15,maxPerCategory=8,legacyCounter=0,priorTestRatings=[]}={}){
  if(!token(id)||!validTime(now)||!Array.isArray(products)||products.length>1000||!Array.isArray(trainingProducts)||trainingProducts.length>1000||!Number.isSafeInteger(target)||target<15||target>20||!Number.isSafeInteger(min)||min<15||min>target||!Number.isSafeInteger(maxPerCategory)||maxPerCategory<1||maxPerCategory>20||!Number.isSafeInteger(legacyCounter)||legacyCounter<0||legacyCounter>1e9||!Array.isArray(priorTestRatings)||priorTestRatings.length>1000)throw Error('EXPERIMENT_INVALID_OPTIONS');
  const catalog=new Map();
  for(const product of [...products,...trainingProducts])if(plain(product)&&validId(product.id)&&typeof product.name==='string'&&product.name.trim())catalog.set(product.id,product);
  if(catalog.size>1000)throw Error('EXPERIMENT_CATALOG_TOO_LARGE');
  const normalized=normalizeTasteInput(trainingInput,{products:[...catalog.values()],now,traitsById});
  if(normalized.validation.invalidRows||normalized.validation.ambiguousKeys)throw Error('EXPERIMENT_INVALID_TRAINING_HISTORY');
  const historyRows=[...sourceRows(trainingInput),...priorTestRatings];
  for(const row of historyRows)if(!plain(row)||!profiles.includes(row.profile)||row.participant_id!=null&&row.participant_id!==`local-${row.profile}`||!validId(row.nmId)||!TASTE_ACTIONS.includes(row.action)||!validTime(row.ts)||row.ts>now)throw Error('EXPERIMENT_INVALID_EXCLUSION_HISTORY');
  const excludedIds=[...new Set(historyRows.map(row=>row.nmId))].sort((a,b)=>a-b),known=new Set(excludedIds);
  const historical=excludedIds.map(nmId=>catalog.get(nmId)).filter(Boolean),oldHashes=new Set(historical.filter(product=>validHash(product.imageHash)).map(product=>product.imageHash.toLowerCase()));
  const rejected=[],eligible=[];
  const reject=(product,reason)=>rejected.push({id:validId(product?.id)?product.id:null,reason});
  for(const product of products){
    if(!plain(product)||!validId(product.id)||typeof product.name!=='string'||!product.name.trim()){reject(product,'INVALID_PRODUCT');continue;}
    let reason=known.has(product.id)?'PRIOR_RATED_NMID':validHash(product.imageHash)&&oldHashes.has(product.imageHash.toLowerCase())?'PRIOR_RATED_IMAGE':historical.some(old=>sameFamily(old,product))?'PRIOR_RATED_NEAR_FAMILY':knownInvalid(product,now);
    if(!reason&&eligible.some(prior=>sameFamily(prior,product)))reason='NEAR_IDENTICAL_TEST_FAMILY';
    if(reason){reject(product,reason);continue;}eligible.push(product);
  }
  // Reuse the existing strict proof/category/photo/diversity selector. Its
  // 30-card calibration minimum is NOT claimed here: only the first 15–20
  // independently selected items form this separate prospective experiment.
  const balanced=selectFashionCalibration(eligible,{target:30,min:30,maxPerCategory});
  rejected.push(...balanced.rejected);
  const selected=balanced.products.slice(0,target).map(snapshot),candidateIds=selected.map(product=>product.id),byGroup={},byCategory={};
  for(const product of selected){const {category,group}=fashionCategory(product);byCategory[category]=(byCategory[category]??0)+1;byGroup[group]=(byGroup[group]??0)+1;}
  const trainingState=clone(normalized.state);trainingState.audience=[];
  const trained=Object.fromEntries(profiles.map(profile=>[profile,buildTasteProfile(trainingState,profile)]));
  const selectedTraits=Object.fromEntries(selected.flatMap(product=>{const traits=trustedTraitsForProduct(product,traitsById);return traits?[[product.id,clone(traits)]]:[];}));
  const legacy=legacyRanking(selected,legacyCounter),comparisons=Object.fromEntries(profiles.map(profile=>[profile,{candidateIds:[...candidateIds],sameCandidateSet:true,legacy:clone(legacy),new:newRanking(selected,trained[profile],selectedTraits,now,legacyCounter)}]));
  const unresolvedPriorIds=excludedIds.filter(nmId=>!catalog.has(nmId));
  const exclusionProof={priorRatedIds:excludedIds.length,resolvedMetadata:historical.length,unresolvedPriorIds,knownImageHashes:oldHashes.size,note:unresolvedPriorIds.length?'All prior nmIds excluded, but old images/families cannot be compared for missing trusted metadata. Resolve historical metadata before claiming complete image/family exclusion coverage.':'All prior nmIds resolved against supplied historical catalog; exact image and conservative near-family checks applied.'};
  const selection={mode:'PHOTO_TASTE',publicationAuthority:'NONE',target,min,selected:selected.length,shortfall:Math.max(0,target-selected.length),minimumShortfall:Math.max(0,min-selected.length),ready:selected.length>=min,availableEligible:balanced.availableEligible,exclusionProof,breakdown:{byGroup,byCategory},rejected,rejectionCounts:Object.fromEntries([...new Set(rejected.map(row=>row.reason))].sort().map(reason=>[reason,rejected.filter(row=>row.reason===reason).length])),note:'Same unseen balanced candidate batch for both ranks. This evaluates photo taste, not whole-catalog discovery, live stock, bargain verification, publication eligibility or causal A/B uplift.'};
  return freeze({version:1,id,revision:0,createdAt:now,updatedAt:now,target,min,candidateIds,products:selected,blindOrders:Object.fromEntries(profiles.map(profile=>[profile,blindOrder(candidateIds,`${id}:${profile}`)])),selection,frozen:{createdAt:now,trainingState,profiles:trained,trainingValidation:clone(normalized.validation),excludedIds,traitsById:selectedTraits,comparisons,legacyCounter},ratings:[],completion:Object.fromEntries(profiles.map(profile=>[profile,emptyCompletion()])),receipts:[]});
}

function checkExperiment(state){
  if(!plain(state)||state.version!==1||!token(state.id)||!Number.isSafeInteger(state.revision)||state.revision<0||!validTime(state.createdAt)||!validTime(state.updatedAt)||state.updatedAt<state.createdAt||!Number.isSafeInteger(state.target)||state.target<15||state.target>20||!Number.isSafeInteger(state.min)||state.min<15||state.min>state.target||!Array.isArray(state.candidateIds)||state.candidateIds.length>state.target||!state.candidateIds.every(validId)||new Set(state.candidateIds).size!==state.candidateIds.length||!Array.isArray(state.products)||!Array.isArray(state.ratings)||!Array.isArray(state.receipts)||state.receipts.length>500||!plain(state.frozen)||state.frozen.createdAt!==state.createdAt||!plain(state.blindOrders))throw Error('EXPERIMENT_INVALID_STATE');
  if(state.products.length!==state.candidateIds.length||state.products.some(product=>!state.candidateIds.includes(product.id))||new Set(state.products.map(product=>product.id)).size!==state.candidateIds.length)throw Error('EXPERIMENT_INVALID_MANIFEST');
  if(!Array.isArray(state.frozen.excludedIds)||state.candidateIds.some(id=>state.frozen.excludedIds.includes(id))||!plain(state.frozen.trainingState)||!Array.isArray(state.frozen.trainingState.ratings)||!Array.isArray(state.frozen.trainingState.audience)||state.frozen.trainingState.audience.length||state.frozen.trainingState.ratings.some(row=>!profiles.includes(row.profile)||!validTime(row.ts)||row.ts>state.createdAt||state.candidateIds.includes(row.nmId)))throw Error('EXPERIMENT_INVALID_TRAINING_SNAPSHOT');
  const keys=new Set();
  for(const row of state.ratings){const key=`${row.profile}:${row.nmId}`;if(!profiles.includes(row.profile)||!state.candidateIds.includes(row.nmId)||!TASTE_ACTIONS.includes(row.action)||!validTime(row.ts)||row.ts<state.createdAt||row.ts>state.updatedAt||keys.has(key))throw Error('EXPERIMENT_INVALID_TEST_RATINGS');keys.add(key);}
  for(const profile of profiles){const order=state.blindOrders[profile],comparison=state.frozen.comparisons?.[profile];if(!Array.isArray(order)||order.length!==state.candidateIds.length||new Set(order).size!==order.length||order.some(id=>!state.candidateIds.includes(id))||!comparison||['legacy','new'].some(algorithm=>!Array.isArray(comparison[algorithm]?.order)||comparison[algorithm].order.length!==state.candidateIds.length||new Set(comparison[algorithm].order).size!==state.candidateIds.length||comparison[algorithm].order.some(id=>!state.candidateIds.includes(id))||!Array.isArray(comparison[algorithm].predictions)||comparison[algorithm].predictions.length!==state.candidateIds.length||comparison[algorithm].predictions.some((row,index)=>row.id!==comparison[algorithm].order[index]||row.rank!==index+1||!['positive','negative','unknown'].includes(row.direction))))throw Error('EXPERIMENT_INVALID_FROZEN_RANKS');}
  // Backward compatible only with the root's just-created EMPTY first manifest.
  // Never invent a blind first-pass receipt for an already-rated old snapshot.
  if(state.completion==null){if(state.ratings.length)throw Error('EXPERIMENT_COMPLETION_MIGRATION_REQUIRED');return;}
  for(const profile of profiles){const record=state.completion[profile];if(!plain(record)||!Number.isSafeInteger(record.corrections)||record.corrections<0||record.corrections>state.revision)throw Error('EXPERIMENT_INVALID_COMPLETION');
    if(record.firstCompletedAt===null){if(record.firstRevision!==null||record.firstRatings!==null||record.firstResults!==null||record.corrections!==0||record.lastCorrectionAt!==null)throw Error('EXPERIMENT_INVALID_COMPLETION');}
    else if(!validTime(record.firstCompletedAt)||record.firstCompletedAt<state.createdAt||record.firstCompletedAt>state.updatedAt||!Number.isSafeInteger(record.firstRevision)||record.firstRevision<1||record.firstRevision>state.revision||!Array.isArray(record.firstRatings)||record.firstRatings.length!==state.candidateIds.length||new Set(record.firstRatings.map(row=>row.nmId)).size!==state.candidateIds.length||record.firstRatings.some(row=>row.profile!==profile||!state.candidateIds.includes(row.nmId)||!TASTE_ACTIONS.includes(row.action)||!validTime(row.ts)||row.ts<state.createdAt||row.ts>record.firstCompletedAt)||!plain(record.firstResults)||state.candidateIds.length<state.min||record.corrections>0&&(!validTime(record.lastCorrectionAt)||record.lastCorrectionAt<record.firstCompletedAt||record.lastCorrectionAt>state.updatedAt))throw Error('EXPERIMENT_INVALID_COMPLETION');
  }
}

/** Caller must persist state atomically and use its existing owner/CSRF gate.
 * No-op votes still get a bounded receipt/revision; replay returns unchanged
 * state before revision validation, so a lost response can be retried safely.
 */
export function rateExperiment(state,input,{now=Date.now()}={}){
  checkExperiment(state);
  if(!plain(input)||input.experimentId!==state.id||!profiles.includes(input.profile)||!validId(input.id)||!state.candidateIds.includes(input.id)||![...TASTE_ACTIONS,'undo'].includes(input.action)||!Number.isSafeInteger(input.revision)||input.revision<0||!token(input.requestId)||!validTime(now)||now<state.createdAt)throw Error('EXPERIMENT_INVALID_RATING');
  const payload={experimentId:state.id,profile:input.profile,id:input.id,action:input.action,revision:input.revision};
  const replay=state.receipts.find(row=>row.requestId===input.requestId);
  if(replay){if(JSON.stringify(replay.payload)!==JSON.stringify(payload))throw Error('EXPERIMENT_IDEMPOTENCY_CONFLICT');return {state,changed:false,feedbackChanged:false,receipt:clone(replay.receipt)};}
  if(input.revision!==state.revision)throw Error('EXPERIMENT_REVISION_CONFLICT');
  if(state.receipts.length>=EXPERIMENT_LIMITS.maxRequests)throw Error('EXPERIMENT_REQUEST_LIMIT');
  const index=state.ratings.findIndex(row=>row.profile===input.profile&&row.nmId===input.id),prior=index>=0?state.ratings[index]:null;
  const feedbackChanged=input.action==='undo'?!!prior:prior?.action!==input.action,ratings=clone(state.ratings),ts=Math.max(now,state.updatedAt);
  if(feedbackChanged){if(input.action==='undo')ratings.splice(index,1);else{const vote={profile:input.profile,nmId:input.id,action:input.action,ts};if(index>=0)ratings[index]=vote;else ratings.push(vote);}}
  const receipt={requestId:input.requestId,experimentId:state.id,profile:input.profile,id:input.id,action:input.action,currentAction:input.action==='undo'?null:input.action,revision:state.revision+1,feedbackChanged,at:ts};
  const completion=Object.fromEntries(profiles.map(profile=>[profile,clone(state.completion?.[profile]??emptyCompletion())]));
  const record=completion[input.profile],personal=ratings.filter(row=>row.profile===input.profile);
  if(record.firstCompletedAt===null&&personal.length===state.candidateIds.length&&personal.length>=state.min){record.firstCompletedAt=ts;record.firstRevision=receipt.revision;record.firstRatings=clone(personal);record.firstResults=evaluate(state,input.profile,personal);}
  else if(record.firstCompletedAt!==null&&feedbackChanged){record.corrections++;record.lastCorrectionAt=ts;}
  const next=freeze({...state,revision:receipt.revision,updatedAt:ts,ratings,completion,receipts:[...state.receipts,{requestId:input.requestId,payload,receipt}]});
  return {state:next,changed:true,feedbackChanged,receipt:clone(receipt)};
}

function rankResult(rank,ratings,topK){
  const votes=new Map(ratings.map(row=>[row.nmId,row])),topIds=rank.order.slice(0,topK);
  return {order:[...rank.order],topK,topIds,positiveInTopK:topIds.filter(id=>positive.has(votes.get(id)?.action)).length,negativeInTopK:topIds.filter(id=>votes.has(id)&&!positive.has(votes.get(id).action)).length};
}
function classification(predictions,ratings){
  const votes=new Map(ratings.map(row=>[row.nmId,row])),matrix={truePositive:0,trueNegative:0,falsePositive:0,falseNegative:0},known=predictions.filter(row=>row.direction!=='unknown'&&votes.has(row.id));
  for(const prediction of known){const actualPositive=positive.has(votes.get(prediction.id).action),predictedPositive=prediction.direction==='positive';matrix[actualPositive?(predictedPositive?'truePositive':'falseNegative'):(predictedPositive?'falsePositive':'trueNegative')]++;}
  const correct=matrix.truePositive+matrix.trueNegative;
  return {predicted:known.length,abstained:predictions.length-known.length,correct,wrong:known.length-correct,matrix,accuracy:known.length>=10?correct/known.length:null,accuracyMinimum:10,note:'Uncalibrated test diagnostics only. Abstentions are not correct predictions; Legacy ranks are not a like/dislike classifier. No uplift or purchase probability is inferred.'};
}
function evaluate(state,profile,ratings){
  const comparison=state.frozen.comparisons[profile],topK=Math.min(EXPERIMENT_LIMITS.topK,state.candidateIds.length),legacy=rankResult(comparison.legacy,ratings,topK),next=rankResult(comparison.new,ratings,topK);
  return {frozenAt:state.frozen.createdAt,legacy,new:{...next,predictions:clone(comparison.new.predictions)},differenceInTopKPositive:next.positiveInTopK-legacy.positiveInTopK,classification:classification(comparison.new.predictions,ratings),trainingFeedbackAdded:0,causalUplift:null,note:'Prospective ranking evaluation on the same 15–20 unseen cards. Test votes are separate; rankings/predictions were frozen beforehand. Not whole-catalog selection or a randomized A/B deployment.'};
}

/** Pure read: test ratings never enter the frozen training/model snapshot.
 * Do not expose the raw frozen state via an HTTP route before completion.
 * Server must project only the selected personal profile in its public reply.
 */
export function summarizeExperiment(state){
  checkExperiment(state);
  const summaries={};
  for(const profile of profiles){
    const ratings=state.ratings.filter(row=>row.profile===profile),rated=new Set(ratings.map(row=>row.nmId)),remaining=state.blindOrders[profile].filter(id=>!rated.has(id));
    const complete=state.candidateIds.length>0&&remaining.length===0,readyToCompare=complete&&state.candidateIds.length>=state.min;
    const record=state.completion?.[profile]??emptyCompletion(),results=readyToCompare?evaluate(state,profile,ratings):null;
    summaries[profile]={rated:ratings.length,remaining,target:state.candidateIds.length,complete,readyToCompare,ratings:ratings.map(row=>({id:row.nmId,action:row.action})),counts:counts(ratings),firstCompletedAt:record.firstCompletedAt,firstRevision:record.firstRevision,firstResults:record.firstResults?clone(record.firstResults):null,evaluationCorrections:record.corrections,lastCorrectionAt:record.lastCorrectionAt,evaluationPhase:record.firstCompletedAt===null?'BLIND_FIRST_PASS':record.corrections?'POST_COMPLETION_CORRECTIONS':'COMPLETED_FIRST_PASS',results};
  }
  return {version:1,id:state.id,revision:state.revision,createdAt:state.createdAt,selection:clone(state.selection),profiles:summaries};
}
