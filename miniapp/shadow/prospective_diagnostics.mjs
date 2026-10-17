// Post-test READ ONLY diagnostics. No fitting, reranking, fetch, AI or runtime writes.
// The initial completion receipt is evidence; later corrected votes are not a new test.
import {summarizeExperiment,EXPERIMENT_LIMITS} from './prospective_experiment.mjs';
import {fashionCategory,selectFashionCalibration} from './calibration.mjs';
import {trustedTraitsForProduct} from './taste_report.mjs';
const people=['owner','wife'];
const ACCURACY_MINIMUM=10; // Canonical original experiment rule, never a receipt-provided override.
const positive=action=>['like','more'].includes(action);
const clone=value=>JSON.parse(JSON.stringify(value));
const countBy=values=>values.reduce((out,value)=>(out[value]=(out[value]??0)+1,out),{});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const maxRun=values=>{let max=0,run=0,prior;for(const value of values){run=value===prior?run+1:1;prior=value;max=Math.max(max,run);}return max;};

export function auditFirstPass(state){
  summarizeExperiment(state); // Reuse existing state/manifest/first-completion validation.
  if(people.some(person=>!state.completion[person].firstRatings))throw Error('AUDIT_FIRST_PASS_INCOMPLETE');
  const products=new Map(state.products.map(product=>[product.id,product])),profiles={};
  for(const person of people){
    const receipt=state.completion[person],votes=new Map(receipt.firstRatings.map(row=>[row.nmId,row])),ranks=state.frozen.comparisons[person];
    const predictions=ranks.new.predictions,defined=predictions.filter(row=>row.direction!=='unknown');
    const matrix={truePositive:0,trueNegative:0,falsePositive:0,falseNegative:0},errors=[],unknown=[];
    const model=state.frozen.profiles[person];
    for(const prediction of predictions){
      const product=products.get(prediction.id),action=votes.get(prediction.id).action;
      const base={id:prediction.id,category:product.category,actualAction:action,predicted:prediction.direction,
        matchedFeatures:(prediction.matchedFeatures??[]).map(({key,preference,products})=>({key,preference,products}))};
      if(prediction.direction==='unknown'){
        const stat=model.evidence.find(row=>row.key===`category=${product.category}`);
        unknown.push({...base,reason:prediction.confidence,categorySupport:stat?.products??0,requiredCategorySupport:model.minimumFeatureSamples,
          categoryEvidence:!stat?'absent':stat.products<model.minimumFeatureSamples?'below_minimum':'present',
          reviewedVisual:!!trustedTraitsForProduct(product,state.frozen.traitsById)});
      }else{
        const actual=positive(action),predicted=prediction.direction==='positive';
        matrix[actual?(predicted?'truePositive':'falseNegative'):(predicted?'falsePositive':'trueNegative')]++;
        if(actual!==predicted)errors.push({...base,type:predicted?'false_positive':'false_negative'});
      }
    }
    const correct=matrix.truePositive+matrix.trueNegative,topK=Math.min(EXPERIMENT_LIMITS.topK,state.candidateIds.length);
    const conditionalAccuracy=defined.length>=ACCURACY_MINIMUM?correct/defined.length:null;
    const top=algorithm=>{
      const ids=ranks[algorithm].order.slice(0,topK),categories=ids.map(id=>products.get(id).category);
      return {ids,positive:ids.filter(id=>positive(votes.get(id).action)).length,total:ids.length,
        categories:countBy(categories),maxSameCategoryRun:maxRun(categories)};
    };
    const legacy=top('legacy'),next=top('new'),saved=receipt.firstResults;
    // Reject corrupted/contradictory receipts instead of silently revising history.
    if(saved.frozenAt!==state.frozen.createdAt||saved.legacy.topK!==topK||saved.new.topK!==topK||
      !same(saved.legacy.topIds,legacy.ids)||!same(saved.new.topIds,next.ids)||
      saved.legacy.negativeInTopK!==legacy.total-legacy.positive||saved.new.negativeInTopK!==next.total-next.positive||
      saved.classification.accuracyMinimum!==ACCURACY_MINIMUM||saved.classification.accuracy!==conditionalAccuracy||
      !same(saved.new.predictions,predictions)||!same(saved.legacy.order,ranks.legacy.order)||!same(saved.new.order,ranks.new.order)||
      saved.legacy.positiveInTopK!==legacy.positive||saved.new.positiveInTopK!==next.positive||
      saved.classification.predicted!==defined.length||saved.classification.abstained!==unknown.length||
      saved.classification.correct!==correct||saved.classification.wrong!==errors.length||!same(saved.classification.matrix,matrix))throw Error('AUDIT_RECEIPT_MISMATCH');
    const scoreBuckets=new Map();
    for(const row of predictions){const key=String(row.reviewScore),ids=scoreBuckets.get(key)??[];ids.push(row.id);scoreBuckets.set(key,ids);}
    const criteria=Object.fromEntries(['value','priceConfidence','quality','preferences','diversity','freshness'].map(key=>[key,[...new Set(predictions.map(row=>row.criteria[key]))]]));
    profiles[person]={firstCompletedAt:receipt.firstCompletedAt,firstRevision:receipt.firstRevision,correctionsAfterFirstPass:receipt.corrections,
      evaluated:receipt.firstRatings.length,positive:receipt.firstRatings.filter(row=>positive(row.action)).length,
      negative:receipt.firstRatings.filter(row=>!positive(row.action)).length,top5:{legacy,new:next},
      classification:{defined:defined.length,unknown:unknown.length,correct,wrong:errors.length,matrix,
        coverage:defined.length/predictions.length,conditionalAccuracy},
      errors,unknown,unknownReasons:countBy(unknown.map(row=>row.reason)),unknownCategoryEvidence:countBy(unknown.map(row=>row.categoryEvidence)),
      supportedFeatureFamilies:countBy(defined.flatMap(row=>(row.matchedFeatures??[]).map(feature=>feature.key.split('=')[0]))),
      categoryOnlyPredictions:defined.filter(row=>row.matchedFeatures?.length===1&&row.matchedFeatures[0].key.startsWith('category=')).length,
      reviewedCandidateProfiles:state.products.filter(product=>trustedTraitsForProduct(product,state.frozen.traitsById)).length,
      constantCriteria:criteria,ties:[...scoreBuckets].filter(([,ids])=>ids.length>1).map(([score,ids])=>({score:Number(score),count:ids.length,nmIdAscending:ids.every((id,i)=>!i||id>ids[i-1])}))};
  }
  const actions=Object.fromEntries(people.map(person=>[person,new Map(state.completion[person].firstRatings.map(row=>[row.nmId,row.action]))]));
  const bothPositive=[],bothNegative=[],opposite=[],samePolarityDifferentAction=[];
  for(const id of state.candidateIds){const owner=actions.owner.get(id),wife=actions.wife.get(id);
    if(positive(owner)!==positive(wife))opposite.push(id);
    else{(positive(owner)?bothPositive:bothNegative).push(id);if(owner!==wife)samePolarityDifferentAction.push(id);}
  }
  return {version:1,experimentId:state.id,evaluation:'IMMUTABLE_FIRST_PASS',profiles,
    agreement:{bothPositive,bothNegative,opposite,samePolarityDifferentAction},
    newQualityClaim:null,trainingFeedbackAdded:0,rankingsChanged:0,productionWrites:0,
    note:'Post-test diagnosis is development evidence, not a new holdout or a measured improvement. Unknown is not a correct prediction.'};
}

/** Readiness only; DOES NOT create, rank, reveal or activate the next experiment.
 * photoHashesById must come from reading actual local bytes, not the client.
 * Exclude every previous exposure, including undone votes and archived history.
 */
export function assessNextPool(products,history,{exposedProducts=[],historicalProducts=[],photoHashesById={},traitsById={},min=15,target=20}={}){
  if(!Array.isArray(products)||products.length>1000||!history||!Array.isArray(history.ratings)||!Array.isArray(exposedProducts)||!Array.isArray(historicalProducts)||!Number.isSafeInteger(min)||min<15||!Number.isSafeInteger(target)||target<min||target>20)throw Error('AUDIT_POOL_INVALID');
  const prior=[...history.ratings,...(history.archive??[])],excluded=new Set([...prior.map(row=>row.nmId),...exposedProducts.map(product=>product.id)]);
  const catalog=new Map([...historicalProducts,...exposedProducts].map(product=>[product.id,product]));
  const oldPhotos=new Set([...catalog.values()].filter(product=>excluded.has(product.id)).map(product=>product.imageHash?.toLowerCase()).filter(Boolean));
  const verified=products.filter(product=>!excluded.has(product.id)&&!oldPhotos.has(product.imageHash?.toLowerCase())&&
    /^[a-f0-9]{64}$/i.test(product.imageHash??'')&&photoHashesById[product.id]?.toLowerCase()===product.imageHash.toLowerCase());
  // Reuse category, photo, duplicate-family and category-cap gates. Its calibration
  // minimum is not a holdout readiness claim; count the actually available rows.
  const selected=selectFashionCalibration(verified,{target:30,min:30,maxPerCategory:8}).products.slice(0,target);
  const groups=countBy(selected.map(product=>fashionCategory(product).group)),categories=countBy(selected.map(product=>product.category));
  const missingGroups=['clothing','shoes','bags','accessories'].filter(group=>!groups[group]);
  const reviewed=selected.filter(product=>trustedTraitsForProduct(product,traitsById)).length;
  const unresolvedPriorIds=[...excluded].filter(id=>!catalog.has(id));
  const reasons=[...(selected.length<min?['NOT_ENOUGH_UNSEEN_PHOTOS']:[]),...(missingGroups.length?['FASHION_GROUPS_MISSING']:[]),
    ...(reviewed<selected.length?['REVIEWED_VISUAL_COVERAGE_INCOMPLETE']:[]),...(unresolvedPriorIds.length?['HISTORICAL_FAMILY_METADATA_INCOMPLETE']:[]),
    'NEXT_MODEL_AND_EXCLUSION_MANIFEST_NOT_FROZEN'];
  return {verifiedUnseenPhotos:verified.length,selectedPhotos:selected.length,min,target,groups,categories,missingGroups,
    reviewedVisualProfiles:reviewed,unresolvedPriorMetadata:unresolvedPriorIds.length,ready:reasons.length===0,reasons,
    futureRankingsCreated:0,futureVotesCreated:0,publicationAuthority:'NONE',
    note:'Preliminary pool check only. A new frozen manifest must also apply cross-history family exclusions and freeze the next model before exposure. All four groups and reviewed photo-matched traits are required; current prices/stock remain a separate publication gate.'};
}
