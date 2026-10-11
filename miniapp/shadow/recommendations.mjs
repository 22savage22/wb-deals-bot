// Offline, bounded counterfactual. No AI, D1, Telegram or production mutation.
// Exact-item constraints, feature transfer and holdout are deliberately separate.
import {choose} from '../cloudflare/native_scheduler.mjs';
import {rankProduct,similarity} from './ranking.mjs';
import {buildTasteProfile,tasteFeatures} from './taste.mjs';
import {normalizeTasteInput,trustedTraitsForProduct} from './taste_report.mjs';
import {tasteFeatureLabel} from './calibration.mjs';
const positive=new Set(['like','more']),negative=new Set(['dislike','block_similar']);
const round=n=>Math.round(n*10000)/10000;
const byScore=(a,b)=>b.reviewScore-a.reviewScore||a.id-b.id;
const rowsOf=products=>products.map(p=>({pid:p.id,topic:p.query||p.category,title_key:String(p.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),checked_at:Math.floor(p.observedAt/1000),data:JSON.stringify({id:p.id,title:p.name,image:p.image,category:p.category,query:p.query})}));

function legacyOrder(products,counter){
  // Full order, not a historical production replay: same snapshot/empty recent
  // at each selection, same initial counter; chosen item removed to avoid repeats.
  const pool=rowsOf(products),ids=[];
  while(pool.length){const chosen=choose(pool,[],counter+ids.length);if(!chosen)break;ids.push(chosen.pid);pool.splice(pool.findIndex(row=>row.pid===chosen.pid),1);}
  return ids;
}
function slate(order,products,limit){
  const byId=new Map(products.map(p=>[p.id,p])),picked=[];
  for(const row of order){if(picked.some(id=>similarity(byId.get(id),byId.get(row.id))>=.8))continue;picked.push(row.id);if(picked.length===limit)break;}
  return picked;
}
function qualityRejected(row){
  return row.value.rejectedReasons.some(reason=>['invalid_product','not_available','rating_below_quality_gate_or_unknown','reviews_below_quality_gate_or_unknown','advertised_price_has_no_available_variant','purchase_condition_requires_verification'].includes(reason));
}
function holdout(state,profileId,products,traitsById,now){
  const byId=new Map(products.map(p=>[p.id,p])),rows=state.ratings.filter(r=>r.profile===profileId),predictions=[];
  for(const vote of rows){
    // Target vote, exact block AND all of its feature evidence removed. The
    // other person's votes are never part of this person's profile.
    const target=byId.get(vote.nmId);
    const familyIds=products.filter(p=>similarity(p,target)>=.8||p.familyId&&target.familyId&&p.familyId===target.familyId).map(p=>p.id);
    const training={...state,ratings:state.ratings.filter(r=>!(r.profile===profileId&&familyIds.includes(r.nmId)))};
    const model=buildTasteProfile(training,profileId),product=byId.get(vote.nmId);
    const assessment=rankProduct(product,{now,comparables:products,profile:model,traits:trustedTraitsForProduct(product,traitsById)});
    const supported=assessment.taste.supported&&assessment.taste.score!==0;
    const tendency=supported?(assessment.taste.score>0?'positive':'negative'):'unknown';
    const actual=positive.has(vote.action)?'positive':'negative';
    predictions.push({id:vote.nmId,excludedTrainingIds:familyIds,supported,tendency,actual,correct:supported?tendency===actual:null,features:assessment.taste.matchedFeatures.map(f=>f.key)});
  }
  const supported=predictions.filter(p=>p.supported);
  return {tested:rows.length,supported:supported.length,correct:supported.filter(p=>p.correct).length,incorrect:supported.filter(p=>!p.correct).length,unknown:rows.length-supported.length,predictions,
    note:'Leave-one-family-out: оценка товара и близких дублей исключена из обучения. Это маленький неслучайный набор; нейтральные/неподдержанные прогнозы не считаются успехом. Ни A/B uplift, ни доказательство качества новых рекомендаций.'};
}

export function recommendForProfiles(products,input,{now=Date.now(),traitsById={},legacyCounter=0,limit=10}={}){
  if(!Array.isArray(products)||products.length>100||!Number.isSafeInteger(limit)||limit<1||limit>10||!Number.isSafeInteger(legacyCounter)||legacyCounter<0)throw Error('TASTE_RECOMMEND_INVALID_OPTIONS');
  const {state}=normalizeTasteInput(input,{products,now,traitsById});
  const legacyFull=legacyOrder(products,legacyCounter),baseline=products.map(p=>rankProduct(p,{now,comparables:products})).sort(byScore);
  const legacyRanks=new Map(legacyFull.map((id,i)=>[id,i+1])),result={};
  for(const kind of ['owner','wife']){
    const profile=buildTasteProfile(state,kind),votes=new Map(state.ratings.filter(r=>r.profile===kind).map(r=>[r.nmId,r.action]));
    const personalized=products.map(p=>rankProduct(p,{now,comparables:products,profile,traits:trustedTraitsForProduct(p,traitsById)}));
    const items=personalized.map(row=>{
      const vote=votes.get(row.id)||null,product=products.find(p=>p.id===row.id),traits=trustedTraitsForProduct(product,traitsById);
      const forbidden=negative.has(vote),quality=qualityRejected(row),blocked=row.taste.blocked,excluded=forbidden||quality||blocked;
      const features=tasteFeatures(product,traits,{now}),visual=Object.keys(features).filter(k=>k.startsWith('visual.')&&!k.startsWith('visual.group='));
      return {id:row.id,vote,rated:vote!==null,reviewOnly:true,eligibleForPublication:row.eligible,excluded,
        exclusion:forbidden?'EXPLICIT_NEGATIVE':blocked?'REVIEWED_SIMILAR_BLOCK':quality?'QUALITY_OR_STOCK_GATE':null,
        reason:forbidden?'Вы отвергли эту вещь: положительная категория не отменяет личное решение.':blocked?row.taste.reason:quality?'Не проходит обязательный порог рейтинга/отзывов, доступности или условий.':positive.has(vote)?'Уже знакомая понравившаяся вещь. Это учёт оценки, а не доказательство переноса на новые товары.':row.taste.supported?'Не оценена вами; есть совпадение подтверждённых признаков. Нужна независимая оценка.':'Не оценена вами; подборка для дальнейшего исследования, вкус по ней ещё не подтверждён.',
        legacyRank:legacyRanks.get(row.id)||null,baselineRank:null,newRank:null,
        reviewScore:row.reviewScore,featureDelta:round(row.reviewScore-baseline.find(r=>r.id===row.id).reviewScore),featureSupported:row.taste.supported,
        criteria:row.criteria,qualityState:row.value.criteria.quality.state,matchedFeatures:row.taste.matchedFeatures,
        traits:visual.map(key=>{const field=key.slice(7).split('=')[0],value=traits.fields[field];return {label:tasteFeatureLabel(key),value:value.value,confidence:value.confidence,evidence:value.evidence};})};
    });
    // Direct positives are identified as memory, never silently presented as
    // generalisation. Feature score differentiates unknown products separately.
    const allowed=items.filter(r=>!r.excluded);
    const baselineFull=allowed.map(r=>({...r,reviewScore:baseline.find(n=>n.id===r.id).reviewScore})).sort((a,b)=>Number(positive.has(b.vote))-Number(positive.has(a.vote))||byScore(a,b));
    const baselineRanks=new Map(baselineFull.map((r,i)=>[r.id,i+1]));
    items.forEach(row=>row.baselineRank=baselineRanks.get(row.id)||null);
    const baselineIds=slate(baselineFull,products,limit);
    const full=allowed.sort((a,b)=>Number(positive.has(b.vote))-Number(positive.has(a.vote))||byScore(a,b));
    full.forEach((row,i)=>row.newRank=i+1);
    const newIds=slate(full,products,limit),selected=items.filter(r=>newIds.includes(r.id)),unrated=items.filter(r=>!r.rated);
    result[kind]={legacyIds:legacyFull.slice(0,limit),baselineIds,newIds,items,holdout:holdout(state,kind,products,traitsById,now),
      metrics:{candidateCount:products.length,rated: votes.size,unrated:unrated.length,knownPositiveSelected:selected.filter(r=>positive.has(r.vote)).length,unratedSelected:selected.filter(r=>!r.rated).length,
        transferEvidenceSelected:selected.filter(r=>!r.rated&&r.featureSupported).length,explicitNegativesExcluded:items.filter(r=>negative.has(r.vote)).length,
        qualityExcluded:items.filter(r=>r.exclusion==='QUALITY_OR_STOCK_GATE').length,rankChanges:items.filter(r=>r.newRank&&r.newRank!==r.baselineRank).length,
        legacyKnownNegatives:items.filter(r=>legacyFull.slice(0,limit).includes(r.id)&&negative.has(r.vote)).length,
        legacyKnownPositives:items.filter(r=>legacyFull.slice(0,limit).includes(r.id)&&positive.has(r.vote)).length,
        freshPublishable:personalized.filter(r=>r.eligible&&!negative.has(votes.get(r.id))).length,newItemGeneralizationProven:false},
      note:unrated.length?'Личные отрицательные оценки исключены; понравившиеся и ещё не оценённые вещи подписаны отдельно. Цена/наличие требуют свежей проверки; это фотоподборка SHADOW, не очередь на публикацию.':'Все кандидаты уже оценены. Перестановка знакомых вещей НЕ доказывает, что бот научился выбирать новые. Следующий честный тест — отдельная новая подборка.'};
  }
  return result;
}
