// Pure bounded sanitizer + private service-binding delivery. No additional WB
// fetches, source credentials, production D1 access or raw-body logging.
import {normalizeRuntimeQuote} from './runtime_quote.mjs';
export const PASSIVE_WIRE_LIMITS=Object.freeze({cards:20,sizes:100,bytes:65536,ttlMs:86400000});
const id=v=>Number.isSafeInteger(v)&&v>0&&v<1e12;
const run=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,100}$/.test(v);
const epoch=v=>Number.isSafeInteger(v)&&v>1e11;
export function sanitizePassiveResponse(event,{runId,now=Date.now(),eventId=crypto.randomUUID()}={}){
  if(!run(runId)||!run(eventId)||event?.kind!=='details'||event.method!=='GET'||!epoch(event.receivedAt)||event.receivedAt>now||now-event.receivedAt>300000)return null;
  let u;try{u=new URL(event.url);}catch{return null;}
  if(u.origin!=='https://card.wb.ru'||u.pathname!=='/cards/v4/detail'||u.username||u.password||u.hash||u.port)return null;
  const destination=u.searchParams.get('dest'),spp=u.searchParams.get('spp'),currency=u.searchParams.get('curr');
  if(currency!=='rub'||!/^\-?\d{1,10}$/.test(destination||'')||!/^\d{1,3}$/.test(spp||''))return null;
  const requestedIds=(u.searchParams.get('nm')||'').split(';').map(Number);
  if(!requestedIds.length||requestedIds.length>20||requestedIds.some(n=>!id(n))||new Set(requestedIds).size!==requestedIds.length)return null;
  const requestedContext={currency:'RUB',destination,spp,paymentBasis:'unknown'};
  const status=Number.isInteger(event.status)&&event.status>=0&&event.status<=599?event.status:0;
  const input=Array.isArray(event.products)?event.products.slice(0,PASSIVE_WIRE_LIMITS.cards):[],offers=[];
  for(const nmId of requestedIds){
    const matches=input.filter(c=>c?.id===nmId),card=matches.length===1?matches[0]:null;
    const p=status===200&&card?normalizeRuntimeQuote(card,{now:event.receivedAt,context:requestedContext,allowUnknownStock:true}):null;
    const stable=p&&/^\d{1,12}$/.test(p.variantKey??''),known=p?.available===true&&stable;
    const v=p?.variants?.find(x=>x.variantKey===p.variantKey&&x.price===p.price&&x.available===p.available);
    offers.push({id:nmId,variantKey:stable?p.variantKey:'unknown',size:v?.size?.slice(0,40)||null,
      price:p?.price??null,currency:'RUB',available:p?.available??null,
      priceObservedAt:p?event.receivedAt:null,stockObservedAt:typeof p?.available==='boolean'?event.receivedAt:null,
      verificationStatus:known?'api_observed':'unconfirmed',retailConfirmed:false,
      context:null,requestedContext:{...requestedContext}});
  }
  const result={eventId,runId,at:event.receivedAt,source:'wb_card',method:'GET',acquisition:'native_details',httpStatus:status,
    fallback:false,requestedContext,offers,outcome:status!==200?'error':offers.some(o=>o.price!==null)?'success':'invalid'};
  return new TextEncoder().encode(JSON.stringify(result)).byteLength<=PASSIVE_WIRE_LIMITS.bytes?result:null;
}
export function createPassiveObserver(env,ctx,{now=Date.now,onSafeResult}={}){
  const started=Number(env.PRICE_OBSERVATION_STARTED_AT),expires=Number(env.PRICE_OBSERVATION_EXPIRES_AT),runId=env.PRICE_OBSERVATION_RUN_ID;
  if(env.PRICE_OBSERVATION_ENABLED!=='1'||!run(runId)||!epoch(started)||!epoch(expires)||expires<=started||expires-started>PASSIVE_WIRE_LIMITS.ttlMs||now()<started||now()>=expires||typeof env.PRICE_OBSERVER?.fetch!=='function'||typeof ctx?.waitUntil!=='function')return undefined;
  let closed=false;
  return event=>{
    if(closed||now()>=expires)return;
    const sanitized=sanitizePassiveResponse(event,{runId,now:now()});if(!sanitized)return;
    // The collector performs D1 work in a DIFFERENT Worker invocation. Every
    // failure stays optional; there is deliberately no retry and no fallback WB.
    const delivery=Promise.resolve().then(()=>env.PRICE_OBSERVER.fetch(new Request('https://price-observer.internal/capture',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sanitized),signal:AbortSignal.timeout(3000)
    }))).then(async response=>{
      if(!response.ok)return;
      const result=await response.json();
      if(['complete','disabled','expired','stopped','daily_budget','metadata_unavailable','meter_unknown','budget_exceeded','DAILY_WRITE_BUDGET'].includes(result.status)||result.accepted>=20)closed=true;
      const m=result.d1,validMeter=m&&['queries','rows_read','rows_written'].every(k=>Number.isFinite(m[k])&&m[k]>=0);
      if(typeof onSafeResult==='function')onSafeResult({status:typeof result.status==='string'?result.status:'unknown',...(validMeter?{d1:{queries:m.queries,rows_read:m.rows_read,rows_written:m.rows_written,metadata_available:m.metadata_available===true,metadata_complete:m.metadata_complete===true}}:{})});
    }).catch(()=>{if(typeof onSafeResult==='function')onSafeResult({status:'delivery_unavailable'});});
    ctx.waitUntil(delivery);
  };
}
