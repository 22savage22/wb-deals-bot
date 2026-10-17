// Real local SQLite fixtures; no production D1, WB, Telegram, AI or account
// billing claims. Only the explicitly constructed isolated binding is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LocalD1} from '../features/local_d1.mjs';
import {openPriceStore,PRICE_SCHEMA,PRICE_LIMITS} from './store.mjs';
import {priceContextKey} from '../shadow/value.mjs';
const NOW=Date.parse('2026-10-18T10:00:00Z'),DAY=86400000,MINUTE=60000;
const ID='isolated-prices-local-unit-test';
const context={currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'};
const quote=(id=123,patch={})=>({id,source:'wb-card',name:'Футболка хлопковая '+id,category:'Футболки',categoryVerified:true,
  categorySource:'wb_cdn_metadata',categoryObservedAt:NOW,image:`https://basket-01.wbbasket.ru/vol0/part1/${id}/images/big/1.webp`,
  price:199.95,oldPrice:999.95,priceSource:'wb_card',observedAt:NOW,stockObservedAt:NOW,available:true,
  currency:'RUB',variantKey:'SKU-42',context:{...context},priceContextConfirmed:true,priceCondition:'standard',rating:4.8,reviews:300,
  qualityVerified:true,qualitySource:'wb_card',qualityObservedAt:NOW,provider:'operator-approved-wb',accessReference:'retail-observation-001',
  variants:[{variantKey:'SKU-42',size:'42',price:199.95,available:true,condition:'standard'}],...patch});
async function fixture(t){
  const db=new LocalD1();t.after(()=>db.close());
  const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db,DB:{prepare(){throw Error('PRODUCTION_FORBIDDEN');}}};
  const store=openPriceStore(env,{approvedDatabaseId:ID});await store.init();
  return {db,env,store,reopen:()=>openPriceStore(env,{approvedDatabaseId:ID})};
}
const scalar=(db,sql,...args)=>db.sqlite.prepare(sql).get(...args);
const count=db=>scalar(db,'SELECT count(*) n FROM price_observations').n;

test('guard pins a separately approved DB; construction never reads, writes or migrates',async()=>{
  let calls=0;const db={prepare(){calls++;throw Error('MUST_NOT_TOUCH_DB');},batch(){calls++;throw Error('MUST_NOT_TOUCH_DB');}};
  const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db};
  assert.ok(openPriceStore(env,{approvedDatabaseId:ID}));assert.equal(calls,0);
  for(const patch of [{PRICE_ISOLATED:true},{PRICE_ISOLATED:'false'},{PRICE_DB:null},{DB:db}])assert.throws(()=>openPriceStore({...env,...patch},{approvedDatabaseId:ID}),/SEPARATE_ISOLATED/);
  for(const approved of [undefined,'another-isolated-database-id'])assert.throws(()=>openPriceStore(env,{approvedDatabaseId:approved}),/APPROVED_DATABASE/);
  for(const approved of ['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20'])assert.throws(()=>openPriceStore({...env,PRICE_DATABASE_ID:approved},{approvedDatabaseId:approved}),/APPROVED_DATABASE/);
  assert.equal(calls,0);
  const sql=await readFile(new URL('./schema.sql',import.meta.url),'utf8');assert.equal(PRICE_SCHEMA.trim(),sql.trim());
});

test('explicit init is additive and repeatable; tracking is metadata-only and caps 100 active IDs',async t=>{
  const {db,store}=await fixture(t);await store.init();
  await store.track(Array.from({length:100},(_,i)=>quote(i+1)),{now:NOW});
  const first=(await store.list({now:NOW}))[0];assert.equal(first.product,null);assert.equal(first.confirmed,false);assert.equal(first.priceStatus,'unconfirmed');assert.equal(count(db),0);
  assert.equal(Object.hasOwn(first.metadata,'price'),false);assert.equal(Object.hasOwn(first.metadata,'available'),false);
  const result=await store.track([quote(101)],{now:NOW});assert.deepEqual(result.rejected,[{id:101,reason:'WATCH_CAPACITY'}]);
  const update=await store.track([quote(1,{name:'Обновлённое название'})],{now:NOW+1});assert.equal(update.tracked,1);
  assert.equal(scalar(db,'SELECT count(*) n FROM price_watch WHERE active=1').n,100);
  await assert.rejects(()=>store.track([quote(1),quote(1)],{now:NOW}),/BATCH_INVALID/);
  const mismatch=await store.track([quote(1,{source:'seller-feed'})],{now:NOW});assert.equal(mismatch.rejected[0].reason,'SOURCE_CHANGE_REQUIRES_REVIEW');
});

test('due queue uses its actual index, excludes busy/backoff/blocked sources and has a 20-card maximum',async t=>{
  const {db,store}=await fixture(t);await store.track([quote(2),quote(1)],{now:NOW});
  assert.deepEqual((await store.due({now:NOW})).map(p=>p.id),[1,2]);
  await assert.rejects(()=>store.due({now:NOW,limit:21}),/DUE_LIMIT/);
  const lease=await store.acquire('wb-card',{now:NOW});assert.equal((await store.due({now:NOW})).length,0);
  await store.finish('wb-card',lease.owner,{now:NOW+1,status:200,ok:true});
  assert.equal((await store.due({now:NOW+PRICE_LIMITS.minGapMs})).length,2);
  const plan=db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT w.pid FROM price_watch w INDEXED BY price_watch_due LEFT JOIN price_sources s ON s.source=w.source
    WHERE w.active=1 AND w.due_at<=? AND coalesce(s.blocked,0)=0 AND coalesce(s.next_attempt_at,0)<=? AND coalesce(s.lease_until,0)<=? ORDER BY w.due_at,w.pid LIMIT 20`).all(NOW,NOW,NOW);
  assert.ok(plan.some(row=>/USING (?:COVERING )?INDEX price_watch_due/.test(row.detail)));
  assert.ok(plan.every(row=>!/SCAN price_watch|TEMP B-TREE/.test(row.detail)));
});

test('one durable lease wins simultaneous admission and reserves the complete request cost exactly once',async t=>{
  const {store,reopen,db}=await fixture(t);
  const results=await Promise.all(Array.from({length:8},()=>store.acquire('wb-card',{now:NOW,requestCost:20})));
  assert.equal(results.filter(r=>r.admitted).length,1);assert.equal(scalar(db,'SELECT requests FROM price_request_budget').requests,20);
  assert.equal((await reopen().acquire('wb-card',{now:NOW+1})).reason,'LEASE_BUSY');
  assert.equal((await store.acquire('wb-search',{now:NOW,requestCost:20})).admitted,true);
  assert.equal((await store.acquire('wb-metadata',{now:NOW,requestCost:1})).reason,'DAILY_REQUEST_BUDGET');
  assert.equal(scalar(db,'SELECT requests FROM price_request_budget').requests,40);
  assert.equal((await store.acquire('wb-metadata',{now:NOW+DAY})).admitted,true);
  await assert.rejects(()=>store.acquire('wb-card',{now:NOW,maxRequestsDay:41}),/LIMITS_INVALID/);
  await assert.rejects(()=>store.acquire('wb-card',{now:NOW,minGapMs:1}),/LIMITS_INVALID/);
});

test('smaller common daily cap and source-day accounting remain atomic across different sources',async t=>{
  const {store,db}=await fixture(t);
  const results=await Promise.all(['wb-card','wb-search','wb-metadata'].map(source=>store.acquire(source,{now:NOW,requestCost:2,maxRequestsDay:4})));
  assert.equal(results.filter(r=>r.admitted).length,2);
  assert.equal(scalar(db,'SELECT requests FROM price_request_budget').requests,4);
  assert.equal(scalar(db,'SELECT sum(requests) n FROM price_source_days').n,4);
});

test('401/403 invalidates current price and survives restart/day rollover until confirmed operator reset',async t=>{
  const {store,db,reopen}=await fixture(t);const p=quote();await store.track([p],{now:NOW});await store.ingest([p],{now:NOW});
  const lease=await store.acquire('wb-card',{now:NOW});const finished=await store.finish('wb-card',lease.owner,{now:NOW+100,status:403,code:'raw secret text must not be persisted'});
  assert.equal(finished.blocked,true);assert.equal(finished.invalidated,1);
  const record=(await reopen().list({now:NOW+101}))[0];assert.equal(record.confirmed,false);assert.equal(record.product.price,null);assert.equal(record.priceStatus,'failed');
  assert.equal(record.lastGoodProduct.price,p.price);assert.equal(record.lastGoodProduct.historical,true);assert.equal(count(db),1);
  assert.equal((await reopen().acquire('wb-card',{now:NOW+2*DAY})).reason,'SOURCE_BLOCKED');
  assert.equal((await reopen().ingest([quote(123,{observedAt:NOW+2*DAY,stockObservedAt:NOW+2*DAY})],{now:NOW+2*DAY})).rejected[0].reason,'SOURCE_BLOCKED');
  await assert.rejects(()=>store.resetSource('wb-card',{now:NOW+2*DAY}),/CONFIRMATION_REQUIRED/);
  assert.equal((await store.resetSource('wb-card',{now:NOW+2*DAY,confirmed:true})).reset,true);
  assert.equal((await store.acquire('wb-card',{now:NOW+2*DAY})).admitted,true);
  assert.equal(JSON.stringify(scalar(db,'SELECT * FROM price_sources')).includes('raw secret'),false);
  // HTTP401 follows the same persistent block branch independently.
  const lease2=await store.acquire('wb-search',{now:NOW+2*DAY});await store.finish('wb-search',lease2.owner,{now:NOW+2*DAY+1,status:401});
  assert.equal((await reopen().acquire('wb-search',{now:NOW+3*DAY})).blocked,true);
});

test('429 respects Retry-After across reopen; timeout reservations are never refunded',async t=>{
  const {store,reopen,db}=await fixture(t);const lease=await store.acquire('wb-card',{now:NOW,requestCost:3});
  const end=await store.finish('wb-card',lease.owner,{now:NOW+1,status:429,retryAfterMs:2*3600000});
  assert.ok(end.nextAttemptAt>=NOW+1+2*3600000);
  assert.equal((await reopen().acquire('wb-card',{now:NOW+3600000})).reason,'NOT_DUE');
  const next=await reopen().acquire('wb-card',{now:end.nextAttemptAt});assert.equal(next.admitted,true);
  await store.finish('wb-card',next.owner,{now:end.nextAttemptAt+1,status:0,code:'TIMEOUT'});
  assert.equal(scalar(db,'SELECT requests FROM price_request_budget').requests,4);
});

test('expired owner cannot finish or invalidate a newer lease/current observation',async t=>{
  const {store,db}=await fixture(t);await store.track([quote()],{now:NOW});
  const old=await store.acquire('wb-card',{now:NOW});const later=NOW+PRICE_LIMITS.minGapMs;
  const fresh=await store.acquire('wb-card',{now:later});assert.equal(fresh.admitted,true);
  await store.ingest([quote(123,{observedAt:later,stockObservedAt:later})],{now:later});
  assert.deepEqual(await store.finish('wb-card',old.owner,{now:later+1,status:403}),{finished:false,reason:'STALE_LEASE'});
  assert.equal((await store.list({now:later+1}))[0].confirmed,true);
  assert.equal((await store.finish('wb-card',fresh.owner,{now:later+1,status:200,ok:true})).finished,true);
  assert.equal(scalar(db,'SELECT blocked FROM price_sources').blocked,0);
});

test('real decimal price, independently observed stock and safe evidence survive ingestion',async t=>{
  const {store,db}=await fixture(t);const p=quote(123,{audience:'men',audienceVerified:true,audienceSource:'wb_cdn_metadata',audienceObservedAt:NOW,
    category_source:'wb-cdn',category_root:'Одежда',authentication:'must not copy arbitrary raw fields',authorization:'DO_NOT_COPY',rawError:'DO_NOT_COPY',
    provenance:{provider:'operator-wb',accessReference:'approval-20261018',origin:'https://www.wildberries.ru/catalog/123/detail.aspx',headers:{authorization:'DO_NOT_COPY'}}});
  await store.track([p],{now:NOW});const result=await store.ingest([p],{now:NOW});assert.equal(result.observationsWritten,1);
  const row=(await store.list({now:NOW}))[0];assert.equal(row.confirmed,true);assert.equal(row.product.price,199.95);
  for(const key of ['category_source','category_root','categorySource','categoryObservedAt','audience','audienceVerified','audienceSource','audienceObservedAt','qualityVerified','qualitySource','qualityObservedAt','provider','accessReference'])assert.deepEqual(row.product[key],p[key],key);
  assert.equal(row.product.context.authentication,'anonymous');assert.equal(row.product.sellerDiscountIsEvidence,false);
  assert.deepEqual(row.product.provenance,{provider:'operator-wb',accessReference:'approval-20261018',origin:'https://www.wildberries.ru'});
  const serialized=JSON.stringify(scalar(db,'SELECT latest,metadata,last_good FROM price_watch'));assert.equal(serialized.includes('DO_NOT_COPY'),false);
  assert.equal((await store.history(p,{now:NOW}))[0].price,199.95);
});

test('unknown, stale, conditional, unavailable or seller-only prices never enter real history',async t=>{
  const {store,db}=await fixture(t);const patches=[{priceContextConfirmed:false},{context:{...context,authentication:'unknown'}},
    {context:{...context,paymentBasis:'wallet'}},{stockObservedAt:null},{stockObservedAt:NOW-PRICE_LIMITS.maxAgeMs-1},
    {observedAt:NOW-PRICE_LIMITS.maxAgeMs-1},{observedAt:NOW+1},{available:false},{available:null},{priceSource:'seller_api'},
    {variantKey:'unknown'},{variantKey:'x'.repeat(101)},{priceCondition:'membership'},
    {variants:[{variantKey:'SKU-42',size:'42',price:199.95,available:false}]}];
  const products=patches.map((patch,i)=>quote(100+i,patch));await store.track(products,{now:NOW});const result=await store.ingest(products,{now:NOW});
  assert.equal(result.confirmed,0);assert.equal(count(db),0);assert.ok((await store.list({now:NOW})).every(row=>!row.confirmed&&row.product.price===null));
  assert.ok((await store.list({now:NOW})).some(row=>row.priceStatus==='unavailable'));
});

test('daily observations deduplicate exact variant/context while current checked price can update',async t=>{
  const {store,db}=await fixture(t);const p=quote();await store.track([p],{now:NOW});await store.ingest([p],{now:NOW});
  const changed=quote(123,{price:179.95,observedAt:NOW+100,stockObservedAt:NOW+100,variants:undefined});
  assert.equal((await store.ingest([changed],{now:NOW+100})).observationsWritten,0);
  assert.equal((await store.list({now:NOW+100}))[0].product.price,179.95);
  const variant=quote(123,{variantKey:'SKU-43',variants:undefined,observedAt:NOW+200,stockObservedAt:NOW+200});
  const region=quote(123,{context:{...context,destination:'-1029256'},observedAt:NOW+300,stockObservedAt:NOW+300});
  await store.ingest([variant],{now:NOW+200});await store.ingest([region],{now:NOW+300});assert.equal(count(db),3);
  assert.equal((await store.history(p,{now:NOW+400})).length,1);assert.equal((await store.history(variant,{now:NOW+400})).length,1);
  assert.equal((await store.history(region,{now:NOW+400})).length,1);
  assert.equal((await store.history({...p,context:{...context,paymentBasis:'wallet'}},{now:NOW+400})).length,0);
});

test('freshness is recalculated at read time; failure cannot erase or silently resurrect last-good history',async t=>{
  const {store,db}=await fixture(t);const p=quote();await store.track([p],{now:NOW});await store.ingest([p],{now:NOW});
  const stale=(await store.list({now:NOW+PRICE_LIMITS.maxAgeMs+1}))[0];assert.equal(stale.confirmed,false);assert.equal(stale.priceStatus,'stale');assert.equal(stale.product.price,null);assert.equal(stale.product.variants[0].price,null);
  const lease=await store.acquire('wb-card',{now:NOW});await store.finish('wb-card',lease.owner,{now:NOW+100,status:0,code:'TIMEOUT'});
  const replay=await store.ingest([p],{now:NOW+200});assert.equal(replay.updated,0);assert.equal(replay.rejected[0].reason,'OBSERVATION_PRECEDES_FAILURE');
  assert.equal((await store.list({now:NOW+200}))[0].confirmed,false);assert.equal(count(db),1);
  await store.ingest([quote(123,{observedAt:NOW+300,stockObservedAt:NOW+300})],{now:NOW+300});assert.equal((await store.list({now:NOW+300}))[0].confirmed,true);
  const late=await store.ingest([p],{now:NOW+400});assert.equal(late.updated,0);assert.equal(late.rejected[0].reason,'OLDER_THAN_LAST_GOOD');
  await store.ingest([quote(123,{priceContextConfirmed:false})],{now:NOW+500});
  assert.equal((await store.list({now:NOW+500}))[0].product.price,null);assert.equal(count(db),1);
});

test('history read is indexed, at most 28 exact-key points and 90-day retention cleanup is bounded',async t=>{
  const {db,store}=await fixture(t);const p=quote();await store.track([p],{now:NOW});const key=priceContextKey(context);
  const insert=db.sqlite.prepare('INSERT INTO price_observations VALUES(?,?,?,?,?,?,?)');
  for(let n=0;n<50;n++){const at=NOW-n*DAY;insert.run(p.id,p.variantKey,key,new Date(at).toISOString().slice(0,10),at,100+n,'wb_card');}
  const old=NOW-100*DAY;insert.run(p.id,p.variantKey,key,new Date(old).toISOString().slice(0,10),old,777,'wb_card');
  const points=await store.history(p,{now:NOW});assert.equal(points.length,28);assert.equal(points[0].at,NOW);assert.ok(points.every(row=>row.at>=NOW-90*DAY));
  const plan=db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT price FROM price_observations WHERE pid=? AND variant=? AND context=? AND day>=? AND day<=? ORDER BY day DESC LIMIT 28').all(p.id,p.variantKey,key,'2026-07-20','2026-10-18');
  assert.ok(plan.every(row=>!/SCAN |TEMP B-TREE/.test(row.detail)));
  const pruned=await store.ingest([],{now:NOW});assert.equal(pruned.historyPruned,1);assert.equal(count(db),50);
  assert.equal(scalar(db,'SELECT history_rows FROM price_store_stats').history_rows,50);
});

test('9000-row history cap is durable, index-evicts the oldest and duplicate keys never evict another point',async t=>{
  const {db,store}=await fixture(t);const p=quote();await store.track([p],{now:NOW});const key=priceContextKey(context),day='2026-10-18';
  const insert=db.sqlite.prepare('INSERT OR IGNORE INTO price_observations VALUES(?,?,?,?,?,?,?)');
  db.sqlite.exec('BEGIN');try{for(let n=0;n<9001;n++)insert.run(p.id,'sku-'+n,key,day,NOW+n,100,'wb_card');db.sqlite.exec('COMMIT');}catch(error){db.sqlite.exec('ROLLBACK');throw error;}
  assert.equal(count(db),9000);assert.equal(scalar(db,'SELECT history_rows FROM price_store_stats').history_rows,9000);
  assert.equal(scalar(db,'SELECT min(observed_at) at FROM price_observations').at,NOW+1);
  insert.run(p.id,'sku-9000',key,day,NOW+9000,100,'wb_card');assert.equal(count(db),9000);
  assert.equal(scalar(db,'SELECT min(observed_at) at FROM price_observations').at,NOW+1);
  const plan=db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT pid,variant,context,day FROM price_observations ORDER BY observed_at,pid,variant,context,day LIMIT 1').all();
  assert.ok(plan.some(row=>/price_observations_time/.test(row.detail)));assert.ok(plan.every(row=>!/TEMP B-TREE/.test(row.detail)));
});

test('20-product SQL ingestion is bounded below 50 queries and rejects untracked/source-mismatched cards',async t=>{
  const {store,db}=await fixture(t);const products=Array.from({length:20},(_,i)=>quote(i+1));await store.track(products,{now:NOW});
  db.queries.length=0;const outcome=await store.ingest(products,{now:NOW});assert.equal(outcome.confirmed,20);assert.equal(outcome.observationsWritten,20);assert.ok(db.queries.length<50);
  assert.ok(db.queries.length<=5,'JSON-batched inserts must not become one query per product');
  assert.equal((await store.ingest([quote(999)],{now:NOW})).rejected[0].reason,'UNTRACKED');
  assert.equal((await store.ingest([quote(1,{source:'unapproved-feed'})],{now:NOW})).rejected[0].reason,'SOURCE_MISMATCH');
  await assert.rejects(()=>store.ingest(Array.from({length:21},(_,i)=>quote(i+1)),{now:NOW}),/BATCH_INVALID/);
});

test('concurrent stale ingestion loses the SQL CAS and cannot report or store a second current confirmation',async t=>{
  const {store,db}=await fixture(t);await store.track([quote()],{now:NOW});
  const newer=quote(123,{price:149.95,variants:undefined,observedAt:NOW+10,stockObservedAt:NOW+10});
  const older=quote(123,{variants:undefined});
  const [fresh,stale]=await Promise.all([store.ingest([newer],{now:NOW+20}),store.ingest([older],{now:NOW+20})]);
  assert.equal(fresh.confirmed,1);assert.equal(stale.confirmed,0);assert.equal(stale.updated,0);assert.equal(stale.observationsWritten,0);
  assert.ok(stale.rejected.some(row=>row.reason==='STALE_AT_COMMIT'));
  const current=(await store.list({now:NOW+20}))[0];assert.equal(current.product.price,149.95);assert.equal(count(db),1);
});

test('direct trusted ingestion rejects conflicting or incomplete per-variant price contexts before sanitizing',async t=>{
  const {store,db}=await fixture(t),base=quote().variants[0];
  const conflict=[{context:{...context,destination:'-1029256'}},{currency:'USD'},{context:{...context,currency:'USD'}},
    {context:{...context,paymentBasis:'wallet'}},{context:{...context,authentication:'authenticated'}},
    {destination:'-1029256'},{paymentBasis:'wallet'},{authentication:'authenticated'},{context:{destination:context.destination}},{context:null}];
  const products=conflict.map((patch,i)=>quote(200+i,{variants:[{...base,...patch}]}));await store.track(products,{now:NOW});
  const result=await store.ingest(products,{now:NOW});assert.equal(result.confirmed,0);assert.equal(count(db),0);
  assert.ok(result.rejected.every(row=>row.reason==='VARIANT_CONTEXT_MISMATCH'));
  assert.ok((await store.list({now:NOW})).every(row=>!row.confirmed&&row.product.price===null));
  const matched=quote(999,{variants:[{...base,currency:'RUB',context:{...context}}],
    provenance:{origin:'operator_approved_retail_observer',provider:'approved-observer',authorizationReference:'owner-grant-20261018',source:'wb_page',observedAt:NOW}});
  await store.track([matched],{now:NOW});assert.equal((await store.ingest([matched],{now:NOW})).confirmed,1);
  const record=(await store.list({now:NOW})).find(row=>row.id===999);assert.deepEqual(record.product.variants[0].context,context);
  assert.equal(record.product.provenance.authorizationReference,'owner-grant-20261018');assert.equal(record.product.provenance.origin,'operator_approved_retail_observer');
});
