// Owner-approved editorial limits, 27 Oct 2026. Pure rules; no I/O or learning.
import {assessValue,priceContextKey} from '../shadow/value.mjs';
import {FASHION_CATEGORIES} from '../shadow/calibration.mjs';
const fold=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').trim();
export const FASHION_BUDGETS=Object.freeze({tops:800,knit:1500,bottoms_hoodies:2500,shoes:3500,outer:4500,accessories:1500,dresses:2500,skirts:1500,shirts:1500,cardigans:2500});
const groups=[
 ['tops',['Футболки','Топы','Майки','Поло']],
 ['knit',['Лонгсливы','Свитеры','Джемперы','Пуловеры','Водолазки','Кофты','Свитшоты']],
 ['bottoms_hoodies',['Джинсы','Брюки','Худи','Толстовки']],
 ['shoes',['Кроссовки','Кеды','Ботинки','Полуботинки','Сапоги','Полусапожки','Ботильоны','Лоферы']],
 ['outer',['Куртки','Бомберы','Ветровки','Пальто','Полупальто','Плащи','Тренчкоты','Пуховики','Парки']],
 ['dresses',['Платья','Сарафаны']],['skirts',['Юбки']],['shirts',['Рубашки','Блузки','Блузоны']],['cardigans',['Кардиганы']]
];
const byCategory=new Map(groups.flatMap(([key,names])=>names.map(name=>[fold(name),key])));
for(const category of [...FASHION_CATEGORIES.bags,...FASHION_CATEGORIES.accessories,'Комплекты украшений','Подвески бижутерные'])byCategory.set(fold(category),'accessories');
export const VERIFIED_VALUE_EXCEPTIONS=Object.freeze({enabled:false,maxPrices:Object.freeze({}),minSavingsPercent:30});
export function fashionBudget(p,{group=null,exceptions=VERIFIED_VALUE_EXCEPTIONS,valueProduct=null,now=Date.now()}={}){
 if(p.category_source!=='wb-cdn')return {allowed:false,reason:'CATEGORY_BUDGET_UNCONFIRMED'};
 const key=byCategory.get(fold(p.category)),cap=FASHION_BUDGETS[key],price=Number(p.product??p.price);
 if(!cap)return {allowed:false,reason:'CATEGORY_BUDGET_NOT_DEFINED'};
 if(!Number.isFinite(price)||price<=0)return {allowed:false,reason:'PRICE_UNKNOWN',key,cap};
 const result={pid:p.id,category:fold(p.category),key,cap,price,budgetFind:price<=300,exception:false};
 if(price<=cap)return {...result,allowed:true,reason:'WITHIN_OWNER_CATEGORY_BUDGET'};
 // OFF by default. Even opting in cannot raise a ceiling without an explicit
 // per-group maximum and the existing verified same-context history checks.
 const ceiling=exceptions?.maxPrices?.[key];
 const sameContext=priceContextKey(p.context),sameVariant=typeof p.variantKey==='string'&&p.variantKey!=='unknown'&&valueProduct?.variantKey===p.variantKey;
 if(exceptions?.enabled===true&&Number.isFinite(ceiling)&&ceiling>cap&&price<=ceiling&&valueProduct?.id===p.id&&valueProduct.price===price&&sameVariant&&p.currency==='RUB'&&valueProduct.currency==='RUB'&&sameContext&&sameContext===priceContextKey(valueProduct.context)&&valueProduct.categoryVerified===true&&fold(valueProduct.category)===fold(p.category)&&fashionQuoteState(p,now).freshVariantObservation){
  const v=assessValue(valueProduct,{now});
  if(v.eligible&&v.history.known&&v.history.confidence>=.8&&v.history.savingsPercent>=Math.max(30,Number(exceptions.minSavingsPercent)||30))return {...result,allowed:true,reason:'EXPLICIT_VERIFIED_VALUE_EXCEPTION',exception:true,exceptionCap:ceiling};
 }
 return {...result,allowed:false,reason:'ABOVE_OWNER_CATEGORY_BUDGET'};
}
// A separate fashion proposal uses the owner's category ceilings. Legacy and
// its persisted global price limit remain unchanged. Other owner rules survive.
export function fashionGatePolicy(policy={}){
 return {...policy,max_price:0,...(policy.selection?{selection:{...policy.selection,max_price:0}}:{})};
}
export function fashionQuoteState(p,now=Date.now()){
 const at=p?.priceObservedAt,price=Number(p?.product??p?.price),provenance=p?.priceProvenance;
 const contextKey=c=>c?.currency==='RUB'&&/^-?\d{1,10}$/.test(String(c.destination??''))&&typeof c.paymentBasis==='string'?JSON.stringify(['RUB',String(c.destination),c.paymentBasis]):null;
 const context=contextKey(p?.context),matches=Array.isArray(p?.variants)&&p.variants.length<=100?p.variants.filter(v=>v.variantKey===p.variantKey):[],v=matches.length===1?matches[0]:null;
 const identity=Number.isSafeInteger(p?.id)&&p.id>0&&/^\d+$/.test(p?.variantKey||'')&&Number(p.variantKey)>0&&v?.available===true&&v.price===price&&v.size===p.size&&v.currency==='RUB'&&context&&contextKey(v.context)===context&&contextKey(provenance?.requestedContext)===context&&(!p.requestedContext||contextKey(p.requestedContext)===context)&&(!provenance?.pid||provenance.pid===p.id)&&(!provenance?.variantKey||provenance.variantKey===p.variantKey)&&(!provenance?.size||provenance.size===p.size);
 const valid=!!identity&&Number.isFinite(price)&&price>0&&(!Object.hasOwn(p,'price')||p.price===price)&&Number.isSafeInteger(at)&&at<=now&&now-at<=15*60000&&p.priceStatus==='api_observed'&&p.priceSource==='wb_card'&&p.fallback===false&&p.available===true&&p.currency==='RUB'&&provenance?.kind==='details'&&provenance.method==='GET'&&provenance.status===200&&provenance.receivedAt===at&&p.stockObservedAt===at&&(!p.observedAt||p.observedAt===at);
 return {freshVariantObservation:!!valid,ordinaryRetailConfirmed:!!valid&&p.retailPriceConfirmed===true&&p.priceContextConfirmed===true&&priceContextKey(p.context)!==null,reason:valid?'FRESH_DETAILS_VARIANT_API_OBSERVATION':'FRESH_VARIANT_QUOTE_REQUIRED',observedAt:valid?at:null,size:valid?p.size||null:null};
}
export function fashionAcceptance(p,{styleApproved=false,ownerApproved=false,budget=null,now=Date.now()}={}){
 const quote=fashionQuoteState(p,now),actualBudget=fashionBudget(p);
 // API observations are labelled separately; unknown retail/payment context
 // never becomes an ordinary-retail confirmation or a completed release gate.
 return {styleSuitable:styleApproved===true,withinBudget:actualBudget.allowed===true,priceObserved:quote.freshVariantObservation,retailPriceConfirmed:quote.ordinaryRetailConfirmed,ownerApproved:ownerApproved===true,readyForPublication:styleApproved===true&&ownerApproved===true&&actualBudget.allowed===true&&quote.ordinaryRetailConfirmed&&p.available===true,quote,budget:actualBudget};
}
const escape=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export function fashionCaption(p,{reason,now=Date.now()}={}){
 const q=fashionQuoteState(p,now);if(!q.freshVariantObservation||typeof reason!=='string'||!reason.trim()||reason.length>220)return null;
 const stamp=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(q.observedAt);
 const quality=Number.isFinite(p.rating)&&p.rating>0?'\n⭐ '+p.rating+(Number.isSafeInteger(p.feedbacks)?' · '+p.feedbacks+' отзывов':''):'';
 return '<b>'+escape(String(p.title||'').slice(0,90))+'</b>\n\nWB · '+Number(p.product??p.price).toLocaleString('ru-RU')+' ₽'+(q.size?' · размер '+escape(q.size):'')+'\nЦена из ответа WB: '+stamp+' МСК\n'+escape(reason.trim())+quality+'\n\nУсловия оплаты и конечную цену проверьте на WB.';
}
