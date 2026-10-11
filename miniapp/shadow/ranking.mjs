// Independent, explainable SHADOW ranking. This module cannot send Telegram,
// run Cron, fetch WB, or import/change the production chooser.
import {assessValue} from './value.mjs';
import {scoreTaste} from './taste.mjs';
const clamp=(v)=>Math.max(0,Math.min(100,Number.isFinite(v)?v:0));
export const titleTokens=p=>new Set(String(p.name||p.title||'').toLowerCase().replace(/[^\p{L}\p{N} ]/gu,' ').split(/\s+/).filter(x=>x.length>2));
export function similarity(a,b){
  if(a.id===b.id)return 1;
  if(a.imageHash&&b.imageHash&&a.imageHash===b.imageHash)return 1;
  if(a.category!==b.category||a.type!==b.type)return 0;
  const x=titleTokens(a),y=titleTokens(b),intersection=[...x].filter(t=>y.has(t)).length;
  return intersection/Math.max(1,new Set([...x,...y]).size);
}
export function rankProduct(product,{now=Date.now(),comparables=[],profile=null,recent=[],seenIds=[],traits=null}={}){
  const value=assessValue(product,{now,comparables});
  const taste=profile?scoreTaste(profile,product,{now,traits}):null;
  const age=value.price.ageMs,freshness=age===null||age<0?0:clamp(100*(1-age/86400000));
  const duplicates=recent.filter(p=>similarity(product,p)>=.8),seen=seenIds.includes(product.id);
  const diversity=clamp(100-20*recent.filter(p=>p.category===product.category).length-60*duplicates.length);
  const preferences=taste?.configured?clamp(50+Number(taste.score||0)*50):50;
  const reasons=[...value.explanation];
  if(!taste?.configured)reasons.push('Вкус ещё не настроен: личные предпочтения не угаданы.');
  if(taste?.configured){reasons.push(taste.reason);for(const feature of taste.matchedFeatures.slice(0,6))reasons.push(`${feature.preference>0?'Предпочитаемый':'Менее желательный'} признак: ${feature.key}; оценено разных вещей: ${feature.products}.`);}
  if(seen)reasons.push('Артикул уже опубликован в переданном окне истории.');
  if(duplicates.length)reasons.push('Похож на недавний товар: совпадение названия/типа или изображения.');
  const blocked=Boolean(taste?.blocked),eligible=value.eligible&&!seen&&!duplicates.length&&!blocked;
  if(blocked)reasons.push('Явно отклонён выбранным профилем предпочтений.');
  const criteria={value:clamp(value.criteria.realValue.score??0),priceConfidence:clamp(value.price.confidence*100),quality:value.criteria.quality?.score??0,preferences,diversity,freshness};
  // Hard gates are evaluated BEFORE the score; suspect quality cannot be
  // compensated by a seller's claimed discount or a preference score.
  const reviewScore=clamp(criteria.value*.35+criteria.priceConfidence*.2+criteria.quality*.2+preferences*.15+diversity*.08+freshness*.02);
  return {id:product.id,eligible,score:eligible?reviewScore:null,reviewScore,criteria,value,taste,reasons};
}
export function compareShadow(products,{legacyPick=null,limit=10,...context}={}){
  if(!Array.isArray(products)||products.length>100)throw new Error('SHADOW batch max100');
  const byId=new Map(products.map(p=>[p.id,p]));
  const assessments=products.map(p=>rankProduct(p,{...context,comparables:products}));
  const selected=[];let remaining=assessments.filter(p=>p.eligible);
  while(remaining.length&&selected.length<Math.min(30,limit)){
    remaining=remaining.map(r=>rankProduct(byId.get(r.id),{...context,comparables:products,recent:[...(context.recent||[]),...selected.map(s=>byId.get(s.id))]})).filter(r=>r.eligible);
    if(!remaining.length)break;
    remaining.sort((a,b)=>b.reviewScore-a.reviewScore||a.id-b.id);
    const item=remaining.shift(),p=byId.get(item.id);
    if(selected.some(s=>similarity(p,byId.get(s.id))>=.8))continue;
    selected.push(item);
  }
  return {mode:'SHADOW',publicationAuthority:'LEGACY_UNCHANGED',legacyPick:legacyPick?.pid||legacyPick?.id||null,newPick:selected[0]?.id||null,selected: selected.map(p=>p.id),selectionAssessments:selected,assessments,comparisonNote:'Наблюдательное сравнение, не A/B-тест. Без реальных оценок владельцев uplift неизвестен.'};
}
