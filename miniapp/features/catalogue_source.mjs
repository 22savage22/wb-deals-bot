// Server-only verifier for IDs ALREADY found by the existing WB search.
// No endpoint hopping, browser automation, cookies, AI or publication logic.
import {fashionCategory} from '../shadow/calibration.mjs';
export const CATALOGUE_SOURCE_LIMITS=Object.freeze({inputIds:20,candidates:3,requests:6,metadataBytes:128*1024,imageBytes:2*1024*1024,
  timeoutMs:8000,minIntervalMs:20*60000,leaseMs:120000,maxBackoffMs:6*3600000});
const KEY='style_catalogue_source_state',q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const idValid=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
function trustedImage(image,id){
  const u=new URL(image);
  if(!idValid(id)||u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname)||
    !new RegExp('^/vol[0-9]+/part[0-9]+/'+id+'/images/[^/]+/[1-9][0-9]*\\.webp$','i').test(u.pathname))throw Error('UNTRUSTED_CARD_IMAGE');
  return u;
}
export function metadataURL(image,id){
  const u=trustedImage(image,id);u.pathname=u.pathname.replace(/\/images\/[^/]+\/[^/]+$/,'/info/ru/card.json');return u.href;
}
export function cardAudience(card,id){
  if(Number(card?.nm_id)!==id||!Array.isArray(card.options))return null;
  const fields=card.options.filter(row=>row?.name==='Пол');if(fields.some(row=>typeof row.value!=='string'))return null;
  const values=fields.flatMap(row=>row.value.toLocaleLowerCase('ru').split(/[,;/]+/).map(value=>value.trim()).filter(Boolean));
  if(!values.length||values.some(value=>!['женский','мужской','унисекс'].includes(value)))return null;
  if(values.includes('унисекс')||values.includes('женский')&&values.includes('мужской'))return 'neutral';
  return values.every(value=>value==='женский')?'women':values.every(value=>value==='мужской')?'men':null;
}
async function boundedBytes(response,limit){
  const size=Number(response.headers.get('content-length'));
  if(Number.isFinite(size)&&size>limit){await response.body?.cancel();throw Error('BODY_LIMIT');}
  const reader=response.body?.getReader();if(!reader)throw Error('EMPTY_BODY');
  const chunks=[];let total=0;
  while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){await reader.cancel();throw Error('BODY_LIMIT');}chunks.push(value);}
  const bytes=new Uint8Array(total);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}return bytes;
}
function validWebP(bytes){
  if(bytes.byteLength<20||String.fromCharCode(...bytes.subarray(0,4))!=='RIFF'||String.fromCharCode(...bytes.subarray(8,12))!=='WEBP')return false;
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  return data.getUint32(4,true)+8===bytes.byteLength&&['VP8 ','VP8L','VP8X'].includes(String.fromCharCode(...bytes.subarray(12,16)))&&data.getUint32(16,true)<=bytes.byteLength-20;
}
async function lease(db,now){
  const owner=crypto.randomUUID(),value={version:1,owner,leaseUntil:now+CATALOGUE_SOURCE_LIMITS.leaseMs,nextAttemptAt:0,failures:0,rejected:[]};
  const held=await q(db,`INSERT INTO feature_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=json_set(feature_meta.value,'$.owner',?,'$.leaseUntil',?) WHERE coalesce(json_extract(feature_meta.value,'$.leaseUntil'),0)<=? AND coalesce(json_extract(feature_meta.value,'$.nextAttemptAt'),0)<=?`,KEY,JSON.stringify(value),owner,value.leaseUntil,now,now).run();
  if(!held.meta.changes)return null;return {...JSON.parse((await q(db,'SELECT value FROM feature_meta WHERE key=?',KEY).first()).value),owner};
}
function retryAfter(value,now){
  if(!value)return 0;const seconds=Number(value),at=Number.isFinite(seconds)?now+Math.max(0,seconds)*1000:Date.parse(value);
  return Number.isFinite(at)?Math.max(0,Math.min(CATALOGUE_SOURCE_LIMITS.maxBackoffMs,at-now)):0;
}
/** Returns INTERNAL entries containing binary photo bytes for ingestVerifiedProducts.
 * Strip entries/photo.bytes before exposing an operator receipt or writing logs.
 * DefaultOFF; callers must reserve optional D1/network budget first. Never mount
 * this function directly on a subscriber HTTP action.
 */
export async function collectNewCatalogueProducts(db,candidateIds,{enabled=false,fetcher=fetch,now=Date.now(),random=Math.random}={}){
  if(!Array.isArray(candidateIds)||candidateIds.length>CATALOGUE_SOURCE_LIMITS.inputIds||candidateIds.some(id=>!idValid(id)))throw Error('STYLE_SOURCE_CANDIDATE_LIMIT');
  if(!enabled)return {status:'disabled',entries:[],sourceCalls:0,aiCalls:0,publication:'NONE'};
  if(!Number.isSafeInteger(now)||now<=0)throw Error('STYLE_SOURCE_TIME');
  const held=await lease(db,now);if(!held)return {status:'not_due_or_busy',entries:[],sourceCalls:0,aiCalls:0,publication:'NONE'};
  const started=Date.now(),clock=()=>now+Math.max(0,Date.now()-started);
  const entries=[],errors=[];let sourceCalls=0,attempted=0,blocked=null,retryDelay=0,sourceFound=0,failed=false;
  const rejected=(held.rejected??[]).filter(row=>idValid(row.id)&&row.until>now).slice(-60),recentRejected=new Set(rejected.map(row=>row.id));
  const reject=id=>{if(!recentRejected.has(id)){rejected.push({id,until:now+86400000});recentRejected.add(id);}};
  try{
    const ids=[...new Set(candidateIds)].filter(id=>!recentRejected.has(id));
    const result=await q(db,`SELECT p.id,p.data,p.overrides FROM products p WHERE p.id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM feature_catalog c WHERE c.id=p.id) ORDER BY p.checked_at DESC,p.id ASC LIMIT 20`,JSON.stringify(ids)).all();
    const candidates=result.results;sourceFound=candidates.length;
    for(const row of candidates){
      if(attempted>=CATALOGUE_SOURCE_LIMITS.candidates||sourceCalls>=CATALOGUE_SOURCE_LIMITS.requests)break;
      let raw,url;
      try{raw=JSON.parse(row.data);const overrides=JSON.parse(row.overrides??'{}');if(raw.id!==row.id||raw.enabled===false||overrides.enabled===false){reject(row.id);continue;}url=metadataURL(raw.image,row.id);}catch{errors.push({id:row.id,code:'UNTRUSTED_SOURCE_CARD'});reject(row.id);continue;}
      attempted++;
      try{
        // Workerd rejects redirect:'error' at Request construction. Manual
        // never follows a Location; the non-2xx branch rejects all redirects.
        sourceCalls++;const metadata=await fetcher(url,{method:'GET',headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(CATALOGUE_SOURCE_LIMITS.timeoutMs)});
        if(!metadata.ok){await metadata.body?.cancel();errors.push({id:row.id,status:metadata.status});if([403,429].includes(metadata.status)){blocked=metadata.status;retryDelay=retryAfter(metadata.headers.get('retry-after'),now);break;}if([404,410].includes(metadata.status)){reject(row.id);continue;}failed=true;continue;}
        const card=JSON.parse(new TextDecoder().decode(await boundedBytes(metadata,CATALOGUE_SOURCE_LIMITS.metadataBytes)));
        if(Number(card?.nm_id)!==row.id||typeof card.imt_name!=='string'||!card.imt_name.trim()||typeof card.subj_name!=='string'){
          errors.push({id:row.id,code:'METADATA_ID_OR_FIELDS'});reject(row.id);continue;
        }
        const audience=cardAudience(card,row.id),product={id:row.id,name:card.imt_name.trim().slice(0,200),category:card.subj_name.trim().slice(0,100),type:card.subj_name.trim().slice(0,100),categoryVerified:true,
          image:raw.image,audience:audience??'unknown',audienceVerified:audience!==null,price:null,available:null,observedAt:null,stockObservedAt:null,priceSource:'unknown',
          brand:typeof card.selling?.brand_name==='string'?card.selling.brand_name.trim().slice(0,80):null,brandVerified:typeof card.selling?.brand_name==='string',
          rating:Number.isFinite(raw.rating)&&raw.rating>0&&raw.rating<=5?raw.rating:null,reviews:Number.isSafeInteger(raw.reviews)&&raw.reviews>=0?raw.reviews:null,qualityVerified:false};
        if(!fashionCategory(product).allowed){errors.push({id:row.id,code:'OUTSIDE_CONFIRMED_FASHION'});reject(row.id);continue;}
        sourceCalls++;const photo=await fetcher(trustedImage(raw.image,row.id).href,{method:'GET',headers:{Accept:'image/webp'},redirect:'manual',signal:AbortSignal.timeout(CATALOGUE_SOURCE_LIMITS.timeoutMs)});
        if(!photo.ok){await photo.body?.cancel();errors.push({id:row.id,status:photo.status});if([403,429].includes(photo.status)){blocked=photo.status;retryDelay=retryAfter(photo.headers.get('retry-after'),now);break;}if([404,410].includes(photo.status)){reject(row.id);continue;}failed=true;continue;}
        if(!/^image\/webp(?:;|$)/i.test(photo.headers.get('content-type')??'')){await photo.body?.cancel();errors.push({id:row.id,code:'PHOTO_CONTENT_TYPE'});reject(row.id);continue;}
        const bytes=await boundedBytes(photo,CATALOGUE_SOURCE_LIMITS.imageBytes);if(!validWebP(bytes)){errors.push({id:row.id,code:'PHOTO_CONTAINER_INVALID'});reject(row.id);continue;}
        entries.push({product,evidence:{sourceProductId:row.id,categorySource:'wb_cdn_metadata',categoryObservedAt:now,
          ...(audience?{audienceSource:'wb_cdn_metadata',audienceObservedAt:now}:{})},photo:{bytes,sourceUrl:raw.image,observedAt:now}});
      }catch{failed=true;errors.push({id:row.id,code:'REQUEST_OR_RESPONSE_FAILED'});}
    }
  }catch{failed=true;errors.push({code:'SOURCE_DB_FAILED'});}
  const failures=blocked||failed?Math.min(8,(held.failures??0)+1):0;
  const randomValue=Number(random()),jitter=Number.isFinite(randomValue)?Math.max(0,Math.min(1,randomValue)):0;
  const delay=failures?Math.min(CATALOGUE_SOURCE_LIMITS.maxBackoffMs,Math.max(CATALOGUE_SOURCE_LIMITS.minIntervalMs,retryDelay,CATALOGUE_SOURCE_LIMITS.minIntervalMs*2**(failures-1)*(1+jitter*.5))):CATALOGUE_SOURCE_LIMITS.minIntervalMs;
  const status=blocked?'rate_limited':failed?entries.length?'partial':'error':'ok',state={version:1,owner:'',leaseUntil:0,nextAttemptAt:now+delay,failures,
    rejected:rejected.slice(-60),lastError:blocked?`http_${blocked}`:failed?'source_request_failed':null,lastVerified:entries.length,lastAttemptAt:now};
  const receipt=await q(db,`UPDATE feature_meta SET value=? WHERE key=? AND json_extract(value,'$.owner')=? AND json_extract(value,'$.leaseUntil')>?`,JSON.stringify(state),KEY,held.owner,clock()).run();
  if(!receipt.meta.changes)return {status:'stale_lease',entries:[],sourceCalls,aiCalls:0,publication:'NONE'};
  return {status,entries,sourceFound,attempted,verified:entries.length,sourceCalls,errors,nextAttemptAt:state.nextAttemptAt,blocked,aiCalls:0,priceEvidence:'NONE',publication:'NONE'};
}
