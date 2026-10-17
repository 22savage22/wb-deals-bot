// Preview only. Data in must be server-resolved; no Telegram send, scheduler or I/O.
import {assessValue,priceContextKey} from '../shadow/value.mjs';
export const SUPERFIND_DEFAULTS=Object.freeze({enabled:false,minRating:4.6,minReviews:100,minSavings:15,maxPriceAgeMinutes:60});
export function superfindSettings(input={}){
  const p={...SUPERFIND_DEFAULTS,...input};
  if(typeof p.enabled!=='boolean'||!Number.isFinite(p.minRating)||p.minRating<4.3||p.minRating>5||!Number.isSafeInteger(p.minReviews)||p.minReviews<20||p.minReviews>10000||!Number.isFinite(p.minSavings)||p.minSavings<5||p.minSavings>70||!Number.isSafeInteger(p.maxPriceAgeMinutes)||p.maxPriceAgeMinutes<5||p.maxPriceAgeMinutes>120)throw Error('INVALID_SUPERFIND_SETTINGS');
  return Object.fromEntries(Object.keys(SUPERFIND_DEFAULTS).map(key=>[key,p[key]]));
}
export function assessSuperfind(product,{now=Date.now(),settings={},comparables=[],historyChecked=false,published=false}={}){
  const policy=superfindSettings(settings),value=assessValue(product,{now,comparables,policy:{minRating:policy.minRating,minReviews:policy.minReviews,maxPriceAgeMs:policy.maxPriceAgeMinutes*60000}});
  const reasons=[...value.rejectedReasons];
  if(!historyChecked)reasons.push('publication_history_unverified');
  if(published)reasons.push('already_published');
  if(!/^[a-f0-9]{64}$/i.test(product.imageHash??''))reasons.push('photo_not_verified');
  if(!product.variantKey||!priceContextKey(product.context)||product.currency!=='RUB')reasons.push('price_context_or_variant_unknown');
  if(!Number.isFinite(product.stockObservedAt)||now-product.stockObservedAt<0||now-product.stockObservedAt>policy.maxPriceAgeMinutes*60000)reasons.push('stock_evidence_not_fresh');
  if(product.qualityRisk===true||Array.isArray(product.qualityWarnings)&&product.qualityWarnings.length)reasons.push('quality_warning');
  if(value.market.outlier)reasons.push('unexplained_market_price_outlier');
  const reference=[value.history,value.market].filter(row=>row.known&&row.savingsPercent>=policy.minSavings&&!row.outlier).sort((a,b)=>b.confidence-a.confidence)[0]??null;
  if(!reference)reasons.push('verified_savings_below_threshold_or_unknown');
  let imageOK=false;try{const u=new URL(product.image);imageOK=u.protocol==='https:'&&!u.username&&!u.password&&/(?:^|\.)wbbasket\.ru$/.test(u.hostname);}catch{}
  if(!imageOK)reasons.push('photo_source_invalid');
  return {mode:'PREVIEW_ONLY',eligible:!reasons.length,reasons:[...new Set(reasons)],value,reference,
    settings:policy,autoPublication:false,consumesExistingSlotOnly:true,
    qualityDisclaimer:'Рейтинг и отзывы — проверяемые сигналы, не гарантия качества.'};
}
const escape=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export function superfindPreview(product,assessment){
  if(!assessment?.eligible)throw Error('SUPERFIND_NOT_VERIFIED');
  const r=assessment.reference;
  const why=r.reason==='observed_price_history'?`По наблюдениям за ${r.distinctDays} разных дней: медиана ${r.referencePrice} ₽; ниже на ${r.savingsPercent}%.`:
    `В проверенной выборке ${r.peers} сопоставимых товаров медиана ${r.medianPrice} ₽; ниже на ${r.savingsPercent}% (не весь рынок).`;
  const caption=`🔥 <b>СУПЕРНАХОДКА ДНЯ</b>\n\n${escape(product.name.slice(0,180))}\n\n💰 Цена: ${product.price} ₽\n📉 Почему это выгодно: ${escape(why)}\n⭐ ${product.rating} · отзывов ${product.reviews}\n\nЦена проверена ${assessment.value.price.observedAt}. Вариант: ${escape(product.variantKey)}. Условия цены указаны в подтверждении.`;
  return {caption,parse_mode:'HTML',photo:product.image,url:`https://www.wildberries.ru/catalog/${product.id}/detail.aspx`,
    reply_markup:{inline_keyboard:[[{text:'🛍 Открыть Wildberries',url:`https://www.wildberries.ru/catalog/${product.id}/detail.aspx`}]]},
    publication:'FORBIDDEN_PREVIEW',proof:{price:product.price,source:product.priceSource,observedAt:product.observedAt,stockObservedAt:product.stockObservedAt,variant:product.variantKey,context:product.context,reference:r}};
}
