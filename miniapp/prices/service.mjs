// Explicit operator invocation only. No cron, HTTP ingest, production binding,
// Telegram or AI. The caller must openPriceStore with an approved isolated DB.
import {analysePricePool,planBudgetSearch,pricePolicy} from './analysis.mjs';
import {normalizeWBCard} from '../shadow/discovery.mjs';
import {fashionCategory} from '../shadow/calibration.mjs';
import {ownerReason} from '../cloudflare/audience_quality.mjs';
export async function discoverProspects({store,source,enabled=false,cursor=0,higherPriceWatch=false,now=Date.now,policy={}}={}){
  if(!enabled)return {status:'disabled',sourceCalls:0,publication:'NONE'};
  if(source?.name!=='wb-card'||source.readOnly!==true||typeof source.search!=='function')throw Error('READ_ONLY_WB_SEARCH_REQUIRED');
  const plan={...planBudgetSearch(cursor),...(higherPriceWatch?{maxPrice:100000,sort:'popular',purpose:'observe_own_price_history'}:{})};
  const lease=await store.acquire('wb-search',{now:now(),requestCost:1});
  if(!lease.admitted)return {status:lease.reason||'blocked_or_not_due',sourceCalls:0,publication:'NONE'};
  try{
    const result=await source.search(plan);if(!Array.isArray(result.products)||result.products.length>100)throw Error('INVALID_SEARCH_BATCH');
    const ids=new Set(),products=[];
    for(const raw of result.products){const normalized=normalizeWBCard(raw,{now:now(),query:plan.query,context:source.context});
      const p=normalized?{...normalized,categoryVerified:typeof raw.subjectName==='string'&&!!raw.subjectName.trim(),category_source:'wb_search',categoryObservedAt:now()}:null;
      if(!p||ids.has(p.id)||p.price>plan.maxPrice||p.available!==true||p.rating<Number(policy.min_rating??4.3)||!Number.isSafeInteger(p.reviews)||p.reviews<Number(policy.min_feedbacks??20)||!fashionCategory(p).allowed||ownerReason({...p,title:p.name},pricePolicy(policy)))continue;
      ids.add(p.id);products.push({...p,source:source.name,priceContextConfirmed:false});if(products.length===20)break;
    }
    if(products.length)await store.track(products,{now:now()});
    await store.finish('wb-search',lease.owner,{now:now(),status:200,ok:true});
    return {status:'ok',sourceCalls:1,prospects:products.length,plan,priceConfirmed:0,publication:'NONE'};
  }catch(e){await store.finish('wb-search',lease.owner,{now:now(),status:Number.isInteger(e.status)?e.status:0,retryAfterMs:e.retryAfterMs||0});return {status:'source_unavailable',http:Number.isInteger(e.status)?e.status:0,sourceCalls:1,publication:'NONE'};}
}
export async function pricePreview(store,{now=Date.now(),policy={},historyIds}={}){
  if(historyIds!==undefined&&(!Array.isArray(historyIds)||historyIds.length>20||new Set(historyIds).size!==historyIds.length||historyIds.some(id=>!Number.isSafeInteger(id)||id<=0)))throw Error('PREVIEW_HISTORY_BATCH_LIMIT');
  const records=await store.list({now});
  const selected=new Set(historyIds??records.filter(r=>r.confirmed).slice(0,20).map(r=>r.id));
  // At most20 history reads per invocation, including a100card catalogue.
  for(const r of records)if(r.confirmed&&selected.has(r.id))r.product.history=await store.history(r.product,{now});
  return analysePricePool(records,{now,policy});
}
export async function refreshWatched({store,source,enabled=false,now=Date.now,policy={}}={}){
  if(!enabled)return {status:'disabled',sourceCalls:0,publication:'NONE',aiCalls:0};
  if(!source?.readOnly||typeof source.details!=='function')throw Error('READ_ONLY_APPROVED_SOURCE_REQUIRED');
  const due=await store.due({now:now(),limit:20});
  if(!due.length)return {status:'not_due',sourceCalls:0,publication:'NONE',aiCalls:0};
  // A refresh cannot silently switch a watch item to another provider.
  const group=due.filter(p=>p.source===source.name);
  if(!group.length)return {status:'source_review_required',sourceCalls:0,publication:'NONE',aiCalls:0};
  const lease=await store.acquire(source.name,{now:now(),requestCost:1});
  if(!lease.admitted)return {status:lease.reason||'blocked_or_not_due',sourceCalls:0,publication:'NONE',aiCalls:0};
  try{
    const result=await source.details(group.map(p=>p.id)),expected=new Set(group.map(p=>p.id));
    if(!Array.isArray(result.products)||result.products.length>20||result.products.some(p=>!expected.has(p.id))||new Set(result.products.map(p=>p.id)).size!==result.products.length)throw Error('INVALID_SOURCE_BATCH');
    const products=group.map(p=>({...p,...result.products.find(x=>x.id===p.id),source:source.name,...(!result.products.some(x=>x.id===p.id)?{price:null,available:null,priceContextConfirmed:false}:{})}));
    await store.ingest(products,{now:now()});
    await store.finish(source.name,lease.owner,{now:now(),status:200,ok:true});
    return {status:'ok',sourceCalls:1,preview:await pricePreview(store,{now:now(),policy,historyIds:group.map(p=>p.id)}),publication:'NONE',aiCalls:0};
  }catch(e){
    await store.finish(source.name,lease.owner,{now:now(),status:Number.isInteger(e.status)?e.status:0,retryAfterMs:e.retryAfterMs||0});
    // Whitelist only; upstream exception strings/bodies/headers never escape.
    return {status:'source_unavailable',http:Number.isInteger(e.status)?e.status:0,sourceCalls:1,publication:'NONE',aiCalls:0};
  }
}
