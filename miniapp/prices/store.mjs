// Server/operator-only isolated storage. No fetch, scheduler, Telegram or AI.
// init() is the ONLY schema writer. Never expose provenance/ingest/resetSource as
// a subscriber route. approvedDatabaseId must be an operator-reviewed constant.
import {planPriceObservation,priceContextKey} from '../shadow/value.mjs';

export const PRICE_LIMITS=Object.freeze({watch:100,batch:20,historyRows:9000,historyPoints:28,retentionDays:90,
  maxAgeMs:3600000,requestsDay:40,minGapMs:1200000,leaseMs:120000,pruneBatch:200});
const FORBIDDEN_DATABASES=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20']);
const MAX_EPOCH=8640000000000000,DAY=86400000;
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const timestamp=value=>typeof value==='string'?Date.parse(value):typeof value==='number'&&Number.isFinite(value)&&value>0?(value<1e11?value*1000:value):NaN;
const time=value=>{if(!Number.isSafeInteger(value)||value<=0||value>MAX_EPOCH)throw Error('PRICE_INVALID_TIME');return value;};
const sourceKey=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/.test(value))throw Error('PRICE_INVALID_SOURCE');return value;};
const text=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max):undefined;
const numeric=(value,min=0,max=1e7)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?value:undefined;
const sourceCodes=new Set(['wb_card','wb_search','wb_catalog','wb_page']);
const limited=(value,max)=>Number.isSafeInteger(value)&&value>=1&&value<=max;
const parse=value=>value?JSON.parse(value):null;
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const changes=result=>Number(result?.meta?.changes??0);
// D1 meta.changes includes trigger mutations. RETURNING counts only the actual
// logical observations/deletions; local run-only adapters expose direct SQLite
// changes() and omit the returned result rows.
const logicalChanges=result=>Array.isArray(result?.results)?result.results.length:changes(result);

function photo(value,id){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&
    /^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname)&&new RegExp('/'+id+'/images/[^/]+/[1-9][0-9]*\\.(?:webp|png|jpe?g)$','i').test(u.pathname)?u.href:undefined;}catch{return undefined;}
}
function reference(value,max){const v=text(value,max);return v&&/^[\p{L}\p{N} _./:-]+$/u.test(v)&&!/(?:bearer|token|password|authorization|secret)/i.test(v)?v:undefined;}
function provenance(input){
  if(!plain(input))return undefined;const out={};
  for(const key of ['provider','accessReference','authorizationReference']){const v=reference(input[key],160);if(v)out[key]=v;}
  // Retain only a public origin, never request URLs, querystrings, credentials,
  // headers, cookies, bodies or arbitrary adapter error text.
  if(input.origin==='operator_approved_retail_observer')out.origin=input.origin;
  else if(typeof input.origin==='string')try{const u=new URL(input.origin);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash)out.origin=u.origin;}catch{}
  if(sourceCodes.has(input.source))out.source=input.source;
  const at=timestamp(input.observedAt);if(Number.isFinite(at)&&at>0&&at<=MAX_EPOCH)out.observedAt=at;
  return Object.keys(out).length?out:undefined;
}
function consistentVariantContext(product){
  if(!Array.isArray(product.variants))return true;
  if(product.variants.length>100)return false;
  const expected=priceContextKey(product.context),authentication=product.context?.authentication;
  for(const variant of product.variants.slice(0,100)){
    if(!plain(variant))return false;
    if(Object.hasOwn(variant,'currency')&&variant.currency!==product.currency)return false;
    for(const key of ['destination','paymentBasis','authentication'])if(Object.hasOwn(variant,key)&&
      (key==='destination'?String(variant[key])!==String(product.context?.destination):variant[key]!==product.context?.[key]))return false;
    // A supplied context must be complete and equal, including authentication.
    // Missing context may use the trusted product envelope; a conflicting or
    // partly supplied context can never be scrubbed away into a confirmation.
    if(Object.hasOwn(variant,'context')&&(!plain(variant.context)||!expected||priceContextKey(variant.context)!==expected||variant.context.authentication!==authentication))return false;
  }
  return true;
}
function metadata(product){
  const out={id:product.id,url:`https://www.wildberries.ru/catalog/${product.id}/detail.aspx`};
  for(const key of ['name','title','category','type','brand','query','category_root']){const v=text(product[key],key==='name'||key==='title'?200:100);if(v)out[key]=v;}
  const image=photo(product.image,product.id);if(image)out.image=image;
  for(const [key,max] of [['rating',5],['reviews',1e8],['feedbacks',1e8]]){const v=numeric(product[key],0,max);if(v!==undefined&&(key==='rating'||Number.isSafeInteger(v)))out[key]=v;}
  for(const key of ['categoryVerified','brandVerified','qualityVerified','audienceVerified','familyVerified'])if(typeof product[key]==='boolean')out[key]=product[key];
  for(const key of ['audience','imageHash','displayImage','familyId']){const v=text(product[key],200);if(v)out[key]=v;}
  for(const key of ['photoVerifiedAt','qualityObservedAt','categoryObservedAt','audienceObservedAt','category_checked_at']){const v=timestamp(product[key]);if(Number.isFinite(v)&&v>0&&v<=MAX_EPOCH)out[key]=v;}
  for(const key of ['category_source','categorySource','audienceSource','qualitySource','stockSource']){
    const v=product[key];if(typeof v==='string'&&/^(?:wb_card|wb_search|wb_catalog|wb_page|wb_cdn_metadata|wb-cdn)$/.test(v))out[key]=v;
  }
  for(const key of ['provider','accessReference']){const v=reference(product[key],160);if(v)out[key]=v;}
  const origin=provenance(product.provenance);if(origin)out.provenance=origin;
  return out;
}
function normalized(product){
  const out=metadata(product);
  for(const key of ['price','oldPrice'])out[key]=numeric(product[key],0.000001)??null;
  out.currency=product.currency==='RUB'?'RUB':text(product.currency,10)??null;
  out.priceSource=sourceCodes.has(product.priceSource)?product.priceSource:'unknown';
  out.observedAt=Number.isFinite(timestamp(product.observedAt))?timestamp(product.observedAt):null;
  out.stockObservedAt=Number.isFinite(timestamp(product.stockObservedAt))?timestamp(product.stockObservedAt):null;
  out.available=typeof product.available==='boolean'?product.available:null;
  // Truncating a SKU would manufacture a different identity/history key.
  out.variantKey=typeof product.variantKey==='string'&&product.variantKey.trim().length<=100?product.variantKey.trim():null;
  const key=priceContextKey(product.context);out.context=key?{...JSON.parse(key),...(product.context?.authentication==='anonymous'?{authentication:'anonymous'}:{})}:null;
  out.priceContextConfirmed=product.priceContextConfirmed===true;
  out.variantContextConsistent=consistentVariantContext(product);
  out.priceCondition=product.priceCondition==null?null:text(product.priceCondition,80)??'unknown';
  if(typeof product.priceCondition!=='string'&&product.priceCondition!=null)out.priceCondition='unknown';
  for(const key of ['priceBasis']){const v=text(product[key],60);if(v)out[key]=v;}
  if(Number.isSafeInteger(product.packCount)&&product.packCount>0&&product.packCount<=1000)out.packCount=product.packCount;
  if(product.qualityRisk===true)out.qualityRisk=true;
  if(Array.isArray(product.qualityWarnings))out.qualityWarnings=product.qualityWarnings.slice(0,10).map(v=>text(v,100)).filter(Boolean);
  out.sellerDiscountIsEvidence=false;
  if(Array.isArray(product.variants))out.variants=product.variants.slice(0,100).filter(plain).map(row=>({
    variantKey:text(row.variantKey??row.key??row.size,100)??'unknown',size:text(row.size,60)??'unknown',
    price:numeric(row.price,0.000001)??null,available:typeof row.available==='boolean'?row.available:null,
    condition:row.condition==null?null:typeof row.condition==='string'?text(row.condition,80):'unknown',
    ...(Object.hasOwn(row,'currency')?{currency:row.currency==='RUB'?'RUB':'unknown'}:{}),
    ...(Object.hasOwn(row,'context')?{context:priceContextKey(row.context)?{...JSON.parse(priceContextKey(row.context)),authentication:row.context?.authentication==='anonymous'?'anonymous':'unknown'}:null}:{})}));
  return out;
}
function proof(product,now){
  if(product.priceContextConfirmed!==true)return {confirmed:false,reason:'CONTEXT_UNCONFIRMED'};
  if(product.variantContextConsistent===false)return {confirmed:false,reason:'VARIANT_CONTEXT_MISMATCH'};
  if(product.context?.authentication!=='anonymous')return {confirmed:false,reason:'ANONYMOUS_CONTEXT_UNCONFIRMED'};
  if(product.context?.paymentBasis!=='standard')return {confirmed:false,reason:'STANDARD_PAYMENT_UNCONFIRMED'};
  if(product.available!==true)return {confirmed:false,reason:product.available===false?'UNAVAILABLE':'STOCK_UNCONFIRMED'};
  const stockAt=timestamp(product.stockObservedAt);
  if(!Number.isFinite(stockAt)||stockAt>now||now-stockAt>PRICE_LIMITS.maxAgeMs)return {confirmed:false,reason:'STOCK_NOT_FRESH'};
  const plan=planPriceObservation(product,{now,policy:{maxPriceAgeMs:PRICE_LIMITS.maxAgeMs}});
  return plan.due?{confirmed:true,reason:'CONFIRMED',observation:plan.observation}:{confirmed:false,reason:'PRICE_OR_VARIANT_UNCONFIRMED'};
}
const safeCurrent=(product,confirmed)=>product?{...product,...(!confirmed?{price:null,oldPrice:null,available:product.available===false?false:null,priceSource:'unknown',observedAt:null,
  stockObservedAt:null,priceContextConfirmed:false,...(product.variants?{variants:product.variants.map(v=>({...v,price:null,available:null}))}:{})}:{})}:null;
function record(row,now){
  const latest=parse(row.latest),lastGood=parse(row.last_good),at=latest?.observedAt,age=Number.isFinite(at)?now-at:null;
  const evidence=latest?proof(latest,now):{confirmed:false,reason:'NEVER_CHECKED'};
  const confirmed=row.current_valid===1&&evidence.confirmed&&row.invalidated_at<=row.checked_at;
  const reason=confirmed?'CONFIRMED':row.current_valid===1?evidence.reason:row.current_code;
  const priceStatus=confirmed?'confirmed':reason==='UNAVAILABLE'?'unavailable':reason.startsWith('SOURCE_')?'failed':
    latest&&(age<0||age>PRICE_LIMITS.maxAgeMs||reason==='STOCK_NOT_FRESH')?'stale':'unconfirmed';
  return {id:row.pid,source:row.source,metadata:parse(row.metadata),product:safeCurrent(latest,confirmed),confirmed,priceStatus,reason,
    checkedAt:row.checked_at||null,dueAt:row.due_at,
    lastGoodProduct:lastGood?{...lastGood,historical:true,priceStatus:'historical',confirmed:false}:null};
}

// This export must stay byte-for-byte equal (apart from outer whitespace) to
// schema.sql. Tests enforce parity; Workers need no filesystem import at runtime.
export const PRICE_SCHEMA=`
-- Explicit isolated price-store migration only. Never run on production DB.
CREATE TABLE IF NOT EXISTS price_watch (
  pid INTEGER PRIMARY KEY CHECK(pid>0 AND pid<1000000000000),
  source TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  tracked_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  current_valid INTEGER NOT NULL DEFAULT 0 CHECK(current_valid IN (0,1)),
  current_code TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
  latest TEXT,
  latest_observed_at INTEGER NOT NULL DEFAULT 0,
  last_good TEXT,
  last_good_observed_at INTEGER NOT NULL DEFAULT 0,
  invalidated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS price_watch_due ON price_watch(active,due_at,pid);
CREATE INDEX IF NOT EXISTS price_watch_source ON price_watch(source,pid);
CREATE TRIGGER IF NOT EXISTS price_watch_insert_cap BEFORE INSERT ON price_watch
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM price_watch WHERE pid=NEW.pid)
  AND (SELECT count(*) FROM price_watch WHERE active=1)>=100
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS price_watch_reactivate_cap BEFORE UPDATE OF active ON price_watch
WHEN OLD.active=0 AND NEW.active=1 AND (SELECT count(*) FROM price_watch WHERE active=1)>=100
BEGIN SELECT RAISE(IGNORE); END;
CREATE TABLE IF NOT EXISTS price_observations (
  pid INTEGER NOT NULL REFERENCES price_watch(pid),
  variant TEXT NOT NULL,
  context TEXT NOT NULL,
  day TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  price REAL NOT NULL CHECK(price>0),
  source TEXT NOT NULL,
  PRIMARY KEY(pid,variant,context,day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS price_observations_time ON price_observations(observed_at,pid,variant,context,day);
CREATE TABLE IF NOT EXISTS price_store_stats(id INTEGER PRIMARY KEY CHECK(id=1),history_rows INTEGER NOT NULL CHECK(history_rows BETWEEN 0 AND 9000));
INSERT OR IGNORE INTO price_store_stats(id,history_rows) SELECT 1,count(*) FROM price_observations;
CREATE TRIGGER IF NOT EXISTS price_observations_cap BEFORE INSERT ON price_observations
WHEN NOT EXISTS(SELECT 1 FROM price_observations WHERE pid=NEW.pid AND variant=NEW.variant AND context=NEW.context AND day=NEW.day)
  AND (SELECT history_rows FROM price_store_stats WHERE id=1)>=9000
BEGIN
  DELETE FROM price_observations WHERE (pid,variant,context,day) IN
    (SELECT pid,variant,context,day FROM price_observations ORDER BY observed_at,pid,variant,context,day LIMIT 1);
END;
CREATE TRIGGER IF NOT EXISTS price_observations_insert AFTER INSERT ON price_observations
BEGIN UPDATE price_store_stats SET history_rows=history_rows+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS price_observations_delete AFTER DELETE ON price_observations
BEGIN UPDATE price_store_stats SET history_rows=history_rows-1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS price_sources (
  source TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  min_gap_ms INTEGER NOT NULL DEFAULT 1200000,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_code TEXT NOT NULL DEFAULT '',
  reset_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS price_request_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 40)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS price_source_days(source TEXT NOT NULL,day TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 40),PRIMARY KEY(source,day)) WITHOUT ROWID;
`;

export function openPriceStore(env,{approvedDatabaseId}={}){
  if(env?.PRICE_ISOLATED!=='true'||!env.PRICE_DB||env.PRICE_DB===env.DB||typeof env.PRICE_DB.prepare!=='function'||typeof env.PRICE_DB.batch!=='function')throw Error('PRICE_SEPARATE_ISOLATED_DB_REQUIRED');
  if(typeof approvedDatabaseId!=='string'||!/^[a-z0-9-]{16,80}$/.test(approvedDatabaseId)||approvedDatabaseId!==env.PRICE_DATABASE_ID||FORBIDDEN_DATABASES.has(approvedDatabaseId.toLowerCase()))throw Error('PRICE_APPROVED_DATABASE_ID_REQUIRED');
  const db=env.PRICE_DB;
  return {
    async init(){
      // Split only our fixed migration at top-level CREATE/INSERT boundaries.
      // Each trigger is ONE prepared statement. D1 exec's line-oriented parsing
      // must not split a multiline CREATE TABLE or a trigger body.
      const statements=PRICE_SCHEMA.trim().split(/;\n(?=CREATE|INSERT)/).map(sql=>db.prepare(sql));
      await db.batch(statements);return {initialized:true,isolated:true,databaseId:approvedDatabaseId};
    },
    async track(products,{now=Date.now()}={}){
      time(now);if(!Array.isArray(products)||products.length>PRICE_LIMITS.watch||products.some(p=>!plain(p)||!validId(p.id))||new Set(products.map(p=>p.id)).size!==products.length)throw Error('PRICE_WATCH_BATCH_INVALID');
      if(!products.length)return {requested:0,tracked:0,rejected:[]};
      const payload=products.map(p=>({id:p.id,source:sourceKey(p.source??'wb'),metadata:metadata(p)}));
      await q(db,`INSERT INTO price_watch(pid,source,metadata,tracked_at,due_at)
        SELECT json_extract(value,'$.id'),json_extract(value,'$.source'),json_extract(value,'$.metadata'),?,? FROM json_each(?) WHERE true
        ON CONFLICT(pid) DO UPDATE SET metadata=json_patch(price_watch.metadata,excluded.metadata) WHERE price_watch.source=excluded.source`,now,now,JSON.stringify(payload)).run();
      const saved=(await q(db,'SELECT pid,source FROM price_watch WHERE pid IN (SELECT value FROM json_each(?)) AND active=1',JSON.stringify(payload.map(p=>p.id))).all()).results;
      const matched=new Set(saved.filter(row=>payload.some(p=>p.id===row.pid&&p.source===row.source)).map(row=>row.pid));
      return {requested:products.length,tracked:matched.size,rejected:payload.filter(p=>!matched.has(p.id)).map(p=>({id:p.id,reason:saved.some(row=>row.pid===p.id)?'SOURCE_CHANGE_REQUIRES_REVIEW':'WATCH_CAPACITY'}))};
    },
    async due({now=Date.now(),limit=PRICE_LIMITS.batch}={}){
      time(now);if(!limited(limit,PRICE_LIMITS.batch))throw Error('PRICE_DUE_LIMIT');
      const rows=(await q(db,`SELECT w.pid,w.source,w.metadata,w.checked_at,w.due_at FROM price_watch w INDEXED BY price_watch_due
        LEFT JOIN price_sources s ON s.source=w.source WHERE w.active=1 AND w.due_at<=? AND coalesce(s.blocked,0)=0
        AND coalesce(s.next_attempt_at,0)<=? AND coalesce(s.lease_until,0)<=? ORDER BY w.due_at,w.pid LIMIT ?`,now,now,now,limit).all()).results;
      return rows.map(row=>({...parse(row.metadata),id:row.pid,source:row.source,dueAt:row.due_at,checkedAt:row.checked_at||null}));
    },
    async acquire(source,{now=Date.now(),requestCost=1,maxRequestsDay=PRICE_LIMITS.requestsDay,minGapMs=PRICE_LIMITS.minGapMs}={}){
      sourceKey(source);time(now);
      if(!limited(requestCost,PRICE_LIMITS.requestsDay)||!limited(maxRequestsDay,PRICE_LIMITS.requestsDay)||!Number.isSafeInteger(minGapMs)||minGapMs<PRICE_LIMITS.minGapMs||minGapMs>DAY)throw Error('PRICE_SOURCE_LIMITS_INVALID');
      const day=new Date(now).toISOString().slice(0,10),owner=crypto.randomUUID(),until=now+PRICE_LIMITS.leaseMs;
      const r=await db.batch([
        q(db,'INSERT OR IGNORE INTO price_sources(source) VALUES(?)',source),
        q(db,'INSERT OR IGNORE INTO price_request_budget(day) VALUES(?)',day),
        q(db,'INSERT OR IGNORE INTO price_source_days(source,day) VALUES(?,?)',source,day),
        q(db,`UPDATE price_sources SET owner=?,lease_until=?,last_attempt_at=?,next_attempt_at=?,min_gap_ms=? WHERE source=?
          AND blocked=0 AND lease_until<=? AND next_attempt_at<=?
          AND (SELECT requests FROM price_request_budget WHERE day=?)+?<=?
          AND (SELECT requests FROM price_source_days WHERE source=? AND day=?)+?<=?`,owner,until,now,now+minGapMs,minGapMs,source,now,now,day,requestCost,maxRequestsDay,source,day,requestCost,maxRequestsDay),
        q(db,`UPDATE price_request_budget SET requests=requests+? WHERE day=? AND EXISTS(SELECT 1 FROM price_sources WHERE source=? AND owner=?)`,requestCost,day,source,owner),
        q(db,`UPDATE price_source_days SET requests=requests+? WHERE source=? AND day=? AND EXISTS(SELECT 1 FROM price_sources WHERE source=? AND owner=?)`,requestCost,source,day,source,owner)
      ]);
      const state=await q(db,`SELECT s.*,(SELECT requests FROM price_request_budget WHERE day=?) AS global_requests,
        (SELECT requests FROM price_source_days WHERE source=? AND day=?) AS source_requests FROM price_sources s WHERE source=?`,day,source,day,source).first();
      const admitted=changes(r[3])===1;
      const reason=admitted?'ADMITTED':state.blocked?'SOURCE_BLOCKED':state.lease_until>now?'LEASE_BUSY':state.next_attempt_at>now?'NOT_DUE':'DAILY_REQUEST_BUDGET';
      return {admitted,reason,source,...(admitted?{owner}:{}),leaseUntil:state.lease_until,nextAttemptAt:state.next_attempt_at,blocked:state.blocked===1,
        day,globalRequests:state.global_requests,sourceRequests:state.source_requests,maxRequestsDay};
    },
    async finish(source,owner,{now=Date.now(),status=0,retryAfterMs=0,ok=false,code}={}){
      sourceKey(source);time(now);if(typeof owner!=='string'||!/^[a-f0-9-]{36}$/i.test(owner)||typeof ok!=='boolean'||!Number.isInteger(status)||status<0||status>599||!Number.isSafeInteger(retryAfterMs)||retryAfterMs<0||retryAfterMs>MAX_EPOCH-now)throw Error('PRICE_SOURCE_OUTCOME_INVALID');
      // Raw errors and upstream bodies are intentionally never stored. Only a
      // fixed code vocabulary/status can cross this boundary.
      const state=await q(db,'SELECT * FROM price_sources WHERE source=?',source).first();
      if(!state||state.owner!==owner||state.lease_until<=now)return {finished:false,reason:'STALE_LEASE'};
      const success=ok&&status>=200&&status<300,blocked=status===401||status===403;
      const reason=success?'OK':blocked?status===401?'SOURCE_AUTH_REQUIRED':'SOURCE_FORBIDDEN':status===429?'SOURCE_RATE_LIMITED':
        code==='TIMEOUT'?'SOURCE_TIMEOUT':code==='INVALID_RESPONSE'?'SOURCE_INVALID_RESPONSE':'SOURCE_UNAVAILABLE';
      const failures=success?0:Math.min(16,state.failures+1),delay=success?0:Math.max(state.min_gap_ms,retryAfterMs,Math.min(21600000,state.min_gap_ms*2**(failures-1)));
      const next=Math.max(state.next_attempt_at,now+delay);
      const r=await db.batch([
        q(db,`UPDATE price_sources SET owner='',lease_until=0,next_attempt_at=?,blocked=?,failures=?,last_status=?,last_code=? WHERE source=? AND owner=? AND lease_until>?`,next,blocked?1:state.blocked,failures,status||null,reason,source,owner,now),
        q(db,`UPDATE price_watch SET current_valid=0,current_code=?,invalidated_at=MAX(invalidated_at,?),due_at=MAX(due_at,?)
          WHERE source=? AND ?=0 AND changes()>0`,reason,now,next,source,success?1:0)
      ]);
      return {finished:changes(r[0])===1,reason,blocked,nextAttemptAt:next,invalidated:changes(r[1])};
    },
    // Explicit operator permission only. Neither day rollover nor a successful
    // unrelated source can clear 401/403. Reset never refunds reserved budget.
    async resetSource(source,{now=Date.now(),confirmed=false}={}){
      sourceKey(source);time(now);if(confirmed!==true)throw Error('PRICE_SOURCE_RESET_CONFIRMATION_REQUIRED');
      const r=await q(db,"UPDATE price_sources SET blocked=0,reset_at=?,last_code='ACCESS_RESET_CONFIRMED' WHERE source=? AND blocked=1 AND lease_until<=?",now,source,now).run();
      return {reset:changes(r)===1,source,explicitPermission:true};
    },
    async ingest(products,{now=Date.now()}={}){
      time(now);if(!Array.isArray(products)||products.length>PRICE_LIMITS.batch||products.some(p=>!plain(p)||!validId(p.id))||new Set(products.map(p=>p.id)).size!==products.length)throw Error('PRICE_INGEST_BATCH_INVALID');
      const watched=(await q(db,`SELECT w.pid,w.source,w.checked_at,w.last_good_observed_at,w.invalidated_at,coalesce(s.blocked,0) AS source_blocked FROM price_watch w
        LEFT JOIN price_sources s ON s.source=w.source WHERE w.active=1 AND w.pid IN (SELECT value FROM json_each(?))`,JSON.stringify(products.map(p=>p.id))).all()).results;
      const byId=new Map(watched.map(row=>[row.pid,row])),patches=[],observations=[],rejected=[];
      for(const raw of products){
        const row=byId.get(raw.id);if(!row){rejected.push({id:raw.id,reason:'UNTRACKED'});continue;}
        if(row.source_blocked){rejected.push({id:raw.id,reason:'SOURCE_BLOCKED'});continue;}
        if(raw.source!==undefined&&raw.source!==row.source){rejected.push({id:raw.id,reason:'SOURCE_MISMATCH'});continue;}
        if(row.checked_at>now){rejected.push({id:raw.id,reason:'STALE_CHECK'});continue;}
        const product=normalized(raw),evidence=proof(product,now);
        if(evidence.confirmed&&product.observedAt<row.last_good_observed_at){rejected.push({id:raw.id,reason:'OLDER_THAN_LAST_GOOD'});continue;}
        if(evidence.confirmed&&product.observedAt<row.invalidated_at){rejected.push({id:raw.id,reason:'OBSERVATION_PRECEDES_FAILURE'});continue;}
        patches.push({id:raw.id,source:row.source,latest:product,observedAt:product.observedAt??0,valid:evidence.confirmed?1:0,code:evidence.reason});
        if(evidence.confirmed)observations.push({...evidence.observation,sourceId:row.source});else rejected.push({id:raw.id,reason:evidence.reason});
      }
      const payload=JSON.stringify(patches),operations=[
        q(db,`UPDATE price_watch SET latest=json_extract(p.value,'$.latest'),latest_observed_at=json_extract(p.value,'$.observedAt'),
          current_valid=json_extract(p.value,'$.valid'),current_code=json_extract(p.value,'$.code'),checked_at=?,due_at=?,
          invalidated_at=CASE WHEN json_extract(p.value,'$.valid')=1 THEN 0 ELSE ? END,
          last_good=CASE WHEN json_extract(p.value,'$.valid')=1 THEN json_extract(p.value,'$.latest') ELSE last_good END,
          last_good_observed_at=CASE WHEN json_extract(p.value,'$.valid')=1 THEN json_extract(p.value,'$.observedAt') ELSE last_good_observed_at END
          FROM json_each(?) p WHERE price_watch.pid=json_extract(p.value,'$.id') AND price_watch.source=json_extract(p.value,'$.source') AND price_watch.checked_at<=?
          AND NOT EXISTS(SELECT 1 FROM price_sources s WHERE s.source=price_watch.source AND s.blocked=1)
          AND (json_extract(p.value,'$.valid')=0 OR (price_watch.last_good_observed_at<=json_extract(p.value,'$.observedAt') AND price_watch.invalidated_at<=json_extract(p.value,'$.observedAt')))`,now,now+PRICE_LIMITS.minGapMs,now,payload,now),
        q(db,`INSERT INTO price_observations(pid,variant,context,day,observed_at,price,source)
          SELECT json_extract(p.value,'$.id'),json_extract(p.value,'$.variantKey'),json_extract(p.value,'$.context'),json_extract(p.value,'$.day'),
            json_extract(p.value,'$.observedAt'),json_extract(p.value,'$.price'),json_extract(p.value,'$.source') FROM json_each(?) p
          JOIN price_watch w ON w.pid=json_extract(p.value,'$.id') WHERE w.source=json_extract(p.value,'$.sourceId')
            AND w.current_valid=1 AND w.checked_at=? AND w.last_good_observed_at=json_extract(p.value,'$.observedAt')
          ON CONFLICT(pid,variant,context,day) DO NOTHING RETURNING pid`,JSON.stringify(observations),now),
        q(db,`DELETE FROM price_observations WHERE (pid,variant,context,day) IN
          (SELECT pid,variant,context,day FROM price_observations WHERE observed_at<? ORDER BY observed_at,pid,variant,context,day LIMIT ?) RETURNING pid`,now-PRICE_LIMITS.retentionDays*DAY,PRICE_LIMITS.pruneBatch)
      ];
      const r=await db.batch(operations);
      const current=(await q(db,'SELECT pid,latest,current_valid,checked_at FROM price_watch WHERE pid IN (SELECT value FROM json_each(?))',JSON.stringify(patches.map(p=>p.id))).all()).results;
      const applied=new Set(current.filter(row=>row.checked_at===now&&patches.some(p=>p.id===row.pid&&JSON.stringify(p.latest)===row.latest)).map(row=>row.pid));
      for(const patch of patches)if(!applied.has(patch.id))rejected.push({id:patch.id,reason:'STALE_AT_COMMIT'});
      return {requested:products.length,updated:changes(r[0]),confirmed:observations.filter(o=>applied.has(o.id)&&current.find(row=>row.pid===o.id)?.current_valid===1).length,observationsWritten:logicalChanges(r[1]),historyPruned:logicalChanges(r[2]),rejected,
        publication:'NONE',productionChanged:false};
    },
    async list({now=Date.now(),limit=PRICE_LIMITS.watch}={}){
      time(now);if(!limited(limit,PRICE_LIMITS.watch))throw Error('PRICE_LIST_LIMIT');
      const rows=(await q(db,'SELECT * FROM price_watch WHERE active=1 ORDER BY due_at,pid LIMIT ?',limit).all()).results;
      return rows.map(row=>record(row,now));
    },
    async history(product,{now=Date.now()}={}){
      time(now);if(!plain(product)||!validId(product.id))throw Error('PRICE_HISTORY_KEY_REQUIRED');
      const context=priceContextKey(product.context),variant=text(product.variantKey,100);
      if(!context||!variant||['unknown','other','неизвестно'].includes(variant.toLowerCase()))return [];
      const rows=(await q(db,`SELECT observed_at AS at,price,source,variant AS variantKey,context,day FROM price_observations
        WHERE pid=? AND variant=? AND context=? AND day>=? AND day<=? ORDER BY day DESC LIMIT 28`,product.id,variant,context,
        new Date(now-PRICE_LIMITS.retentionDays*DAY).toISOString().slice(0,10),new Date(now).toISOString().slice(0,10)).all()).results;
      return rows.filter(row=>row.at<=now&&row.at>=now-PRICE_LIMITS.retentionDays*DAY).map(row=>({...row,id:product.id,currency:'RUB',context:JSON.parse(row.context)}));
    }
  };
}
