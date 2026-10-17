// Reuse the reviewed PR10 value engine and PR14 gates; never rank channel posts.
import {assessValue} from '../shadow/value.mjs';
import {DISCOVERY_TOPICS} from '../shadow/discovery.mjs';
import {fashionCategory} from '../shadow/calibration.mjs';
import {ownerReason,QUALITY_CATEGORIES} from '../cloudflare/audience_quality.mjs';
import {selectionReason} from '../cloudflare/selection_policy.mjs';
import {assessSuperfind} from '../features/superfind.mjs';
import {metadataURL} from '../features/catalogue_source.mjs';
export const PRICE_TIERS=Object.freeze([100,200,300,500]);
export const SEARCH_QUERIES=Object.freeze([...new Set([...DISCOVERY_TOPICS.filter(x=>['clothing','shoes','bags','accessories'].includes(x.category)).flatMap(x=>x.queries),'худи мужское','худи женское','брюки женские','брюки мужские'])]);
export function planBudgetSearch(cursor=0){if(!Number.isSafeInteger(cursor)||cursor<0)throw Error('INVALID_SEARCH_CURSOR');return {query:SEARCH_QUERIES[cursor%SEARCH_QUERIES.length],maxPrice:PRICE_TIERS[Math.floor(cursor/SEARCH_QUERIES.length)%PRICE_TIERS.length],sort:'priceup',page:1,changesProductionPolicy:false};}
export function pricePolicy(policy={}){return {...policy,audience_quality:{...policy.audience_quality,enabled:true,excluded:[...new Set([...Object.keys(QUALITY_CATEGORIES),...(policy.audience_quality?.excluded||[])])]}};}
const fresh=(at,now,max=3600000)=>Number.isSafeInteger(at)&&at>0&&at<=now&&now-at<=max;
function analyseRecord(record,{now=Date.now(),policy={},comparables=[],publication={historyChecked:false,published:false}}={}){
  const metadata=record.metadata||{},p={...metadata,...record.product},reasons=[],blocked=ownerReason({...p,title:p.title||p.name},pricePolicy(policy));
  if(blocked)reasons.push(blocked);const fashion=fashionCategory(p);if(!fashion.allowed)reasons.push(fashion.reason);
  const filter=selectionReason({...p,title:p.title||p.name,product:p.price,feedbacks:p.reviews},policy);if(filter)reasons.push(filter);
  if(!record.confirmed||p.priceContextConfirmed!==true||p.context?.paymentBasis!=='standard')reasons.push('PRICE_NOT_CONFIRMED');
  const qualityFresh=p.qualityVerified===true&&Number.isSafeInteger(p.qualityObservedAt)&&p.qualityObservedAt<=now&&now-p.qualityObservedAt<=3600000;
  const stockFresh=Number.isSafeInteger(p.stockObservedAt)&&p.stockObservedAt<=now&&now-p.stockObservedAt<=3600000;
  if(!qualityFresh)reasons.push('QUALITY_NOT_CONFIRMED');if(!stockFresh)reasons.push('STOCK_NOT_CONFIRMED');
  if(p.categoryVerified!==true||!fresh(p.categoryObservedAt,now,86400000))reasons.push('CATEGORY_NOT_CONFIRMED');
  if(p.context?.authentication!=='anonymous')reasons.push('ANONYMOUS_CONTEXT_NOT_CONFIRMED');
  const peers=comparables;
  const value=assessValue(p,{now,comparables:peers,policy:{minRating:Number(policy.min_rating??4.3),minReviews:Number(policy.min_feedbacks??20),maxPriceAgeMs:3600000}});reasons.push(...value.rejectedReasons);
  const confirmed=stockFresh&&Number.isSafeInteger(p.id)&&p.id>0&&p.id<1e12&&p.id===record.id&&record.confirmed===true&&p.priceContextConfirmed===true&&p.context?.authentication==='anonymous'&&p.context?.paymentBasis==='standard'&&value.price.valid&&p.available===true&&value.variant.matches>0&&!value.variant.conditioned,eligible=confirmed&&!reasons.length,historyDrop=eligible&&value.history.known&&value.history.savingsPercent>=15,marketDrop=eligible&&value.market.known&&!value.market.outlier&&value.market.savingsPercent>=15;
  const kind=!confirmed?'unconfirmed':!eligible?'rejected':historyDrop?'own_price_drop':marketDrop?'below_comparables':p.price<=500?'cheap':'no_verified_savings';
  const explanation=kind==='rejected'?'Цена подтверждена, но товар не прошёл фильтры качества или категории.':kind==='own_price_drop'?`Ниже собственной наблюдавшейся медианы ${value.history.referencePrice} ₽ на ${value.history.savingsPercent}%; ${value.history.distinctDays} разных дней.`:
    kind==='below_comparables'?`Ниже медианы ${value.market.peers} проверенных сопоставимых товаров на ${value.market.savingsPercent}%. Это ограниченная выборка.`:
    kind==='cheap'?'Дешёвый товар с проверенной ценой. Подтверждённой скидки пока нет.':kind==='no_verified_savings'?'Цена проверена, преимущество по истории или сопоставимой выборке не доказано.':'Цена не подтверждена; товар не предлагается как актуальная находка.';
  const assessment=eligible?assessSuperfind(p,{now,comparables:peers,...publication}):{mode:'PREVIEW_ONLY',eligible:false,reasons:[...new Set(reasons)],autoPublication:false};
  let image=null;try{metadataURL(p.image,p.id);image=p.image;}catch{}
  return {id:p.id||record.id,name:p.name||p.title||String(record.id),image,url:Number.isSafeInteger(p.id)&&p.id>0&&p.id<1e12?`https://www.wildberries.ru/catalog/${p.id}/detail.aspx`:null,category:p.category||null,
    confirmedPrice:confirmed?p.price:null,priceStatus:confirmed?'confirmed':record.priceStatus==='confirmed'?'unconfirmed':record.priceStatus||'unconfirmed',observedAt:confirmed?p.observedAt:null,lastAttemptAt:record.checkedAt||null,
    rating:p.rating??null,reviews:p.reviews??null,available:confirmed?p.available:null,sizes:confirmed?(p.variants||[]).filter(v=>v.available===true).map(v=>({size:v.size,price:v.price,variantKey:v.variantKey})):[],
    kind,explanation,rejectedReasons:[...new Set(reasons)],source:p.priceSource||'unknown',context:confirmed?p.context:null,
    snapshotPrice:metadata.snapshotPrice??null,observedSourceQuote:p.observedQuote??null,sourceQuoteDisclaimer:'Число из API или старого снимка не подтверждает доступную стандартную цену покупателя.',
    sellerDiscountEvidence:false,anomalousOwnDrop:historyDrop&&value.history.savingsPercent>=40,value,superfind:assessment,publicationEnabled:false};
}
export function analysePriceRecord(record,options={}){
  const now=options.now??Date.now();
  // Validate the peer pool once. No public flag bypasses this evidence gate.
  const comparables=(options.comparables??[]).filter(peer=>{const check=analyseRecord({id:peer.id,product:peer,confirmed:true},{now,policy:options.policy});return check.confirmedPrice!==null&&!check.rejectedReasons.length;});
  return analyseRecord(record,{...options,now,comparables});
}
export function analysePricePool(records,options={}){
  if(!Array.isArray(records)||records.length>100)throw Error('PRICE_POOL_LIMIT');
  const now=options.now??Date.now(),preflight=records.map(r=>analyseRecord(r,{...options,now,comparables:[]}));
  const comparables=records.filter((r,i)=>preflight[i].confirmedPrice!==null&&!preflight[i].rejectedReasons.length).map(r=>({...r.metadata,...r.product})),items=records.map(r=>analyseRecord(r,{...options,now,comparables}));
  return {mode:'ISOLATED_PREVIEW',items,total:items.length,confirmed:items.filter(p=>p.confirmedPrice!==null).length,unconfirmed:items.filter(p=>p.confirmedPrice===null).length,
    tiers:PRICE_TIERS.map(maxPrice=>({maxPrice,items:items.filter(p=>p.confirmedPrice!==null&&p.confirmedPrice<=maxPrice&&['cheap','own_price_drop','below_comparables'].includes(p.kind))})),verifiedBargains:items.filter(p=>['own_price_drop','below_comparables'].includes(p.kind)),
    superfindState:items.some(p=>p.superfind.eligible)?'VERIFIED_CANDIDATES_PREVIEW_ONLY':'WAIT',autoPublication:false};
}
/** Trusted integration handoff, NOT a writer. Existing ingestVerifiedProducts
 * will revalidate these bytes/evidence. No production binding is used here. */
export function catalogueEnvelope(product,photo,{now=Date.now()}={}){
  const categorySource=product?.category_source==='wb-cdn'?'wb_cdn_metadata':product?.category_source??product?.categorySource;
  if(!['wb_cdn_metadata','wb_card','wb_page','wb_catalog','wb_search'].includes(categorySource))throw Error('CATALOGUE_CATEGORY_SOURCE_UNKNOWN');
  if(product?.priceContextConfirmed!==true||product.context?.authentication!=='anonymous'||product.categoryVerified!==true||product.qualityVerified!==true||!fresh(product.stockObservedAt,now)||!fresh(product.qualityObservedAt,now)||!fashionCategory(product).allowed||ownerReason({...product,title:product.name||product.title},pricePolicy())||product.context?.paymentBasis!=='standard'||
    !assessValue(product,{now,policy:{maxPriceAgeMs:3600000}}).eligible||!(photo?.bytes instanceof Uint8Array)||!photo.sourceUrl||!Number.isSafeInteger(photo.observedAt)||!Number.isSafeInteger(product.categoryObservedAt)||now-product.categoryObservedAt>86400000||product.categoryObservedAt>now||photo.observedAt>now||now-photo.observedAt>3600000)throw Error('CATALOGUE_PROOF_INCOMPLETE');
  return {product,evidence:{sourceProductId:product.id,categorySource,categoryObservedAt:product.categoryObservedAt,
    priceSource:product.priceSource,priceObservedAt:product.observedAt,stockSource:product.priceSource,stockObservedAt:product.stockObservedAt,qualitySource:product.priceSource,qualityObservedAt:product.qualityObservedAt,audienceSource:product.audienceSource,audienceObservedAt:product.audienceObservedAt},photo};
}
