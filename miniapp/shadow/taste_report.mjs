// Pure reporting adapter for user-exported ratings / local server snapshots.
// Client-computed profiles, feature keys, summaries and counts are NOT evidence.
// No files, network, credentials, production bindings or model calls.
import {createTasteState,tasteFeatures,buildTasteProfile,TASTE_ACTIONS,TASTE_RETENTION} from './taste.mjs';
import {fashionCategory,tasteFeatureLabel} from './calibration.mjs';
const participants={owner:'local-owner',wife:'local-wife'};
const positive=new Set(['like','more']),negative=new Set(['dislike','block_similar']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
const validHash=hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/i.test(hash);
const visualGroupLabels={apparel:'одежда',shoes:'обувь',bag:'сумки',accessory:'аксессуары',home:'товары для дома',beauty:'косметика',electronics:'электроника',other:'прочее'};
const evidenceLabel=row=>tasteFeatureLabel(row.key)+(row.key.startsWith('visual.')&&Object.hasOwn(visualGroupLabels,row.group)?` (${visualGroupLabels[row.group]})`:'');
const emptyCounts=()=>({like:0,dislike:0,more:0,block_similar:0,positive:0,negative:0,total:0});
const actionCounts=rows=>{const counts=emptyCounts();for(const row of rows){counts[row.action]++;counts.total++;counts[positive.has(row.action)?'positive':'negative']++;}return counts;};
const timestamp=now=>{if(!Number.isSafeInteger(now)||now<=0||now>8640000000000000)throw Error('TASTE_REPORT_INVALID_TIME');return now;};

function trustedProducts(products){
  const rows=products instanceof Map?[...products.values()]:products;
  if(!Array.isArray(rows)||rows.length>1000)throw Error('TASTE_REPORT_PRODUCTS_REQUIRED');
  const result=new Map();
  for(const product of rows){
    if(!plain(product)||!validId(product.id)||typeof product.name!=='string'||!product.name.trim())throw Error('TASTE_REPORT_INVALID_TRUSTED_PRODUCT');
    if(result.has(product.id))throw Error('TASTE_REPORT_DUPLICATE_TRUSTED_PRODUCT');
    result.set(product.id,product);
  }
  return result;
}

/** A single photo-evidence guard for both training and candidate scoring.
 * traitsById MUST be a server-resolved reviewed manifest, never client input.
 * The flags/hash establish eligibility, not authentication or model accuracy.
 */
export function trustedTraitsForProduct(product,traitsById={}){
  if(!plain(product)||!validId(product.id))return null;
  const profile=traitsById instanceof Map?traitsById.get(product.id):plain(traitsById)&&Object.hasOwn(traitsById,String(product.id))?traitsById[String(product.id)]:null;
  if(!plain(profile)||profile.reviewed!==true||profile.cacheVerified!==true||!validHash(product.imageHash))return null;
  const hash=profile.imageHash??profile.hash??profile.images?.[0]?.hash;
  if(!validHash(hash)||hash.toLowerCase()!==product.imageHash.toLowerCase()||profile.nmId!=null&&profile.nmId!==product.id)return null;
  // Reviewing a profile does not automatically validate every model hypothesis.
  // Keep only non-hypothesis entries; tasteFeatures applies its closed vocabulary,
  // numeric confidence, visible evidence and front/back consistency checks next.
  const fields=plain(profile.fields)?Object.fromEntries(Object.entries(profile.fields).filter(([,field])=>plain(field)&&field.hypothesis!==true)):{};
  return {...profile,fields};
}

/** Returns minimal sanitized state plus explicit validation/archive counts.
 * This validates the export's structure, not the human's identity/authentication.
 * The caller is responsible for receiving a genuine owner-supplied export.
 */
export function normalizeTasteInput(input,{products,now=Date.now(),traitsById={}}={}){
  timestamp(now);
  if(typeof input==='string'){if(input.length>1000000)throw Error('TASTE_REPORT_INPUT_TOO_LARGE');try{input=JSON.parse(input.replace(/^\uFEFF/u,''));}catch{throw Error('TASTE_REPORT_INVALID_JSON');}}
  if(!plain(input)||![1,2].includes(input.version)||!Array.isArray(input.ratings)||input.archive!=null&&!Array.isArray(input.archive))throw Error('TASTE_REPORT_INVALID_INPUT');
  const sourceRows=[...input.ratings,...(input.version===1?input.archive??[]:[])];
  if(sourceRows.length>1000)throw Error('TASTE_REPORT_INPUT_TOO_LARGE');
  const catalog=trustedProducts(products),latest=new Map(),ambiguous=new Set(),invalid=[];
  const validation={inputVersion:input.version,inputRows:sourceRows.length,validUnique:0,activeFashion:0,archived:0,invalidRows:0,duplicateRows:0,ambiguousKeys:0,clientComputedFieldsIgnored:true,reasons:{}};
  const countReason=reason=>validation.reasons[reason]=(validation.reasons[reason]??0)+1;
  for(const [index,row] of sourceRows.entries()){
    let reason=null;
    if(!plain(row))reason='ROW_NOT_OBJECT';
    else if(!Object.hasOwn(participants,row.profile))reason='PROFILE_NOT_PERSONAL';
    else if(row.participant_id!==participants[row.profile])reason='PARTICIPANT_MISMATCH';
    else if(!validId(row.nmId))reason='INVALID_NMID';
    else if(!TASTE_ACTIONS.includes(row.action))reason='INVALID_ACTION';
    else if(!Number.isSafeInteger(row.ts)||row.ts<=0||row.ts>now)reason='INVALID_TIMESTAMP';
    if(reason){invalid.push({index,reason});countReason(reason);continue;}
    const clean={profile:row.profile,participant_id:row.participant_id,nmId:row.nmId,action:row.action,ts:row.ts};
    const key=`${row.profile}:${row.nmId}`,prior=latest.get(key);
    if(prior){
      validation.duplicateRows++;
      if(clean.ts===prior.ts&&clean.action!==prior.action){ambiguous.add(key);countReason('AMBIGUOUS_SAME_TIME_VOTE');}
      else if(clean.ts>prior.ts){latest.set(key,clean);ambiguous.delete(key);}
    }else latest.set(key,clean);
  }
  validation.invalidRows=invalid.length;validation.ambiguousKeys=ambiguous.size;
  const state=createTasteState(),archive=[];
  const candidates=[...latest].filter(([key])=>!ambiguous.has(key)).map(([,row])=>row).sort((a,b)=>b.ts-a.ts||a.nmId-b.nmId||a.profile.localeCompare(b.profile));
  const kept={owner:0,wife:0};
  for(const row of candidates){
    const product=catalog.get(row.nmId),classification=product?fashionCategory(product):null;
    const reason=!product?'PRODUCT_NOT_IN_TRUSTED_DATASET':!classification.allowed?'OUTSIDE_CONFIRMED_FASHION':now-row.ts>TASTE_RETENTION.personalRetentionMs?'RATING_EXPIRED':kept[row.profile]>=TASTE_RETENTION.personalMax?'PERSONAL_RECORD_LIMIT':null;
    if(reason){archive.push({...row,reason});countReason(reason);continue;}
    kept[row.profile]++;
    // Preserve the actual vote/time, recompute immutable feature snapshot from
    // trusted product metadata. No seller-title style or exported feature keys.
    state.ratings.push({...row,features:tasteFeatures(product,trustedTraitsForProduct(product,traitsById),{now:row.ts})});
  }
  state.ratings.sort((a,b)=>a.ts-b.ts||a.nmId-b.nmId||a.profile.localeCompare(b.profile));
  state.archive=archive;
  state.updatedAt=candidates.length?Math.max(...candidates.map(row=>row.ts)):null;
  validation.validUnique=candidates.length;validation.activeFashion=state.ratings.length;validation.archived=archive.length;
  return {state,validation,archive};
}

function item(row,catalog){const product=catalog.get(row.nmId);return {nmId:row.nmId,name:product?.name??null,category:product?.categoryVerified===true?product.category:null,action:row.action,ts:row.ts};}
function categoryEvidence(rows,profile,catalog){
  const categories=new Map();
  for(const row of rows){const product=catalog.get(row.nmId),category=product?.categoryVerified===true?product.category:null;if(!category)continue;if(!categories.has(category))categories.set(category,[]);categories.get(category).push(row);}
  return [...categories].map(([category,votes])=>{
    const counts=actionCounts(votes),evidence=profile.evidence.find(row=>row.key===`category=${category}`),sufficient=!!evidence?.sufficient;
    const direction=!sufficient?'insufficient':(evidence.preference>0?'positive':evidence.preference<0?'negative':'mixed');
    return {category,counts,products:votes.map(row=>row.nmId),sufficient,direction,preference:sufficient?evidence.preference:null,
      statement:sufficient?`${category}: ${counts.total} разных вещей, положительных оценок ${counts.positive}, отрицательных ${counts.negative}; предварительная тенденция, не гарантия вкуса во всей категории.`:`${category}: ${counts.total} разных вещей; для вывода недостаточно данных (нужны минимум 3 в категории и 5 в профиле).`};
  }).sort((a,b)=>b.counts.total-a.counts.total||a.category.localeCompare(b.category,'ru'));
}

export function buildTasteReport(input,products,{now=Date.now(),traitsById={}}={}){
  const normalized=normalizeTasteInput(input,{products,now,traitsById}),state=normalized.state,catalog=trustedProducts(products),profiles={};
  for(const kind of ['owner','wife']){
    const rows=state.ratings.filter(row=>row.profile===kind),profile=buildTasteProfile(state,kind),counts=actionCounts(rows);
    const categories=categoryEvidence(rows,profile,catalog),traits=profile.evidence.filter(row=>row.key.startsWith('visual.')&&!row.key.startsWith('visual.group=')&&row.sufficient).flatMap(row=>(row.groupEvidence??[]).filter(bucket=>bucket.sufficient).map(bucket=>{const scoped={...row,...bucket};return {...scoped,label:evidenceLabel(scoped)};}));
    profiles[kind]={profile:kind,counts,archiveCount:normalized.archive.filter(row=>row.profile===kind).length,lastRatingAt:profile.lastRatingAt,configured:profile.configured,sampleProducts:profile.sampleProducts,
      likedItems:rows.filter(row=>positive.has(row.action)).map(row=>item(row,catalog)),dislikedItems:rows.filter(row=>negative.has(row.action)).map(row=>item(row,catalog)),
      categoryEvidence:categories,visualEvidence:traits,unknown:profile.unknown,unknownLabels:profile.unknown.map(tasteFeatureLabel),
      preferredLabels:profile.preferred.map(evidenceLabel),avoidedLabels:profile.avoided.map(evidenceLabel),
      note:profile.note,uncertainty:profile.uncertainty,
      summary:counts.total?`Оценено ${counts.total} разных fashion-вещей: нравится ${counts.like}, больше такого ${counts.more}, не нравится ${counts.dislike}, не показывать похожее ${counts.block_similar}. Без проверенной визуальной разметки стиль, фасон, цвет и принт не угадываются.`:'Нет настоящих оценок fashion-вещей. Предпочтения не настроены.'};
  }
  const owner=new Map(state.ratings.filter(row=>row.profile==='owner').map(row=>[row.nmId,row])),wife=new Map(state.ratings.filter(row=>row.profile==='wife').map(row=>[row.nmId,row]));
  const both=[...owner.keys()].filter(id=>wife.has(id)).sort((a,b)=>a-b),sharedPositive=[],sharedNegative=[],different=[];
  for(const id of both){const a=owner.get(id),b=wife.get(id),record={nmId:id,name:catalog.get(id).name,category:catalog.get(id).category,ownerAction:a.action,wifeAction:b.action};
    if(positive.has(a.action)&&positive.has(b.action))sharedPositive.push(record);
    else if(negative.has(a.action)&&negative.has(b.action))sharedNegative.push(record);
    else different.push(record);
  }
  const sharedCategories=profiles.owner.categoryEvidence.filter(row=>row.sufficient).flatMap(row=>{const other=profiles.wife.categoryEvidence.find(value=>value.category===row.category&&value.sufficient);return other&&row.direction===other.direction&&row.direction!=='mixed'?[{category:row.category,direction:row.direction,ownerProducts:row.counts.total,wifeProducts:other.counts.total}]:[];});
  const total=profiles.owner.counts.total+profiles.wife.counts.total;
  return {version:1,generatedAt:timestamp(now),mode:'SHADOW',productionWrites:0,validation:normalized.validation,profiles,
    counts:{owner:profiles.owner.counts,wife:profiles.wife.counts,totalActive:total,archived:normalized.archive.length},
    archiveCounts:{owner:profiles.owner.archiveCount,wife:profiles.wife.archiveCount},
    common:{ratedByBoth:both.length,liked:sharedPositive,disliked:sharedNegative,categories:sharedCategories},differences:different,
    comparisonNote:'Сравнение личных оценок только на общих реально оценённых карточках. Одно совпадение не доказывает общий стиль; объём данных и unknown показаны отдельно.',
    caveats:['Личные оценки не смешиваются с реакциями аудитории.','Цена и наличие этого исторического набора не подтверждаются отчётом.','Клиентские готовые профили и признаки отброшены; категории взяты из проверенной WB-метаинформации.','Выводы о стиле доступны только для явно проверенного Visual-профиля того же хэша фотографии; иначе unknown.','Визуальные предпочтения требуют минимум 3 разных вещей с признаком внутри одной группы; цвет обуви не переносится на сумки или одежду.']};
}
