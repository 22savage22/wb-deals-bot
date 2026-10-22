// SQLite fixtures only. Synthetic row metadata below tests budget decisions; it
// is explicitly NOT a measurement of Cloudflare index writes or account usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LocalD1} from '../features/local_d1.mjs';
import {openPassivePriceStore,sanitizePassiveEvent,PASSIVE_SCHEMA,PASSIVE_LIMITS} from './passive_store.mjs';
const NOW=Date.parse('2026-10-18T10:00:00Z'),DAY=86400000,ID='isolated-passive-unit-test-db',RUN='passive-reviewed-run-001';
const requested={currency:'RUB',destination:'-1257786',spp:'30',paymentBasis:'unknown'};
const context={currency:'RUB',destination:'-1257786',paymentBasis:'unknown',authentication:'anonymous'};
const offer=(pid=123,at=NOW,patch={})=>({id:pid,variantKey:String(pid*100),size:'M (48)',price:199.95,currency:'RUB',available:true,priceObservedAt:at,stockObservedAt:at,verificationStatus:'api_observed',retailConfirmed:false,context:{...context},requestedContext:{...requested},...patch});
const event=(n=1,at=NOW,patch={})=>({runId:RUN,eventId:'passive-event-'+String(n).padStart(6,'0'),at,source:'wb_card',method:'GET',acquisition:'native_details',httpStatus:200,fallback:false,requestedContext:{...requested},offers:[offer(123,at)],outcome:'success',...patch});
class MeterFixture extends LocalD1{
  known=true;
  async batch(statements){
    const before=this.sqlite.prepare('SELECT total_changes() n').get().n;
    const r=await super.batch(statements),after=this.sqlite.prepare('SELECT total_changes() n').get().n;
    if(this.known)r.forEach((row,i)=>row.meta.rows_written=i===0?after-before:0);
    return r;
  }
}
async function fixture(t,{enabled=true}={}){
  const db=new MeterFixture();t.after(()=>db.close());
  const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db,PRICE_PASSIVE_ENABLED:enabled?'true':'false',DB:{prepare(){throw Error('PRODUCTION_FORBIDDEN');}}};
  const store=openPassivePriceStore(env,{approvedDatabaseId:ID});await store.init();
  return {db,store,env,reopen:()=>openPassivePriceStore(env,{approvedDatabaseId:ID}),start:(runId=RUN,at=NOW)=>store.start({runId,now:at,expiresAt:at+DAY,reviewed:true})};
}
const sql=(db,text,...args)=>db.sqlite.prepare(text).get(...args),count=(db,table)=>sql(db,'SELECT count(*) n FROM '+table).n;

test('default OFF and construction perform zero D1 calls; schema and physical isolation are explicit',async()=>{
  let calls=0;const db={prepare(){calls++;throw Error('UNEXPECTED_DB');},batch(){calls++;throw Error('UNEXPECTED_DB');}};
  const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db};
  const s=openPassivePriceStore(env,{approvedDatabaseId:ID});
  assert.equal((await s.capture(event())).reason,'DISABLED');assert.equal((await s.status()).status,'disabled');assert.equal((await s.start()).status,'disabled');assert.equal((await s.stop()).status,'disabled');assert.deepEqual((await s.exportSafe()).events,[]);assert.equal(calls,0);
  for(const patch of [{DB:db},{PRICE_ISOLATED:true},{PRICE_DB:null}])assert.throws(()=>openPassivePriceStore({...env,...patch},{approvedDatabaseId:ID}),/SEPARATE_ISOLATED/);
  for(const bad of [undefined,'d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','43861c0c-aa50-4e5e-9014-7b36bd319e5b'])assert.throws(()=>openPassivePriceStore({...env,PRICE_DATABASE_ID:bad},{approvedDatabaseId:bad}),/APPROVED_DATABASE/);
  assert.equal(PASSIVE_SCHEMA.trim(),(await readFile(new URL('./passive_schema.sql',import.meta.url),'utf8')).trim());
});
test('fake isolated ID cannot migrate a physical production schema',async t=>{
  for(const name of ['products','scheduler_config','scheduler_inventory','Products']){
    const db=new MeterFixture();t.after(()=>db.close());db.sqlite.exec('CREATE TABLE '+name+'(id INTEGER)');
    const s=openPassivePriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db},{approvedDatabaseId:ID});
    await assert.rejects(()=>s.init(),/HAS_PRODUCTION_SCHEMA/);assert.equal(count(db,'sqlite_master'),1);
  }
});
test('reviewed bounded run is explicit, unique and remains active after reopening',async t=>{
  const {store,start,reopen}=await fixture(t);await assert.rejects(()=>store.start({runId:RUN,now:NOW,expiresAt:NOW+DAY}),/REVIEWED/);
  await assert.rejects(()=>store.start({runId:RUN,now:NOW,expiresAt:NOW+DAY+1,reviewed:true}),/REVIEWED/);
  assert.equal((await start()).started,true);assert.equal((await reopen().status({now:NOW})).runId,RUN);
  assert.equal((await start('passive-other-run')).started,false);assert.equal((await start()).started,false);
  assert.equal((await store.stop({runId:RUN,now:NOW+1})).status,'stopped');assert.equal((await reopen().capture(event(1,NOW+2),{now:NOW+2})).captured,false);
  assert.equal((await start('passive-other-run',NOW+3)).started,true);
  assert.equal((await reopen().capture(event(2,NOW+4),{now:NOW+4})).captured,false);
  assert.equal((await store.status({runId:'passive-other-run',now:NOW+4})).responseCount,0);
  assert.equal((await reopen().capture(event(3,NOW+4,{runId:'passive-other-run'}),{now:NOW+4})).captured,true);
});
test('20 response cap and dedup are atomic across concurrency/restart, not a product count',async t=>{
  const {store,db,start,reopen}=await fixture(t);await start();
  const captures=await Promise.all(Array.from({length:26},(_,n)=>reopen().capture(event(n+1,NOW+1),{now:NOW+1})));
  // Concurrent operations must first reserve their full worst case. Some can
  // be refused until earlier measured reservations settle; later natural
  // responses may consume the remaining slots, but never exceed twenty.
  assert.ok(captures.filter(r=>r.captured).length<=20);
  for(let n=0;n<captures.length;n++)if(!captures[n].captured)await reopen().capture(event(n+1,NOW+1),{now:NOW+2});
  const s=await store.status({runId:RUN,now:NOW+2});
  assert.equal(s.responseCount,20);assert.equal(s.distinctIds,1);assert.equal(s.offerCount,20);assert.equal(s.status,'complete');assert.equal(count(db,'passive_events'),20);
  assert.equal(count(db,'observed_quote_history'),1);const before=db.queries.length;assert.equal((await reopen().capture(event(1,NOW+1),{now:NOW+1})).captured,false);assert.equal(db.queries.length-before,1);assert.equal(db.queries.at(-1).kind,'first');assert.ok(s.budget.reservedWrites<=3000);
});
test('failure responses count once, never invent quotes and cannot resurrect a price',async t=>{
  const {store,start,db}=await fixture(t);await start();await store.capture(event(),{now:NOW});
  const bad=event(2,NOW+1,{httpStatus:403,outcome:'error',offers:[offer(999,NOW+1,{retailConfirmed:true})]});
  assert.equal((await store.capture(bad,{now:NOW+1})).captured,true);const before=db.queries.length;assert.equal((await store.capture(bad,{now:NOW+1})).captured,false);assert.equal(db.queries.length-before,1);
  const out=await store.exportSafe({runId:RUN,now:NOW+1});assert.equal(out.responseCount,2);assert.equal(out.events[1].offers.length,1);assert.equal(out.distinctIds,2);assert.deepEqual(out.events[1].offers[0],{id:999,variantKey:'unknown',size:null,price:null,currency:'RUB',available:null,priceObservedAt:null,stockObservedAt:null,verificationStatus:'unconfirmed',retailConfirmed:false,context:null,requestedContext:requested});assert.equal(out.retailConfirmed,0);assert.equal(count(db,'observed_quote_history'),1);
  const history=await store.history({id:123,variantKey:'12300',requestedContext:requested,context,now:NOW+1});assert.equal(history[0].historical,true);assert.equal(history[0].retailConfirmed,false);
});
test('strict sanitizer drops secrets, refuses other acquisition paths and bounds bodies before D1',async t=>{
  const {store,start,db}=await fixture(t);await start();const before=db.queries.length;
  for(const patch of [{source:'wb_search'},{fallback:true},{method:'POST'},{acquisition:'metadata'},{offers:Array.from({length:21},()=>offer())},{at:NOW+1}])assert.equal((await store.capture(event(1,NOW,patch),{now:NOW})).reason,'INVALID_EVENT');
  assert.equal(db.queries.length,before);
  const p=offer(123,NOW,{retailConfirmed:true,size:'Bearer secret-marker',headers:{Authorization:'secret-marker'},url:'https://secret-marker.invalid',name:'secret-marker',context:{...context,Cookie:'secret-marker'}});
  await store.capture({...event(),offers:[p],headers:{Cookie:'secret-marker'},raw:'secret-marker'},{now:NOW});
  const out=await store.exportSafe({runId:RUN,now:NOW});assert.doesNotMatch(JSON.stringify(out),/secret-marker|Authorization|Cookie|https:/);assert.equal(out.events[0].offers[0].size,null);assert.equal(out.events[0].offers[0].retailConfirmed,false);
  const cell=sql(db,'SELECT offers FROM passive_events').offers;assert.doesNotMatch(cell,/secret-marker/);
});
test('stock and price have separate timestamps; requested context is not retail attestation',()=>{
  const p=sanitizePassiveEvent(event(1,NOW,{offers:[offer(1,NOW,{stockObservedAt:NOW-3600001}),offer(2,NOW,{priceObservedAt:null}),offer(3,NOW,{stockObservedAt:NOW+1}),offer(4,NOW,{context:{...context,paymentBasis:'standard'},retailConfirmed:true})]}),{now:NOW});
  assert.equal(p.offers[0].verificationStatus,'api_observed');assert.equal(p.offers[0].available,null);assert.equal(p.offers[1].verificationStatus,'unconfirmed');assert.equal(p.offers[1].price,null);assert.equal(p.offers[2].available,null);assert.equal(p.offers[3].retailConfirmed,false);assert.equal(p.offers[3].requestedContext.paymentBasis,'unknown');
});
test('run TTL stops captures even after reopening and audits are inaccessible after seven days',async t=>{
  const {store,start,reopen,db}=await fixture(t);await start();await store.capture(event(),{now:NOW});
  const before=db.queries.length;assert.equal((await reopen().capture(event(2,NOW+DAY),{now:NOW+DAY})).captured,false);assert.equal(db.queries.length-before,1);assert.equal((await store.status({runId:RUN,now:NOW+DAY})).status,'expired');
  assert.equal((await store.exportSafe({runId:RUN,now:NOW+8*DAY})).events.length,0);
});
test('unknown meter keeps reservation, stops capture durably and fails closed for that day',async t=>{
  const {store,start,db,reopen}=await fixture(t);await start();db.known=false;
  const out=await store.capture(event(),{now:NOW});assert.equal(out.captured,true);assert.equal(out.status,'meter_unknown');assert.equal(out.meter.reason,'WRITE_METER_UNKNOWN');assert.ok(out.budget.reservedWrites>=240);
  assert.equal((await reopen().capture(event(2,NOW+1),{now:NOW+1})).captured,false);assert.equal((await store.start({runId:'passive-second-run',now:NOW+1,expiresAt:NOW+DAY,reviewed:true})).started,false);
});
test('daily budget and per-capture query counts are bounded independently of offer count',async t=>{
  const {store,start,db}=await fixture(t);await start();const before=db.queries.length;
  await store.capture(event(1,NOW,{offers:Array.from({length:20},(_,n)=>offer(n+1,NOW))}),{now:NOW});assert.ok(db.queries.length-before<=50);assert.equal(count(db,'observed_quote_history'),20);
  db.sqlite.prepare('UPDATE passive_write_budget SET reserved_writes=2980 WHERE day=?').run('2026-10-18');const stopped=await store.capture(event(2,NOW+1),{now:NOW+1});assert.equal(stopped.captured,false);assert.equal(stopped.status,'budget_exceeded');assert.equal((await store.status({runId:RUN,now:NOW+1})).status,'budget_exceeded');assert.equal(count(db,'passive_events'),1);
});
test('history is exact SKU/request/effective context, daily deduplicated and uses the observed UTC day',async t=>{
  const {store,start,db}=await fixture(t);await start();
  await store.capture(event(1,NOW,{offers:[offer(123,NOW)]}),{now:NOW});await store.capture(event(2,NOW+1,{offers:[offer(123,NOW+1,{price:100})]}),{now:NOW+1});assert.equal(count(db,'observed_quote_history'),1);
  await store.capture(event(3,NOW+2,{requestedContext:{...requested,destination:'123585633'},offers:[offer(123,NOW+2)]}),{now:NOW+2});assert.equal(count(db,'observed_quote_history'),2);
  const r=await store.history({id:123,variantKey:'12300',requestedContext:requested,context,now:NOW+2});assert.equal(r.length,1);assert.equal(r[0].price,199.95);
  const plan=db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT day,price FROM observed_quote_history WHERE nm_id=? AND variant_key=? AND requested_context=? AND effective_context=? AND day>=? AND day<=? ORDER BY day DESC LIMIT 28').all(123,'12300',JSON.stringify(requested),JSON.stringify(context),'2026-01-01','2026-12-31');assert.ok(plan.every(x=>!/SCAN |TEMP B-TREE/.test(x.detail)));
});
test('history cap is durable, duplicates do not evict and old physical rows are pruned economically',async t=>{
  const {store,start,db}=await fixture(t);const ins=db.sqlite.prepare('INSERT INTO observed_quote_history(nm_id,variant_key,requested_context,effective_context,day,observed_at,price) VALUES(?,?,?,?,?,?,?)');
  db.sqlite.exec('BEGIN');for(let n=1;n<=9000;n++)ins.run(n,String(n),JSON.stringify(requested),JSON.stringify(context),'2026-10-17',NOW-DAY,500);db.sqlite.exec('COMMIT');
  assert.equal(sql(db,'SELECT history_rows FROM passive_stats').history_rows,9000);await start();await store.capture(event(1,NOW,{offers:[offer(999999,NOW)]}),{now:NOW});assert.equal(count(db,'observed_quote_history'),9000);assert.equal(sql(db,'SELECT history_rows FROM passive_stats').history_rows,9000);
  const again=event(2,NOW+1,{offers:[offer(999999,NOW+1)]});await store.capture(again,{now:NOW+1});assert.equal(count(db,'observed_quote_history'),9000);assert.equal(sql(db,'SELECT price FROM observed_quote_history WHERE nm_id=999999').price,199.95);
  assert.equal(PASSIVE_LIMITS.historyPrune,10);
});
