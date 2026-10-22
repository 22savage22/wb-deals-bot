// Public read-only consumer adapter. No sessions, credentials or endpoint fallback.
import {normalizeWBCard} from '../shadow/discovery.mjs';
import {metadataURL,cardAudience} from '../features/catalogue_source.mjs';
export const SOURCE_LIMITS=Object.freeze({ids:20,bytes:2_000_000,metadataBytes:131072,timeoutMs:10000});
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
const common={appType:'1',curr:'rub',dest:'-1257786',spp:'30',lang:'ru'};
export class PriceSourceError extends Error{constructor(code,status=0,receipt={}){super(code);this.code=code;this.status=status;this.receipt=receipt;this.retryAfterMs=receipt.retryAfterMs||0;}}
export function retryAfterMs(value,now=Date.now()){
  if(!value)return 0;const delay=/^\d+$/.test(value.trim())?Number(value)*1000:Date.parse(value)-now;
  return Number.isFinite(delay)&&delay>0?Math.min(delay,7*86400000):0;
}
async function readJSON(url,{fetcher,now,limit=SOURCE_LIMITS.bytes}){
  const at=now();let r;
  try{r=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(SOURCE_LIMITS.timeoutMs),headers:{Accept:'application/json','Accept-Language':'ru-RU,ru;q=0.9'}});}catch(e){throw new PriceSourceError(e.name==='TimeoutError'?'SOURCE_TIMEOUT':'SOURCE_UNAVAILABLE');}
  const u=new URL(url),receipt={host:u.hostname,path:u.pathname,status:r.status,checkedAt:new Date(at).toISOString(),contentType:(r.headers.get('content-type')||'').slice(0,100),server:(r.headers.get('server')||'').slice(0,60),retryAfterMs:retryAfterMs(r.headers.get('retry-after'),at),cfRayPresent:r.headers.has('cf-ray')};
  if(r.status>=300&&r.status<400){await r.body?.cancel();throw new PriceSourceError('SOURCE_REDIRECT_REFUSED',r.status,receipt);}
  const reader=r.body?.getReader(),chunks=[];let total=0;if(!reader)throw new PriceSourceError('SOURCE_EMPTY_BODY',r.status,receipt);
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw new PriceSourceError('SOURCE_BODY_LIMIT',r.status,receipt);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const v of chunks){bytes.set(v,offset);offset+=v.length;}const text=new TextDecoder().decode(bytes);
  receipt.bytes=total;receipt.challengeMarkers=/captcha|qrator|access denied|request blocked|forbidden/i.test(text);
  receipt.bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(!r.ok)throw new PriceSourceError('WB_HTTP_'+r.status,r.status,receipt);
  if(!/json/i.test(receipt.contentType))throw new PriceSourceError('SOURCE_NOT_JSON',r.status,receipt);
  let data;try{data=JSON.parse(text);}catch{throw new PriceSourceError('SOURCE_INVALID_JSON',r.status,receipt);}return {data,receipt,observedAt:at};
}
export function createWBPriceSource({fetcher=fetch,now=Date.now,destination='-1257786',spp='30'}={}){
  if(!/^-?\d{1,10}$/.test(destination)||!/^\d{1,3}$/.test(spp))throw Error('INVALID_PRICE_CONTEXT');
  const params={...common,dest:destination,spp},context={currency:'RUB',destination,paymentBasis:'unknown',spp,authentication:'anonymous'};
  return {readOnly:true,name:'wb-card',context,
    async search({query,maxPrice=500,sort='priceup'}={}){
      if(typeof query!=='string'||query.trim().length<2||query.length>100||!Number.isSafeInteger(maxPrice)||maxPrice<1||maxPrice>100000||!['priceup','popular'].includes(sort))throw Error('INVALID_SEARCH');
      const u=new URL('https://search.wb.ru/exactmatch/ru/common/v9/search');u.search=new URLSearchParams({...params,query:query.trim(),priceU:'0;'+maxPrice*100,page:'1',sort,resultset:'catalog'}).toString();
      const r=await readJSON(u.href,{fetcher,now}),cards=r.data?.products??r.data?.data?.products;if(!Array.isArray(cards))throw new PriceSourceError('SOURCE_INVALID_PRODUCTS',200,r.receipt);
      return {...r,products:cards.slice(0,100),context:{...context},priceEvidence:'SEARCH_DISCOVERY_ONLY'};
    },
    async details(ids){
      if(!Array.isArray(ids)||!ids.length||ids.length>SOURCE_LIMITS.ids||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw Error('INVALID_DETAIL_IDS');
      const u=new URL('https://card.wb.ru/cards/v4/detail');u.search=new URLSearchParams({...params,nm:ids.join(';')}).toString();
      const r=await readJSON(u.href,{fetcher,now}),cards=r.data?.products??r.data?.data?.products;if(!Array.isArray(cards))throw new PriceSourceError('SOURCE_INVALID_PRODUCTS',200,r.receipt);
      const products=[],missing=[];
      for(const id of ids){const found=cards.filter(c=>c?.id===id);if(found.length!==1){missing.push({id,reason:found.length?'DUPLICATE_PRODUCT_RESPONSE':'PRODUCT_NOT_RETURNED'});continue;}
        const p=normalizeWBCard(found[0],{now:r.observedAt,context,allowUnknownStock:true});if(!p){missing.push({id,reason:'NO_VALID_PRICED_VARIANT'});continue;}
        // The endpoint does not attest payment basis or that a requested dest was
        // honoured. An observed numeric quote is NOT a universal retail price.
        products.push({...p,source:'wb-card',stockObservedAt:typeof p.available==='boolean'?r.observedAt:null,qualityObservedAt:r.observedAt,
          categoryVerified:typeof found[0].subjectName==='string'&&!!found[0].subjectName.trim(),category_source:'wb_card',categoryObservedAt:r.observedAt,qualityVerified:Number.isFinite(p.rating)&&Number.isSafeInteger(p.reviews),
          priceContextConfirmed:false,priceContextEvidence:'REQUEST_PARAMETERS_ONLY',priceCondition:'unknown',
          observedQuote:p.price,retailPriceConfirmed:false,priceLabel:'Цена API; условия оплаты не подтверждены',
          provenance:{origin:'anonymous_consumer_endpoint',host:r.receipt.host,checkedAt:r.receipt.checkedAt,requestedContext:{...context},paymentBasis:'unknown'}});
      }return {products,missing,receipt:r.receipt,rawCards:cards.filter(c=>ids.includes(c?.id))};
    },
    async metadata(product){
      if(!validId(product?.id))throw Error('INVALID_METADATA_ID');const u=metadataURL(product.image,product.id),r=await readJSON(u,{fetcher,now,limit:SOURCE_LIMITS.metadataBytes});
      if(Number(r.data?.nm_id)!==product.id)throw new PriceSourceError('METADATA_PRODUCT_MISMATCH',200,r.receipt);
      const category=r.data.subj_name||r.data.subjectName;if(typeof category!=='string'||!category.trim())throw new PriceSourceError('METADATA_CATEGORY_UNKNOWN',200,r.receipt);
      return {product:{...product,name:typeof r.data.imt_name==='string'?r.data.imt_name:product.name||product.title,category,category_root:r.data.subj_root_name||'',category_source:'wb-cdn',categoryVerified:true,categoryObservedAt:r.observedAt,audience:cardAudience(r.data,product.id)||'unknown',audienceVerified:!!cardAudience(r.data,product.id),audienceSource:'wb_cdn_metadata',audienceObservedAt:r.observedAt},receipt:r.receipt};
    }
  };
}

/** Server-only observation from an explicitly approved retail observer/feed.
 * No browser route accepts this object. This validates the contract, not legal
 * permission: the operator must verify the access reference before enabling it.
 */
export function normalizeApprovedObservation(input,{authorizationReference,provider,now=Date.now()}={}){
  const safeRef=v=>typeof v==='string'&&/^[\p{L}\p{N} _./:-]+$/u.test(v)&&!/(?:bearer|token|password|authorization|secret)/i.test(v);
  if(!safeRef(authorizationReference)||authorizationReference.trim().length<8||authorizationReference.length>160||!safeRef(provider)||!provider.trim()||provider.length>100)throw Error('APPROVED_SOURCE_REQUIRED');
  const p=structuredClone(input);let u;try{u=new URL(p?.url);}catch{throw Error('INVALID_RETAIL_OBSERVATION');}
  if(!validId(p?.id)||u.origin!=='https://www.wildberries.ru'||u.pathname!==`/catalog/${p.id}/detail.aspx`||u.search||u.hash||u.username||u.password||
    !['wb_page','wb_card','wb_catalog'].includes(p.priceSource)||p.currency!=='RUB'||p.context?.currency!=='RUB'||p.context?.paymentBasis!=='standard'||p.context?.authentication!=='anonymous'||p.priceCondition!=='standard'||
    !/^-?\d{1,10}$/.test(String(p.context?.destination))||!Number.isFinite(p.price)||p.price<=0||p.price>10000000||p.available!==true||!Number.isSafeInteger(p.observedAt)||p.observedAt>now||now-p.observedAt>3600000||
    !Number.isSafeInteger(p.stockObservedAt)||p.stockObservedAt>now||now-p.stockObservedAt>3600000||!Array.isArray(p.variants)||p.variants.length>100||
    typeof p.variantKey!=='string'||!/^\d{1,12}$/.test(p.variantKey)||!p.variants.some(v=>v.variantKey===p.variantKey&&v.available===true&&v.price===p.price&&v.condition==='standard'&&(v.currency??p.currency)==='RUB'&&String(v.context?.destination??p.context.destination)===String(p.context.destination)&&(!v.context||(v.context.currency==='RUB'&&v.context.paymentBasis==='standard'&&v.context.authentication==='anonymous'))))throw Error('INVALID_RETAIL_OBSERVATION');
  return {...p,source:'approved-retail',provider,accessReference:authorizationReference,priceContextConfirmed:true,retailPriceConfirmed:true,provenance:{origin:u.origin,provider,accessReference:authorizationReference,source:p.priceSource,observedAt:p.observedAt}};
}
