// Opt-in, DB-only catalogue bridge. No fetch/AI/Telegram/scheduled handler.
// Run in a reserved optional budget AFTER the existing scheduler, never on a
// user's page open or swipe. This module alone does not enable any production job.
import {fashionCategory} from '../shadow/calibration.mjs';
import {trustedTraitsForProduct} from '../shadow/taste_report.mjs';
import {stylePriceEvidence} from './subscriber_taste.mjs';
export const CATALOGUE_ADAPTER_LIMITS=Object.freeze({sourceRows:120,snapshot:120,verifiedBatch:20,catalogueCapacity:300,
  minIntervalMs:20*60000,leaseMs:120000,maxBackoffMs:6*3600000,maxImageBytes:2*1024*1024});
// Explicit additive staging migration, NOT executed on an application request.
// The active set is bounded independently of historical cards retained because
// somebody saved them. Personal saved rows already have a per-user100-card cap.
export const ADAPTER_SCHEMA=`
CREATE TABLE IF NOT EXISTS feature_catalog_active(id INTEGER PRIMARY KEY,checked_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS feature_catalog_active_checked ON feature_catalog_active(checked_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS style_saved_pid ON style_saved(pid,user_id);
INSERT OR IGNORE INTO feature_catalog_active(id,checked_at) SELECT id,checked_at FROM feature_catalog ORDER BY checked_at DESC,id DESC LIMIT 300;
CREATE TRIGGER IF NOT EXISTS style_catalogue_insert AFTER INSERT ON feature_catalog BEGIN
  INSERT INTO feature_catalog_active(id,checked_at) VALUES(NEW.id,NEW.checked_at) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at;
END;
CREATE TRIGGER IF NOT EXISTS style_catalogue_update AFTER UPDATE OF data,checked_at ON feature_catalog BEGIN
  INSERT INTO feature_catalog_active(id,checked_at) VALUES(NEW.id,NEW.checked_at) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at;
END;
CREATE TRIGGER IF NOT EXISTS style_catalogue_evict AFTER DELETE ON feature_catalog_active BEGIN
  DELETE FROM feature_catalog WHERE id=OLD.id AND NOT EXISTS(SELECT 1 FROM style_saved WHERE pid=OLD.id LIMIT 1);
END;
CREATE TRIGGER IF NOT EXISTS style_catalogue_forget_saved AFTER DELETE ON style_saved WHEN NOT EXISTS(SELECT 1 FROM feature_catalog_active WHERE id=OLD.pid) BEGIN
  DELETE FROM feature_catalog WHERE id=OLD.pid AND NOT EXISTS(SELECT 1 FROM style_saved WHERE pid=OLD.pid LIMIT 1);
END;
`;
const STATE='style_catalogue_adapter_state',SNAPSHOT='shared_catalog_snapshot';
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const rows=async statement=>(await statement.all()).results;
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
const time=value=>typeof value==='string'?Date.parse(value):typeof value==='number'&&value>0?(value<1e11?value*1000:value):NaN;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fresh=(value,now)=>Number.isFinite(time(value))&&time(value)<=now&&now-time(value)<=86400000;
const sourceCodes=new Set(['wb_card','wb_search','wb_catalog','wb_page']);
const categorySources=new Set([...sourceCodes,'wb_cdn_metadata']);
const hashPattern=/^[a-f0-9]{64}$/i;
function wbImage(value,id){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&
    /^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname)&&new RegExp('/'+id+'/images/[^/]+/[1-9][0-9]*\\.(?:webp|png|jpe?g)$','i').test(u.pathname)?u.href:null;
  }catch{return null;}
}
function assetPath(value,id,hash){
  return typeof value==='string'&&[ `/style-photos/${id}.webp`, `/style-photos/${id}/${hash}.webp`, `/style-images/${id}/${hash}.webp` ].includes(value)?value:null;
}
function featureReady(p){
  return plain(p)&&validId(p.id)&&fashionCategory(p).allowed&&hashPattern.test(p.imageHash??'')&&
    Number.isFinite(time(p.photoVerifiedAt))&&!!wbImage(p.image,p.id)&&!!assetPath(p.displayImage,p.id,p.imageHash.toLowerCase());
}
function safeVisual(p,visual){
  if(visual?.nmId!==p.id)return null;
  const accepted=trustedTraitsForProduct(p,{[p.id]:visual}),expected={clothing:'apparel',shoes:'shoes',bags:'bag',accessories:'accessory'}[fashionCategory(p).group];
  return accepted?.group===expected?accepted:null;
}
const gate='EXISTS(SELECT 1 FROM feature_meta WHERE key=? AND json_extract(value,\'$.owner\')=? AND json_extract(value,\'$.leaseUntil\')>?)';
async function acquire(db,now,mode){
  const owner=crypto.randomUUID(),initial={version:1,mode,owner,leaseUntil:now+CATALOGUE_ADAPTER_LIMITS.leaseMs,nextAttemptAt:0,nextRefreshAt:0,nextIngestAt:0,failuresByKind:{refresh:0,ingest:0},lastSuccessAt:null};
  const duePath=mode==='ingest'?'$.nextIngestAt':'$.nextRefreshAt';
  const result=await q(db,`INSERT INTO feature_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=json_set(feature_meta.value,'$.owner',?,'$.leaseUntil',?,'$.mode',?) WHERE coalesce(json_extract(feature_meta.value,'$.leaseUntil'),0)<=? AND coalesce(json_extract(feature_meta.value,?),0)<=?`,STATE,JSON.stringify(initial),owner,initial.leaseUntil,mode,now,duePath,now).run();
  if(!result.meta.changes)return null;
  const row=await q(db,'SELECT value FROM feature_meta WHERE key=?',STATE).first();return {...JSON.parse(row.value),owner};
}
const guarded=(db,state,now,sql,...args)=>q(db,sql,...args,STATE,state.owner,state.clock?.()??now);
function nextState(state,now,error){
  const failures=error?Math.min(8,(state.failuresByKind?.[state.mode]??0)+1):0;
  const delay=error?Math.min(CATALOGUE_ADAPTER_LIMITS.maxBackoffMs,CATALOGUE_ADAPTER_LIMITS.minIntervalMs*2**(failures-1)):CATALOGUE_ADAPTER_LIMITS.minIntervalMs;
  return {...state,owner:'',leaseUntil:0,failuresByKind:{refresh:state.failuresByKind?.refresh??0,ingest:state.failuresByKind?.ingest??0,[state.mode]:failures},
    [state.mode==='ingest'?'nextIngestAt':'nextRefreshAt']:now+delay,nextAttemptAt:now+delay,lastSuccessAt:error?state.lastSuccessAt:now,lastError:error??null};
}
async function snapshotRows(db){
  const row=await q(db,'SELECT value FROM feature_meta WHERE key=?',SNAPSHOT).first();
  if(!row)return [];
  const result=JSON.parse(row.value);if(!Array.isArray(result.products)||result.products.length>CATALOGUE_ADAPTER_LIMITS.snapshot)throw Error('STYLE_SNAPSHOT_INVALID');
  return result.products;
}
function evidenceCounts(catalog,now){
  return {photoCards:catalog.filter(row=>featureReady(row.product)).length,
    freshPriceCards:catalog.filter(row=>featureReady(row.product)&&stylePriceEvidence(row.product,now).confirmed).length};
}
async function commit(db,state,now,entries,result){
  const operations=entries.map(({product:p,visual})=>guarded(db,state,now,
    `INSERT INTO feature_catalog(id,data,visual,checked_at) SELECT ?,?,?,? WHERE ${gate} ON CONFLICT(id) DO UPDATE SET data=excluded.data,visual=excluded.visual,checked_at=excluded.checked_at WHERE excluded.checked_at>=feature_catalog.checked_at`,
    p.id,JSON.stringify(p),JSON.stringify(visual),now));
  if(entries.length)operations.push(guarded(db,state,now,
    `DELETE FROM feature_catalog_active WHERE id IN (SELECT id FROM feature_catalog_active ORDER BY checked_at DESC,id DESC LIMIT 20 OFFSET 300) AND ${gate}`));
  if(entries.length)operations.push(guarded(db,state,now,
    `INSERT INTO feature_meta(key,value) SELECT ?,(SELECT json_object('products',json_group_array(json_object('product',json(data),'visual',json(visual)))) FROM (SELECT c.data,c.visual FROM feature_catalog_active a JOIN feature_catalog c ON c.id=a.id ORDER BY a.checked_at DESC,a.id DESC LIMIT 120)) WHERE ${gate} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,SNAPSHOT));
  const finished=nextState(state,now,null);
  operations.push(guarded(db,state,now,`UPDATE feature_meta SET value=? WHERE key=? AND ${gate}`,JSON.stringify(finished),STATE));
  const receipts=await db.batch(operations);if(!receipts.at(-1).meta.changes)return {status:'stale_lease',added:0,updated:0};
  const current=await snapshotRows(db);
  return {...result,status:'ok',...evidenceCounts(current,now),snapshotSize:current.length,keptExistingSnapshot:entries.length===0,nextAttemptAt:finished.nextAttemptAt,sourceCalls:0,aiCalls:0,publication:'NONE'};
}
async function run(db,options,mode,operation){
  if(options.enabled!==true)return {status:'disabled',sourceCalls:0,aiCalls:0,publication:'NONE'};
  const now=options.now??Date.now();if(!Number.isSafeInteger(now)||now<=0)throw Error('STYLE_ADAPTER_INVALID_TIME');
  const state=await acquire(db,now,mode);if(!state)return {status:'not_due_or_busy',sourceCalls:0,aiCalls:0,publication:'NONE'};
  const started=Date.now();state.clock=options.clock??(()=>now+Math.max(0,Date.now()-started));
  try{return await operation(state,now);}
  catch{
    const failed=nextState(state,now,'catalogue_refresh_failed');
    await guarded(db,state,now,`UPDATE feature_meta SET value=? WHERE key=? AND ${gate}`,JSON.stringify(failed),STATE).run();
    return {status:'error',error:'catalogue_refresh_failed',nextAttemptAt:failed.nextAttemptAt,keptExistingSnapshot:true,sourceCalls:0,aiCalls:0,publication:'NONE'};
  }
}
/** Existing normalize() output is NOT price/stock/category/visual evidence.
 * Same-photo verified cards may receive a new factual title; new IDs are queued
 * as awaiting verification in the RESULT, not silently admitted to the feed.
 * The result is bounded; it is not a new unbounded persistent ingestion queue.
 */
export async function refreshCatalogueFromPublic(db,options={}){
  return run(db,options,'refresh',async(state,now)=>{
    // Existing products_checked index orders checked_at DESC,rowid ASC: explicit
    // id ASC preserves a bounded index walk without a tie-group temp sort.
    const native=await rows(q(db,'SELECT id,data,overrides,checked_at FROM products ORDER BY checked_at DESC,id ASC LIMIT 120'));
    const ids=JSON.stringify(native.map(row=>row.id));
    const verified=await rows(q(db,'SELECT id,data,visual FROM feature_catalog WHERE id IN (SELECT value FROM json_each(?))',ids));
    const byId=new Map(verified.map(row=>[row.id,row])),entries=[],waiting=[],rejected={};
    for(const row of native){
      let current,overrides;try{current=JSON.parse(row.data);overrides=JSON.parse(row.overrides??'{}');}catch{rejected.invalid_public_card=(rejected.invalid_public_card??0)+1;continue;}
      const prior=byId.get(row.id);if(!prior){waiting.push(row.id);continue;}
      let old,visual;try{old=JSON.parse(prior.data);visual=JSON.parse(prior.visual);}catch{rejected.invalid_verified_card=(rejected.invalid_verified_card??0)+1;continue;}
      if(!featureReady(old)||old.id!==row.id||Number(current.id)!==row.id||wbImage(current.image,row.id)!==wbImage(old.image,row.id)){
        rejected.photo_not_verified_or_changed=(rejected.photo_not_verified_or_changed??0)+1;continue;
      }
      // checked_at is synchronization bookkeeping only, NEVER observedAt or
      // stockObservedAt. Preserve existing provenance and reviewed photo traits.
      const title=typeof current.title==='string'?current.title.trim():'';
      const enabled=typeof overrides.enabled==='boolean'?overrides.enabled:typeof current.enabled==='boolean'?current.enabled:old.enabled;
      const product={...old,...(title&&title.length<=200?{name:title}:{}),...(typeof enabled==='boolean'?{enabled}:{})};
      // Re-sync timestamps alone must not rewrite20 cards on every cycle.
      if(product.name!==old.name||product.enabled!==old.enabled)entries.push({product,visual:safeVisual(product,visual)});
    }
    // At most20 writes per execution, below Free request query limits. A real
    // new-item verification queue belongs to the independent source pipeline.
    const batch=entries.slice(0,CATALOGUE_ADAPTER_LIMITS.verifiedBatch);
    return commit(db,state,now,batch,{sourceFound:native.length,knownVerified:verified.length,added:0,updated:batch.length,
      awaitingVerification:waiting.length,newCandidateIds:waiting.slice(0,20),rejected});
  });
}
async function verifyEntry(entry,now){
  if(!plain(entry)||!plain(entry.product)||!plain(entry.evidence)||!plain(entry.photo))return {error:'verification_envelope_missing'};
  const p=entry.product,e=entry.evidence,photo=entry.photo;
  if(!validId(p.id)||e.sourceProductId!==p.id||!categorySources.has(e.categorySource)||!fashionCategory(p).allowed||!fresh(e.categoryObservedAt,now))return {error:'source_or_category_not_verified'};
  const priceConfirmed=sourceCodes.has(e.priceSource)&&sourceCodes.has(e.stockSource)&&p.priceSource===e.priceSource&&
    fresh(e.priceObservedAt,now)&&time(e.priceObservedAt)===time(p.observedAt)&&fresh(e.stockObservedAt,now)&&time(e.stockObservedAt)===time(p.stockObservedAt)&&stylePriceEvidence(p,now).confirmed;
  const bytes=photo.bytes;if(!(bytes instanceof Uint8Array)||bytes.byteLength<12||bytes.byteLength>CATALOGUE_ADAPTER_LIMITS.maxImageBytes||!fresh(photo.observedAt,now)||!wbImage(photo.sourceUrl,p.id))return {error:'photo_bytes_or_source_not_verified'};
  if(String.fromCharCode(...bytes.subarray(0,4))!=='RIFF'||String.fromCharCode(...bytes.subarray(8,12))!=='WEBP')return {error:'photo_not_webp'};
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.byteLength<20||view.getUint32(4,true)+8!==bytes.byteLength||!['VP8 ','VP8L','VP8X'].includes(String.fromCharCode(...bytes.subarray(12,16)))||view.getUint32(16,true)>bytes.byteLength-20)return {error:'photo_container_invalid'};
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const product={...p,image:wbImage(photo.sourceUrl,p.id),imageHash:hash,displayImage:`/style-images/${p.id}/${hash}.webp`,photoVerifiedAt:time(photo.observedAt)};
  const audienceVerified=p.audienceVerified===true&&categorySources.has(e.audienceSource)&&fresh(e.audienceObservedAt,now)&&['women','men','neutral'].includes(p.audience);
  product.audience=audienceVerified?p.audience:'unknown';product.audienceVerified=audienceVerified;
  product.qualityVerified=p.qualityVerified===true&&sourceCodes.has(e.qualitySource)&&fresh(e.qualityObservedAt,now)&&time(e.qualityObservedAt)===time(p.qualityObservedAt);
  if(!priceConfirmed)Object.assign(product,{price:null,oldPrice:null,available:null,priceSource:'unknown',observedAt:null,stockObservedAt:null,context:null,variantKey:null,history:[]});
  return {product,visual:entry.visual};
}
/** SERVER/OPERATOR boundary only: not an HTTP route, never accept browser-supplied
 * provenance, image bytes or reviewed flags. Caller verifies metadata + actual
 * image bytes from WB. Main composition serves the controlled content-addressed
 * photo URL and rechecks the hash on cache miss; no per-photo asset deployment.
 */
export async function ingestVerifiedProducts(db,entries,options={}){
  if(!Array.isArray(entries)||entries.length>CATALOGUE_ADAPTER_LIMITS.verifiedBatch)throw Error('STYLE_ADAPTER_BATCH_LIMIT');
  return run(db,options,'ingest',async(state,now)=>{
    const existing=await rows(q(db,'SELECT id,data,visual FROM feature_catalog WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(entries.map(entry=>entry?.product?.id).filter(validId)))),
      byId=new Map(existing.map(row=>[row.id,row])),accepted=[],rejected={};let added=0,updated=0;
    const ids=new Set();
    for(const entry of entries){
      const checked=await verifyEntry(entry,now);let reason=checked.error;
      if(!reason&&ids.has(checked.product.id))reason='duplicate_nmid';
      if(reason){rejected[reason]=(rejected[reason]??0)+1;continue;}
      const p=checked.product,previous=byId.get(p.id);let visual=safeVisual(p,checked.visual);
      if(!visual&&previous){try{visual=safeVisual(p,JSON.parse(previous.visual));}catch{}}
      accepted.push({product:p,visual});ids.add(p.id);if(previous)updated++;else added++;
    }
    return commit(db,state,now,accepted,{sourceFound:entries.length,added,updated,rejected,
      photoDelivery:'CONTENT_ADDRESSED_SAME_ORIGIN_PROXY_REQUIRED',retentionCapacity:CATALOGUE_ADAPTER_LIMITS.catalogueCapacity});
  });
}
