// Collector-only passive audit. No fetch, scheduler, Telegram, AI or retail ingest.
// PRICE_PASSIVE_ENABLED must be the literal string 'true'; default capture/status
// returns disabled without touching D1. init is always an explicit operator step.
export const PASSIVE_LIMITS=Object.freeze({responses:20,offersPerResponse:20,runMs:86400000,auditDays:7,historyDays:90,historyRows:9000,auditRows:140,runRows:28,writesDay:3000,captureReserve:240,startReserve:240,stopReserve:20,historyPrune:10,historyRead:28});
const DAY=86400000,HOUR=3600000,FORBIDDEN=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','43861c0c-aa50-4e5e-9014-7b36bd319e5b']);
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const time=v=>{if(!Number.isSafeInteger(v)||v<=0||v>8640000000000000)throw Error('PASSIVE_TIME_INVALID');return v;};
const ident=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,99}$/.test(v)&&!/(?:bearer|password|authorization|secret|token)/i.test(v);
const id=v=>Number.isSafeInteger(v)&&v>0&&v<1e12;
const fresh=(v,at)=>Number.isSafeInteger(v)&&v>0&&v<=at&&at-v<=HOUR;
const size=v=>typeof v==='string'&&v.length<=40&&/^[\p{L}\p{N} .,/()×:+_-]{1,40}$/u.test(v)&&!/(?:bearer|password|authorization|secret|token)/i.test(v)?v.trim():null;
const q=(db,sql,...args)=>db.prepare(sql).bind(...args),parse=v=>JSON.parse(v),day=at=>new Date(at).toISOString().slice(0,10);
const noCapture=reason=>({captured:false,reason,retailConfirmed:0,publication:'NONE',aiCalls:0});
function requestedContext(value){
  if(!plain(value)||value.currency!=='RUB'||value.paymentBasis!=='unknown'||!/^[-]?\d{1,10}$/.test(String(value.destination??''))||!/^\d{1,3}$/.test(String(value.spp??'')))return null;
  return {currency:'RUB',destination:String(value.destination),spp:String(value.spp),paymentBasis:'unknown'};
}
function effectiveContext(value){
  if(!plain(value)||value.currency!=='RUB')return null;
  const out={currency:'RUB',destination:/^-?\d{1,10}$/.test(String(value.destination??''))?String(value.destination):null,paymentBasis:['unknown','standard','wallet','wb_wallet','card','credit','card_membership','club'].includes(value.paymentBasis)?value.paymentBasis:'unknown'};
  if(value.authentication==='anonymous')out.authentication='anonymous';
  if(/^\d{1,3}$/.test(String(value.spp??'')))out.spp=String(value.spp);
  return out;
}
/** Defence in depth: never persist arbitrary upstream objects, URLs or text. */
export function sanitizePassiveEvent(input,{now=Date.now()}={}){
  time(now);if(!plain(input)||!ident(input.runId)||!ident(input.eventId)||!Number.isSafeInteger(input.at)||input.at<=0||input.at>now||input.source!=='wb_card'||input.method!=='GET'||input.acquisition!=='native_details'||input.fallback!==false||!Number.isInteger(input.httpStatus)||input.httpStatus<0||input.httpStatus>599||!['success','error','invalid'].includes(input.outcome)||!Array.isArray(input.offers)||input.offers.length>20)return null;
  const requested=requestedContext(input.requestedContext);if(!requested)return null;
  const success=input.outcome==='success'&&input.httpStatus>=200&&input.httpStatus<300,offers=[],seen=new Set();
  for(const raw of input.offers){
    if(!plain(raw)||!id(raw.id))continue;
    if(!success){
      const key=String(raw.id);if(seen.has(key))continue;seen.add(key);
      offers.push({id:raw.id,variantKey:'unknown',size:null,price:null,currency:'RUB',available:null,priceObservedAt:null,stockObservedAt:null,verificationStatus:'unconfirmed',retailConfirmed:false,context:null,requestedContext:requested});continue;
    }
    const variantKey=typeof raw.variantKey==='string'&&/^[1-9]\d{0,11}$/.test(raw.variantKey)?raw.variantKey:'unknown';
    const key=raw.id+'|'+variantKey+'|'+(size(raw.size)||'');if(seen.has(key))continue;seen.add(key);
    const price=raw.currency==='RUB'&&typeof raw.price==='number'&&Number.isFinite(raw.price)&&raw.price>0&&raw.price<=1e7?Math.round(raw.price*100)/100:null;
    const priceAt=fresh(raw.priceObservedAt,input.at)?raw.priceObservedAt:null,stockAt=fresh(raw.stockObservedAt,input.at)?raw.stockObservedAt:null;
    const observed=raw.verificationStatus==='api_observed'&&price!==null&&price>0&&priceAt!==null;
    offers.push({id:raw.id,variantKey,size:size(raw.size),price:observed?price:null,currency:'RUB',available:stockAt!==null&&typeof raw.available==='boolean'?raw.available:null,priceObservedAt:observed?priceAt:null,stockObservedAt:stockAt,verificationStatus:observed?'api_observed':'unconfirmed',retailConfirmed:false,context:effectiveContext(raw.context),requestedContext:requested});
  }
  return {runId:input.runId,eventId:input.eventId,at:input.at,source:'wb_card',method:'GET',acquisition:'native_details',httpStatus:input.httpStatus,fallback:false,requestedContext:requested,offers,outcome:success?'success':input.outcome==='invalid'?'invalid':'error'};
}
// Keep this source equal to passive_schema.sql; Workers cannot import fs.
export const PASSIVE_SCHEMA=String.raw`-- Explicit isolated migration; API observations are never retail confirmations.
CREATE TABLE IF NOT EXISTS passive_control(id INTEGER PRIMARY KEY CHECK(id=1),active_run_id TEXT);
INSERT OR IGNORE INTO passive_control(id) VALUES(1);
CREATE TABLE IF NOT EXISTS passive_stats(id INTEGER PRIMARY KEY CHECK(id=1),event_rows INTEGER NOT NULL DEFAULT 0 CHECK(event_rows BETWEEN 0 AND 140),history_rows INTEGER NOT NULL DEFAULT 0 CHECK(history_rows BETWEEN 0 AND 9000),run_rows INTEGER NOT NULL DEFAULT 0 CHECK(run_rows BETWEEN 0 AND 28));
INSERT OR IGNORE INTO passive_stats(id) VALUES(1);
CREATE TABLE IF NOT EXISTS passive_write_budget(day TEXT PRIMARY KEY,reserved_writes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_writes BETWEEN 0 AND 3000),actual_writes INTEGER NOT NULL DEFAULT 0,meter_state TEXT NOT NULL DEFAULT 'known' CHECK(meter_state IN ('known','unknown','overrun')),admission_nonce TEXT NOT NULL DEFAULT '') WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS passive_runs(run_id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,stopped_at INTEGER,status TEXT NOT NULL CHECK(status IN ('active','complete','stopped','expired','meter_unknown','budget_exceeded')),response_count INTEGER NOT NULL DEFAULT 0 CHECK(response_count BETWEEN 0 AND 20),offer_count INTEGER NOT NULL DEFAULT 0 CHECK(offer_count BETWEEN 0 AND 400),admission_nonce TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS passive_runs_time ON passive_runs(started_at,run_id);
CREATE TRIGGER IF NOT EXISTS passive_runs_cap BEFORE INSERT ON passive_runs WHEN NOT EXISTS(SELECT 1 FROM passive_runs WHERE run_id=NEW.run_id) AND (SELECT run_rows FROM passive_stats WHERE id=1)>=28 BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS passive_runs_insert AFTER INSERT ON passive_runs BEGIN UPDATE passive_stats SET run_rows=run_rows+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS passive_runs_delete AFTER DELETE ON passive_runs BEGIN UPDATE passive_stats SET run_rows=run_rows-1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS passive_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES passive_runs(run_id),observed_at INTEGER NOT NULL,captured_at INTEGER NOT NULL,http_status INTEGER NOT NULL CHECK(http_status BETWEEN 0 AND 599),outcome TEXT NOT NULL CHECK(outcome IN ('success','error','invalid')),requested_context TEXT NOT NULL CHECK(json_valid(requested_context)),offers TEXT NOT NULL CHECK(json_valid(offers) AND json_type(offers)='array' AND json_array_length(offers)<=20),admission_nonce TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS passive_events_run ON passive_events(run_id,observed_at,event_id);
CREATE INDEX IF NOT EXISTS passive_events_time ON passive_events(captured_at,event_id);
CREATE TRIGGER IF NOT EXISTS passive_events_cap BEFORE INSERT ON passive_events WHEN NOT EXISTS(SELECT 1 FROM passive_events WHERE event_id=NEW.event_id) AND ((SELECT event_rows FROM passive_stats WHERE id=1)>=140 OR NOT EXISTS(SELECT 1 FROM passive_runs r JOIN passive_control c ON c.active_run_id=r.run_id WHERE c.id=1 AND r.run_id=NEW.run_id AND r.status='active' AND r.response_count<20 AND NEW.observed_at>=r.started_at AND NEW.observed_at<r.expires_at AND NEW.captured_at<r.expires_at)) BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS passive_events_insert AFTER INSERT ON passive_events BEGIN UPDATE passive_stats SET event_rows=event_rows+1 WHERE id=1; UPDATE passive_runs SET response_count=response_count+1,offer_count=offer_count+json_array_length(NEW.offers) WHERE run_id=NEW.run_id; END;
CREATE TRIGGER IF NOT EXISTS passive_events_delete AFTER DELETE ON passive_events BEGIN UPDATE passive_stats SET event_rows=event_rows-1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS observed_quote_history(nm_id INTEGER NOT NULL CHECK(nm_id>0 AND nm_id<1000000000000),variant_key TEXT NOT NULL,requested_context TEXT NOT NULL CHECK(json_valid(requested_context)),effective_context TEXT NOT NULL CHECK(json_valid(effective_context)),day TEXT NOT NULL,observed_at INTEGER NOT NULL,price REAL NOT NULL CHECK(price>0 AND price<=10000000),stock_observed_at INTEGER,available INTEGER CHECK(available IS NULL OR available IN (0,1)),PRIMARY KEY(nm_id,variant_key,requested_context,effective_context,day)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS observed_quote_history_time ON observed_quote_history(observed_at,nm_id,variant_key,requested_context,effective_context,day);
CREATE TRIGGER IF NOT EXISTS observed_quote_history_cap BEFORE INSERT ON observed_quote_history WHEN NOT EXISTS(SELECT 1 FROM observed_quote_history WHERE nm_id=NEW.nm_id AND variant_key=NEW.variant_key AND requested_context=NEW.requested_context AND effective_context=NEW.effective_context AND day=NEW.day) AND (SELECT history_rows FROM passive_stats WHERE id=1)>=9000 BEGIN DELETE FROM observed_quote_history WHERE (nm_id,variant_key,requested_context,effective_context,day) IN (SELECT nm_id,variant_key,requested_context,effective_context,day FROM observed_quote_history ORDER BY observed_at,nm_id,variant_key,requested_context,effective_context,day LIMIT 1); END;
CREATE TRIGGER IF NOT EXISTS observed_quote_history_insert AFTER INSERT ON observed_quote_history BEGIN UPDATE passive_stats SET history_rows=history_rows+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS observed_quote_history_delete AFTER DELETE ON observed_quote_history BEGIN UPDATE passive_stats SET history_rows=history_rows-1 WHERE id=1; END;`;
export function openPassivePriceStore(env,{approvedDatabaseId}={}){
  if(env?.PRICE_ISOLATED!=='true'||!env.PRICE_DB||env.PRICE_DB===env.DB||typeof env.PRICE_DB.prepare!=='function'||typeof env.PRICE_DB.batch!=='function')throw Error('PASSIVE_SEPARATE_ISOLATED_DB_REQUIRED');
  if(typeof approvedDatabaseId!=='string'||!/^[a-z0-9-]{16,80}$/.test(approvedDatabaseId)||approvedDatabaseId!==env.PRICE_DATABASE_ID||FORBIDDEN.has(approvedDatabaseId.toLowerCase()))throw Error('PASSIVE_APPROVED_DATABASE_ID_REQUIRED');
  const db=env.PRICE_DB,enabled=env.PRICE_PASSIVE_ENABLED==='true';
  async function suspend(runId,at,reason){
    await db.batch([q(db,'UPDATE passive_runs SET status=?,stopped_at=? WHERE run_id=? AND status IN (\'active\',\'complete\')',reason,at,runId),q(db,'UPDATE passive_control SET active_run_id=NULL WHERE id=1 AND active_run_id=?',runId)]);
  }
  async function settle(results,{at,reserve,runId}){
    const known=results.every(r=>Number.isSafeInteger(r?.meta?.rows_written)&&r.meta.rows_written>=0),actual=known?results.reduce((n,r)=>n+r.meta.rows_written,0):null,charged=known?actual+4:null;
    if(!known||charged>reserve){
      const reason=known?'budget_exceeded':'meter_unknown';await q(db,'UPDATE passive_write_budget SET meter_state=? WHERE day=?',known?'overrun':'unknown',day(at)).run();await suspend(runId,at,reason);
      return {known:false,reason:known?'WRITE_RESERVATION_EXCEEDED':'WRITE_METER_UNKNOWN',reserved:reserve,actualWrites:actual};
    }
    await q(db,'UPDATE passive_write_budget SET reserved_writes=reserved_writes-?+?,actual_writes=actual_writes+? WHERE day=? AND reserved_writes>=?',reserve,charged,actual,day(at),reserve).run();
    return {known:true,reserved:charged,actualWrites:actual,settlementAllowance:4};
  }
  async function runStatus(runId,at){
    const row=await q(db,`SELECT r.*,s.history_rows,s.event_rows,b.reserved_writes,b.actual_writes,b.meter_state,
      (SELECT count(DISTINCT json_extract(j.value,'$.id')) FROM passive_events e,json_each(e.offers) j WHERE e.run_id=r.run_id) AS distinct_ids
      FROM passive_runs r CROSS JOIN passive_stats s LEFT JOIN passive_write_budget b ON b.day=? WHERE r.run_id=? AND s.id=1`,day(at),runId).first();
    if(!row||row.started_at<at-PASSIVE_LIMITS.auditDays*DAY)return {enabled:true,status:'not_found',retailConfirmed:0};
    return {enabled:true,runId:row.run_id,status:row.status==='active'&&row.expires_at<=at?'expired':row.status,startedAt:row.started_at,expiresAt:row.expires_at,stoppedAt:row.stopped_at,responseCount:row.response_count,offerCount:row.offer_count,distinctIds:row.distinct_ids,responseLimit:20,retailConfirmed:0,historyRows:row.history_rows,auditRows:row.event_rows,budget:{day:day(at),reservedWrites:row.reserved_writes??0,actualWrites:row.actual_writes??0,meter:row.meter_state??'not_measured',limit:3000},publication:'NONE',aiCalls:0};
  }
  async function finishRun(runId,at,status='stopped'){
    const date=day(at),nonce=crypto.randomUUID(),reserve=PASSIVE_LIMITS.stopReserve;
    const results=await db.batch([
      q(db,'INSERT OR IGNORE INTO passive_write_budget(day) VALUES(?)',date),
      q(db,`UPDATE passive_write_budget SET reserved_writes=reserved_writes+?,admission_nonce=? WHERE day=? AND reserved_writes+?<=3000 AND EXISTS(SELECT 1 FROM passive_runs WHERE run_id=? AND status='active')`,reserve,nonce,date,reserve,runId),
      q(db,`UPDATE passive_runs SET status=?,stopped_at=? WHERE run_id=? AND status='active' AND EXISTS(SELECT 1 FROM passive_write_budget WHERE day=? AND admission_nonce=?)`,status,at,runId,date,nonce),
      q(db,`UPDATE passive_control SET active_run_id=NULL WHERE id=1 AND active_run_id=? AND EXISTS(SELECT 1 FROM passive_runs WHERE run_id=? AND status<>'active')`,runId,runId)
    ]);
    const reserved=await q(db,'SELECT day FROM passive_write_budget WHERE day=? AND admission_nonce=?',date,nonce).first();if(reserved)await settle(results,{at,reserve,runId});
    return {stopped:!!reserved,...(await runStatus(runId,at))};
  }
  return {
    async init(){
      const unsafe=await q(db,"SELECT name FROM sqlite_master WHERE type='table' AND lower(name) IN ('scheduler_config','scheduler_inventory','products') LIMIT 1").first();
      if(unsafe)throw Error('PASSIVE_DATABASE_HAS_PRODUCTION_SCHEMA');
      const statements=PASSIVE_SCHEMA.trim().split(/;\n(?=CREATE|INSERT)/).map(sql=>db.prepare(sql));await db.batch(statements);return {initialized:true,databaseId:approvedDatabaseId,productionChanged:false};
    },
    async start({runId,now=Date.now(),expiresAt,reviewed=false}={}){
      if(!enabled)return {started:false,status:'disabled',sourceCalls:0};time(now);
      if(reviewed!==true||!ident(runId)||!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>DAY)throw Error('PASSIVE_REVIEWED_RUN_REQUIRED');
      const nonce=crypto.randomUUID(),date=day(now),reserve=PASSIVE_LIMITS.startReserve;
      const admitted=`EXISTS(SELECT 1 FROM passive_write_budget WHERE day=? AND admission_nonce=?)`;
      const results=await db.batch([
        q(db,'INSERT OR IGNORE INTO passive_write_budget(day) VALUES(?)',date),
        q(db,`UPDATE passive_write_budget SET reserved_writes=reserved_writes+?,admission_nonce=? WHERE day=? AND meter_state='known' AND reserved_writes+?<=2980 AND NOT EXISTS(SELECT 1 FROM passive_runs WHERE run_id=?) AND NOT EXISTS(SELECT 1 FROM passive_control c JOIN passive_runs r ON r.run_id=c.active_run_id WHERE c.id=1 AND r.status='active' AND r.expires_at>?)`,reserve,nonce,date,reserve,runId,now),
        q(db,`DELETE FROM passive_events WHERE event_id IN (SELECT event_id FROM passive_events WHERE captured_at<? ORDER BY captured_at,event_id LIMIT 20) AND ${admitted}`,now-7*DAY,date,nonce),
        q(db,`DELETE FROM observed_quote_history WHERE (nm_id,variant_key,requested_context,effective_context,day) IN (SELECT nm_id,variant_key,requested_context,effective_context,day FROM observed_quote_history WHERE observed_at<? ORDER BY observed_at,nm_id,variant_key,requested_context,effective_context,day LIMIT 20) AND ${admitted}`,now-90*DAY,date,nonce),
        q(db,`DELETE FROM passive_runs WHERE run_id IN (SELECT run_id FROM passive_runs WHERE started_at<? AND NOT EXISTS(SELECT 1 FROM passive_events e WHERE e.run_id=passive_runs.run_id) ORDER BY started_at,run_id LIMIT 4) AND ${admitted}`,now-7*DAY,date,nonce),
        q(db,`DELETE FROM passive_write_budget WHERE day IN (SELECT day FROM passive_write_budget WHERE day<? ORDER BY day LIMIT 2) AND ${admitted}`,day(now-8*DAY),date,nonce),
        q(db,`UPDATE passive_runs SET status='expired',stopped_at=? WHERE run_id=(SELECT active_run_id FROM passive_control WHERE id=1) AND status='active' AND expires_at<=? AND ${admitted}`,now,now,date,nonce),
        q(db,`INSERT OR IGNORE INTO passive_runs(run_id,started_at,expires_at,status,admission_nonce) SELECT ?,?,?,'active',? WHERE ${admitted} AND (SELECT run_rows FROM passive_stats WHERE id=1)<28`,runId,now,expiresAt,nonce,date,nonce),
        q(db,`UPDATE passive_control SET active_run_id=? WHERE id=1 AND EXISTS(SELECT 1 FROM passive_runs WHERE run_id=? AND admission_nonce=?)`,runId,runId,nonce)
      ]);
      const created=await q(db,'SELECT run_id FROM passive_runs WHERE run_id=? AND admission_nonce=?',runId,nonce).first();
      if(!created)return {started:false,status:'not_admitted',reason:'ACTIVE_RUN_OR_CAPACITY_OR_DAILY_BUDGET',...(await runStatus(runId,now))};
      const meter=await settle(results,{at:now,reserve,runId});return {started:meter.known,meter,...(await runStatus(runId,now))};
    },
    async capture(input,{now=Date.now()}={}){
      if(!enabled)return noCapture('DISABLED');let event;try{event=sanitizePassiveEvent(input,{now});}catch{return noCapture('INVALID_EVENT');}if(!event)return noCapture('INVALID_EVENT');
      const nonce=crypto.randomUUID(),date=day(now),reserve=PASSIVE_LIMITS.captureReserve;
      try{
        // Durable cheap rejection: a fresh Cron isolate does not remember a
        // producer latch. Terminal/expired/wrong-run/duplicate calls use one
        // indexed read and perform no writes. The batch still repeats every
        // admission predicate, so this optimisation is never the race guard.
        const gate=await q(db,`SELECT r.run_id,r.started_at,r.expires_at,r.status,r.response_count,r.offer_count,c.active_run_id,s.event_rows,
          b.reserved_writes,b.meter_state,EXISTS(SELECT 1 FROM passive_events WHERE event_id=?) AS duplicate
          FROM passive_runs r CROSS JOIN passive_control c CROSS JOIN passive_stats s LEFT JOIN passive_write_budget b ON b.day=?
          WHERE r.run_id=? AND c.id=1 AND s.id=1`,event.eventId,date,event.runId).first();
        if(!gate)return {...noCapture('RUN_NOT_FOUND'),runId:event.runId,status:'not_found',responseCount:0};
        const rejected=(reason,status=gate.status)=>({...noCapture(reason),runId:event.runId,status,responseCount:gate.response_count,offerCount:gate.offer_count});
        if(gate.status!=='active')return rejected('RUN_NOT_ACTIVE');
        if(gate.expires_at<=now||gate.expires_at<=event.at)return rejected('RUN_EXPIRED','expired');
        if(gate.active_run_id!==event.runId)return rejected('RUN_NOT_SELECTED','inactive');
        if(gate.started_at>event.at)return rejected('EVENT_PRECEDES_REVIEWED_RUN','invalid');
        if(gate.duplicate)return rejected('DUPLICATE_EVENT');
        if(gate.meter_state&&gate.meter_state!=='known')return rejected('WRITE_METER_BLOCKED','meter_unknown');
        if(gate.response_count>=20)return rejected('RESPONSE_LIMIT','complete');
        if(gate.event_rows>=140)return rejected('AUDIT_CAPACITY','capacity_exceeded');
        if((gate.reserved_writes??0)+reserve>2980)return {...noCapture('DAILY_WRITE_BUDGET'),...(await finishRun(event.runId,now,'budget_exceeded'))};
        const results=await db.batch([
          q(db,`INSERT OR IGNORE INTO passive_write_budget(day) SELECT ? WHERE EXISTS(SELECT 1 FROM passive_control c JOIN passive_runs r ON r.run_id=c.active_run_id WHERE c.id=1 AND c.active_run_id=? AND r.status='active' AND r.expires_at>?)`,date,event.runId,now),
          q(db,`UPDATE passive_write_budget SET reserved_writes=reserved_writes+?,admission_nonce=? WHERE day=? AND meter_state='known' AND reserved_writes+?<=2980 AND (SELECT event_rows FROM passive_stats WHERE id=1)<140 AND NOT EXISTS(SELECT 1 FROM passive_events WHERE event_id=?) AND EXISTS(SELECT 1 FROM passive_control c JOIN passive_runs r ON r.run_id=c.active_run_id WHERE c.id=1 AND c.active_run_id=? AND r.status='active' AND r.response_count<20 AND r.started_at<=? AND r.expires_at>? AND r.expires_at>?)`,reserve,nonce,date,reserve,event.eventId,event.runId,event.at,event.at,now),
          q(db,`INSERT OR IGNORE INTO passive_events(event_id,run_id,observed_at,captured_at,http_status,outcome,requested_context,offers,admission_nonce) SELECT ?,c.active_run_id,?,?,?,?,?,?,? FROM passive_control c WHERE c.id=1 AND c.active_run_id=? AND EXISTS(SELECT 1 FROM passive_write_budget WHERE day=? AND admission_nonce=?)`,event.eventId,event.at,now,event.httpStatus,event.outcome,JSON.stringify(event.requestedContext),JSON.stringify(event.offers),nonce,event.runId,date,nonce),
          q(db,`INSERT OR IGNORE INTO observed_quote_history(nm_id,variant_key,requested_context,effective_context,day,observed_at,price,stock_observed_at,available) SELECT json_extract(j.value,'$.id'),json_extract(j.value,'$.variantKey'),json_extract(j.value,'$.requestedContext'),coalesce(json_extract(j.value,'$.context'),'null'),strftime('%Y-%m-%d',json_extract(j.value,'$.priceObservedAt')/1000,'unixepoch'),json_extract(j.value,'$.priceObservedAt'),json_extract(j.value,'$.price'),json_extract(j.value,'$.stockObservedAt'),json_extract(j.value,'$.available') FROM passive_events e,json_each(e.offers) j WHERE e.event_id=? AND e.admission_nonce=? AND json_extract(j.value,'$.verificationStatus')='api_observed' AND json_extract(j.value,'$.variantKey')<>'unknown'`,event.eventId,nonce),
          q(db,`DELETE FROM observed_quote_history WHERE (nm_id,variant_key,requested_context,effective_context,day) IN (SELECT nm_id,variant_key,requested_context,effective_context,day FROM observed_quote_history WHERE observed_at<? ORDER BY observed_at,nm_id,variant_key,requested_context,effective_context,day LIMIT 10) AND EXISTS(SELECT 1 FROM passive_events WHERE event_id=? AND admission_nonce=?)`,now-90*DAY,event.eventId,nonce),
          q(db,`UPDATE passive_runs SET status='complete',stopped_at=? WHERE run_id=(SELECT run_id FROM passive_events WHERE event_id=? AND admission_nonce=?) AND response_count>=20`,now,event.eventId,nonce),
          q(db,`UPDATE passive_control SET active_run_id=NULL WHERE id=1 AND EXISTS(SELECT 1 FROM passive_runs WHERE run_id=active_run_id AND status='complete')`)
        ]);
        const receipt=await q(db,'SELECT run_id FROM passive_events WHERE event_id=? AND admission_nonce=?',event.eventId,nonce).first();
        if(!receipt){
          let state=await runStatus(event.runId,now);
          if(state.status==='active'&&state.budget.meter==='known'&&state.budget.reservedWrites+reserve>2980){state=await finishRun(event.runId,now,'budget_exceeded');return {...noCapture('DAILY_WRITE_BUDGET'),...state};}
          return {...noCapture('DUPLICATE_OR_RUN_NOT_ACTIVE'),...state};
        }
        const meter=await settle(results,{at:now,reserve,runId:receipt.run_id});return {captured:true,eventId:event.eventId,offers:event.offers.length,meter,...(await runStatus(receipt.run_id,now))};
      }catch{return {...noCapture('ISOLATED_STORAGE_UNAVAILABLE'),status:'meter_unknown'};}
    },
    async status({runId,now=Date.now()}={}){
      if(!enabled)return {enabled:false,status:'disabled',retailConfirmed:0,publication:'NONE'};time(now);if(runId!==undefined&&!ident(runId))throw Error('PASSIVE_RUN_ID_INVALID');
      if(!runId)runId=(await q(db,'SELECT active_run_id FROM passive_control WHERE id=1').first())?.active_run_id;
      return runId?runStatus(runId,now):{enabled:true,status:'disabled',retailConfirmed:0,publication:'NONE'};
    },
    async stop({runId,now=Date.now()}={}){
      if(!enabled)return {stopped:false,status:'disabled'};time(now);if(!ident(runId))throw Error('PASSIVE_RUN_ID_INVALID');return finishRun(runId,now);
    },
    async exportSafe({runId,now=Date.now()}={}){
      if(!enabled)return {enabled:false,status:'disabled',events:[],retailConfirmed:0};time(now);if(!ident(runId))throw Error('PASSIVE_RUN_ID_INVALID');
      const status=await runStatus(runId,now);if(status.status==='not_found')return {...status,events:[]};
      const rows=(await q(db,'SELECT event_id,observed_at,http_status,outcome,requested_context,offers FROM passive_events WHERE run_id=? AND captured_at>=? ORDER BY observed_at,event_id LIMIT 20',runId,now-7*DAY).all()).results;
      const events=rows.map(r=>sanitizePassiveEvent({runId,eventId:r.event_id,at:r.observed_at,source:'wb_card',method:'GET',acquisition:'native_details',httpStatus:r.http_status,fallback:false,outcome:r.outcome,requestedContext:parse(r.requested_context),offers:parse(r.offers)},{now})).filter(Boolean);
      return {...status,events,priceEvidence:'API_OBSERVATION_ONLY',historyRetentionDays:90,historyLimit:28,retailConfirmed:0,publication:'NONE'};
    },
    async history({id:nmId,variantKey,requestedContext:requested,context=null,now=Date.now(),limit=28}={}){
      if(!enabled)return [];time(now);const req=requestedContext(requested),ctx=effectiveContext(context);
      if(!id(nmId)||typeof variantKey!=='string'||!/^\d{1,12}$/.test(variantKey)||!req||!Number.isSafeInteger(limit)||limit<1||limit>28)throw Error('PASSIVE_HISTORY_KEY_REQUIRED');
      const rows=(await q(db,'SELECT day,observed_at,price,stock_observed_at,available FROM observed_quote_history WHERE nm_id=? AND variant_key=? AND requested_context=? AND effective_context=? AND day>=? AND day<=? ORDER BY day DESC LIMIT ?',nmId,variantKey,JSON.stringify(req),JSON.stringify(ctx),day(now-90*DAY),day(now),limit).all()).results;
      return rows.filter(r=>r.observed_at<=now&&r.observed_at>=now-90*DAY).map(r=>({id:nmId,variantKey,day:r.day,observedAt:r.observed_at,price:r.price,currency:'RUB',stockObservedAt:r.stock_observed_at,available:r.available===null?null:r.available===1,requestedContext:req,context:ctx,verificationStatus:'api_observed',retailConfirmed:false,historical:true,source:'wb_card'}));
    }
  };
}
