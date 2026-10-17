// Synthetic observations and image fixture: never a report of live WB prices.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LocalD1} from '../features/local_d1.mjs';
import {ADAPTER_SCHEMA,ingestVerifiedProducts} from '../features/catalogue_adapter.mjs';
import {stylePriceEvidence} from '../features/subscriber_taste.mjs';
import {openPriceStore} from './store.mjs';
import {normalizeApprovedObservation,createWBPriceSource} from './source.mjs';
import {catalogueEnvelope} from './analysis.mjs';
import {pricePreview,refreshWatched,discoverProspects} from './service.mjs';
import {cardDeal} from '../cloudflare/native_scheduler.mjs';
const NOW=Date.parse('2026-10-18T10:00:00Z'),DAY=86400000,ID='isolated-prices-e2e';
const bytes=new Uint8Array([82,73,70,70,24,0,0,0,87,69,66,80,86,80,56,76,11,0,0,0,47,63,0,15,0,7,208,255,254,247,191,255]);
function observation(id,at=NOW,price=150){return {id,name:'Fixture футболка хлопковая',category:'Футболки',category_source:'wb-cdn',categoryVerified:true,categoryObservedAt:at,
 url:`https://www.wildberries.ru/catalog/${id}/detail.aspx`,image:`https://basket-01.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`,
 audience:'men',audienceVerified:true,audienceSource:'wb_cdn_metadata',audienceObservedAt:at,type:'tshirt',qualityVerified:true,qualityObservedAt:at,rating:4.9,reviews:120,
 price,oldPrice:9999,currency:'RUB',priceSource:'wb_page',observedAt:at,stockObservedAt:at,available:true,variantKey:String(id*100),priceCondition:'standard',
 context:{currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'},variants:[{variantKey:String(id*100),size:'M',price,available:true,condition:'standard'}]};}
const approved=p=>normalizeApprovedObservation(p,{authorizationReference:'fixture-reviewed-source',provider:'fixture-only',now:p.observedAt});
async function fixture(t){const db=new LocalD1();t.after(()=>db.close());const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:ID,PRICE_DB:db,DB:{prepare(){throw Error('PRODUCTION_FORBIDDEN');}}};const store=openPriceStore(env,{approvedDatabaseId:ID});await store.init();return {db,store,env};}
test('discovery preserves quality/bans and cannot promote an unavailable cheap SKU or search quote',async t=>{
 const {store}=await fixture(t),raw={id:12,name:'Футболка хлопковая',subjectName:'Футболки',reviewRating:4.9,feedbacks:120,sizes:[{chrtId:1201,name:'S',qty:0,price:{product:10000,basic:90000}},{chrtId:1202,name:'M',qty:3,price:{product:24999,basic:90000}}]};
 assert.equal(cardDeal(raw,{max_price:200}).product,100); // Current legacy behaviour, not a real WB price.
 const source={readOnly:true,name:'wb-card',context:{currency:'RUB',destination:'-1257786',paymentBasis:'unknown'},search:async()=>({products:[raw,{...raw,id:13,name:'Учебник',subjectName:'Учебники'},{...raw,id:14,reviewRating:3}]})};
 const r=await discoverProspects({store,source,enabled:true,cursor:0,now:()=>NOW});assert.equal(r.prospects,0); // <=100 lane: the available SKU costs249.99.
 const r2=await discoverProspects({store,source,enabled:true,cursor:100,higherPriceWatch:true,now:()=>NOW+1200001});assert.equal(r2.prospects,1);assert.equal(r2.priceConfirmed,0);
 const p=(await pricePreview(store,{now:NOW+1200001}));assert.equal(p.confirmed,0);assert.equal(p.superfindState,'WAIT');
});
test('disabled invocation performs no I/O; source403 survives reopening with zero retry calls',async t=>{
 const {store,env}=await fixture(t);let calls=0;await store.track([{...observation(12),source:'wb-card'}],{now:NOW});
 const source=createWBPriceSource({fetcher:async()=>{calls++;return new Response('private-error-body',{status:403});},now:()=>NOW});
 assert.equal((await refreshWatched({store,source})).status,'disabled');assert.equal(calls,0);
 const r=await refreshWatched({store,source,enabled:true,now:()=>NOW});assert.equal(r.http,403);assert.doesNotMatch(JSON.stringify(r),/private-error/);
 const reopened=openPriceStore(env,{approvedDatabaseId:ID});await refreshWatched({store:reopened,source,enabled:true,now:()=>NOW+DAY});assert.equal(calls,1);assert.equal((await pricePreview(reopened,{now:NOW+DAY})).confirmed,0);
});
test('full100card preview bounds history queries to20 and accepts an explicit batch',async t=>{
 const {store,db}=await fixture(t);const rows=Array.from({length:100},(_,i)=>approved(observation(i+12)));
 await store.track(rows,{now:NOW});for(let n=0;n<100;n+=20)await store.ingest(rows.slice(n,n+20),{now:NOW});
 db.queries=[];const r=await pricePreview(store,{now:NOW,historyIds:rows.slice(80).map(p=>p.id)});assert.equal(r.confirmed,100);assert.equal(db.queries.length,21);
 await assert.rejects(pricePreview(store,{now:NOW,historyIds:rows.map(p=>p.id)}),/PREVIEW_HISTORY_BATCH_LIMIT/);
});
test('20 approved observations traverse watch/refresh/history/analysis; handoff reuses the existing catalogue adapter',async t=>{
 const {store}=await fixture(t);let clock=NOW-10*DAY,calls=0;
 await store.track(Array.from({length:20},(_,n)=>({...observation(n+12,clock),source:'approved-retail'})),{now:clock});
 const source={readOnly:true,name:'approved-retail',async details(ids){calls++;return {products:ids.map(id=>approved(observation(id,clock,clock===NOW?150:500)))};}};
 for(const at of [NOW-10*DAY,NOW-7*DAY,NOW-2*DAY,NOW]){clock=at;const r=await refreshWatched({store,source,enabled:true,now:()=>clock});assert.equal(r.status,'ok');assert.equal(r.preview.confirmed,20);assert.equal(r.publication,'NONE');}
 assert.equal(calls,4);const preview=await pricePreview(store,{now:NOW});assert.equal(preview.verifiedBargains.length,20);assert.equal(preview.items[0].kind,'own_price_drop');assert.equal(preview.autoPublication,false);assert.equal(preview.superfindState,'WAIT');
 const record=(await store.list({now:NOW}))[0],p=record.product;p.history=await store.history(p,{now:NOW});
 assert.equal(p.accessReference,'fixture-reviewed-source');assert.equal(p.provenance.origin,'https://www.wildberries.ru');
 const entry=catalogueEnvelope(p,{bytes,sourceUrl:p.image,observedAt:NOW},{now:NOW});
 const catalog=new LocalD1();t.after(()=>catalog.close());catalog.exec(await readFile(new URL('../features/schema.sql',import.meta.url),'utf8'));catalog.exec(ADAPTER_SCHEMA);
 const result=await ingestVerifiedProducts(catalog,[entry],{enabled:true,now:NOW});assert.equal(result.status,'ok');assert.equal(result.added,1);
 const saved=JSON.parse(catalog.sqlite.prepare('SELECT data FROM feature_catalog WHERE id=?').get(p.id).data);
 assert.equal(saved.category,'Футболки');assert.equal(saved.audience,'men');assert.equal(saved.audienceVerified,true);assert.equal(saved.qualityVerified,true);assert.equal(stylePriceEvidence(saved,NOW).confirmed,true);assert.equal(saved.history.length,4);
 assert.match(saved.imageHash,/^[a-f0-9]{64}$/);assert.match(saved.displayImage,/^\/style-images\//);
 for(const patch of [{stockObservedAt:NOW-3660000},{qualityObservedAt:NOW-3660000}])assert.throws(()=>catalogueEnvelope({...p,...patch},{bytes,sourceUrl:p.image,observedAt:NOW},{now:NOW}),/CATALOGUE_PROOF_INCOMPLETE/);
});
