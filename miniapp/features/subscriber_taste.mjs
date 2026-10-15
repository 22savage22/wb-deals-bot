// Subscriber-only aggregate model. Never imports owner/wife ratings or channel reactions.
// Reuses PR10's closed, reviewed feature extractor, shrinkage and support minimum.
import {tasteFeatures} from '../shadow/taste.mjs';
import {trustedTraitsForProduct} from '../shadow/taste_report.mjs';
import {fashionCategory,tasteFeatureLabel} from '../shadow/calibration.mjs';
import {assessValue,priceContextKey,VALUE_POLICY} from '../shadow/value.mjs';
import {similarity} from '../shadow/ranking.mjs';
export const STYLE_ACTIONS=['like','dislike','more','block_similar','skip'];
const weights={like:1,dislike:-1,more:2,block_similar:-2,skip:0};
const structural={apparel:['fit','silhouette','length','neckline'],shoes:['shape','height','sole','toe','closure'],bag:['shape','carry','size'],accessory:['shape','decoration','size']};
export function subscriberFeatures(product,visual,now=Date.now()){
  const verified=trustedTraitsForProduct(product,{[product.id]:visual});
  const features=tasteFeatures(product,verified,{now});
  if(!assessValue(product,{now}).price.valid||product.available!==true||!priceContextKey(product.context)||!product.variantKey)
    for(const key of Object.keys(features))if(key.startsWith('budget='))delete features[key];
  if(verified){const group=fashionCategory(product).group,expected={clothing:'apparel',shoes:'shoes',bags:'bag',accessories:'accessory'}[group];
    if(expected!==verified.group)for(const key of Object.keys(features))if(key.startsWith('visual.'))delete features[key];}
  if(product.brandVerified===true&&typeof product.brand==='string'&&product.brand.trim().length>=2&&product.brand.length<=80&&!/[\u0000-\u001f]/.test(product.brand))features['brand='+product.brand.trim().toLocaleLowerCase('ru')]=1;
  return features;
}
const groupOf=f=>Object.keys(f??{}).find(key=>key.startsWith('visual.group='))?.slice(13)??null;
const scoped=(key,group)=>key.startsWith('visual.')?`${group}|${key}`:key;
const preference=row=>(row.positive-row.negative)/(row.positive+row.negative+4);
export const emptySubscriber=()=>({version:1,samples:0,seen:0,saved:0,stats:{},blocked:[]});
export function applySubscriberVote(model,prior,next){
  const out=structuredClone(model??emptySubscriber());
  for(const [vote,sign] of [[prior,-1],[next,1]])if(vote){
    out.seen+=sign;const weight=weights[vote.action];if(weight===undefined)throw Error('INVALID_STYLE_ACTION');
    if(weight){out.samples+=sign;const group=groupOf(vote.features);
      for(const key of Object.keys(vote.features??{}).slice(0,32))if(!key.startsWith('visual.group=')){
        const k=scoped(key,group),row=out.stats[k]??{key,group:key.startsWith('visual.')?group:null,products:0,positive:0,negative:0};
        row.products+=sign;row.positive+=sign*Math.max(0,weight);row.negative+=sign*Math.max(0,-weight);
        if(row.products<=0)delete out.stats[k];else out.stats[k]=row;
      }
    }
    if(vote.action==='block_similar')out.blocked=out.blocked.filter(row=>row.id!==vote.id);
  }
  if(next?.action==='block_similar')out.blocked.push({id:next.id,features:next.features});
  out.blocked=out.blocked.slice(-20); // Bounded active visual exclusions; exact rated IDs are always excluded in D1.
  if(out.samples<0||out.seen<0||Object.keys(out.stats).length>1000)throw Error('STYLE_MODEL_LIMIT');
  return out;
}
function similarBlocked(features,example){
  const group=groupOf(features);if(!group||group!==groupOf(example.features))return false;
  const category=Object.keys(features).find(key=>key.startsWith('category='));if(!category||!example.features[category])return false;
  const visual=Object.keys(example.features).filter(key=>key.startsWith('visual.')&&!key.startsWith('visual.group='));
  const structuralKeys=visual.filter(key=>structural[group]?.includes(key.slice(7).split('=')[0]));
  const matched=visual.filter(key=>features[key]);
  const conflict=structuralKeys.some(key=>!features[key]&&Object.keys(features).some(other=>other.split('=')[0]===key.split('=')[0]));
  return !conflict&&matched.length>=3&&matched.filter(key=>structuralKeys.includes(key)).length>=2&&matched.length/Math.max(1,visual.length)>=.8;
}
export function styleScore(product,model,visual,{now=Date.now()}={}){
  const f=subscriberFeatures(product,visual,now),group=groupOf(f),matched=[];
  if(model.samples>=5)for(const key of Object.keys(f)){
    const stat=model.stats[scoped(key,group)];if(stat?.products>=3)matched.push({...stat,preference:preference(stat)});
  }
  // A category/brand is a small prior, never a substitute for observed cut/style.
  const visualRows=matched.filter(row=>row.key.startsWith('visual.'));
  // Correlated fields share a bounded visual-family contribution instead of additive votes.
  const family=key=>['fit','silhouette','shape','length','size'].includes(key)?'shape':['pattern','print_size','print_location'].includes(key)?'pattern':['color','palette'].includes(key)?'color':'details';
  const families=new Map();for(const row of visualRows){const k=family(row.key.slice(7).split('=')[0]),rows=families.get(k)??[];rows.push(row.preference);families.set(k,rows);}
  const visualValues=[...families.values()].map(values=>values.reduce((a,b)=>a+b,0)/values.length),avg=rows=>rows.length?rows.reduce((a,b)=>a+b,0)/rows.length:0;
  const category=matched.filter(row=>row.key.startsWith('category=')).map(row=>row.preference),other=matched.filter(row=>/^(?:brand|budget)=/.test(row.key)).map(row=>row.preference);
  const score=.8*avg(visualValues)+.15*avg(category)+.05*avg(other);
  const blocked=model.blocked.some(example=>similarBlocked(f,example));
  return {score,blocked,matched,confidence:visualRows.length?'limited_visual_evidence':matched.length?'category_only_low':'unknown',
    reasons:matched.length?matched.slice(0,4).map(row=>`${row.preference>0?'Чаще нравилось':'Реже нравилось'}: ${tasteFeatureLabel(row.key)} · ${row.products} разных вещей`):['Пока мало подтверждённых оценок — показываем разнообразные вещи, не угадываем ваш стиль.']};
}
export function personalDeck(products,model,{seenIds=[],savedIds=[],visualById={},now=Date.now(),filters={},mode='learn',seed=0,limit=20}={}){
  if(!Array.isArray(products)||products.length>120||!['learn','recommend'].includes(mode))throw Error('STYLE_BATCH_LIMIT');
  const seen=new Set(seenIds),saved=new Set(savedIds),remaining=[],chosen=[],groups={};
  for(const p of products){
    if(seen.has(p.id)||p.enabled===false||p.available===false||p.qualityRisk===true||!p.imageHash)continue;
    if(p.rating!=null&&(!Number.isFinite(p.rating)||p.rating<VALUE_POLICY.minRating||p.rating>5)||p.reviews!=null&&(!Number.isSafeInteger(p.reviews)||p.reviews<VALUE_POLICY.minReviews))continue;
    const category=fashionCategory(p);if(!category.allowed||filters.group&&filters.group!==category.group)continue;
    const value=assessValue(p,{now});
    const priceConfirmed=value.price.valid&&p.available===true&&!!priceContextKey(p.context)&&!!p.variantKey;
    if(filters.maxPrice!=null&&(!priceConfirmed||p.price>filters.maxPrice)||filters.minPrice!=null&&(!priceConfirmed||p.price<filters.minPrice))continue;
    const taste=styleScore(p,model,visualById[p.id],{now});if(taste.blocked)continue;
    remaining.push({product:p,group:category.group,taste,priceConfirmed,favorite:saved.has(p.id)});
  }
  const hash=id=>Math.imul((id^seed)>>>0,2654435761)>>>0;
  while(remaining.length&&chosen.length<Math.min(20,limit)){
    remaining.sort((a,b)=>{
      const priority=x=>(mode==='recommend'?x.taste.score:0)-.08*(groups[x.group]??0)-.1*chosen.filter(y=>y.product.category===x.product.category).length;
      return priority(b)-priority(a)||hash(a.product.id)-hash(b.product.id);
    });
    const item=remaining.shift();if(chosen.some(row=>row.product.id===item.product.id||row.product.imageHash===item.product.imageHash||similarity(row.product,item.product)>=.95||row.product.familyVerified===true&&item.product.familyVerified===true&&row.product.familyId===item.product.familyId&&!!item.product.familyId))continue;
    chosen.push(item);groups[item.group]=(groups[item.group]??0)+1;
  }
  return chosen.map(({product:p,...r})=>({id:p.id,name:p.name,category:p.category,group:r.group,image:p.displayImage??p.image,
    url:`https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,price:r.priceConfirmed?p.price:null,priceNote:r.priceConfirmed?'Сохранённая подтверждённая цена; условия и наличие проверьте на WB.':'Актуальная цена и наличие не подтверждены',
    favorite:r.favorite,confidence:r.taste.confidence,reasons:r.taste.reasons,publicationAuthority:'NONE'}));
}
export function subscriberSummary(model){
  const enough=model.samples>=5,rows=Object.values(model.stats).filter(row=>enough&&row.products>=3).map(row=>({...row,preference:preference(row)}));
  const describe=rows=>rows.slice(0,6).map(row=>({label:tasteFeatureLabel(row.key),group:row.group,products:row.products}));
  return {rated:model.samples,seen:model.seen,ready:enough,preferred:describe(rows.filter(row=>row.preference>0).sort((a,b)=>b.preference-a.preference)),
    avoided:describe(rows.filter(row=>row.preference<0).sort((a,b)=>a.preference-b.preference)),
    visualEvidence:rows.some(row=>row.key.startsWith('visual.')),accuracy:null,uplift:null,
    note:'Это только ваши оценки. Общие реакции, вкус владельца и жены не используются. Качество персонализации ещё не измерено независимым тестом.'};
}
