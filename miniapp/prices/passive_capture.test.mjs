import test from 'node:test';import assert from 'node:assert/strict';
import {sanitizePassiveResponse,createPassiveObserver} from './passive_capture.mjs';
const NOW=Date.now(),RUN='reviewed_capture_20',URL='https://card.wb.ru/cards/v4/detail?curr=rub&dest=-1257786&spp=30&nm=12';
const card={id:12,name:'Футболка',reviewRating:4.9,feedbacks:120,sizes:[{chrtId:1201,name:'S',qty:0,price:{product:10000,basic:90000}},{chrtId:1202,name:'M',qty:3,price:{product:24999,basic:90000}}]};
const event=()=>({url:URL,kind:'details',method:'GET',receivedAt:NOW,status:200,products:[structuredClone(card)],headers:{Authorization:'never-forward',Cookie:'never-forward'},raw:'never-forward'});
const flags=()=>({PRICE_OBSERVATION_ENABLED:'1',PRICE_OBSERVATION_RUN_ID:RUN,PRICE_OBSERVATION_STARTED_AT:String(NOW-1000),PRICE_OBSERVATION_EXPIRES_AT:String(NOW+3600000)});
test('only existing detail receipts survive; exact availableSKU/kopecks, requested context is not confirmed retail',()=>{
 const p=sanitizePassiveResponse(event(),{runId:RUN,now:NOW,eventId:'event_test_001'});
 assert.equal(p.offers[0].price,249.99);assert.equal(p.offers[0].variantKey,'1202');assert.equal(p.offers[0].available,true);assert.equal(p.offers[0].priceObservedAt,NOW);
 assert.equal(p.offers[0].verificationStatus,'api_observed');assert.equal(p.offers[0].retailConfirmed,false);assert.equal(p.offers[0].context,null);assert.equal(p.requestedContext.paymentBasis,'unknown');
 assert.doesNotMatch(JSON.stringify(p),/never-forward|Authorization|Cookie|headers|raw/);
 for(const patch of [{kind:'search'},{receivedAt:NOW+1},{receivedAt:NOW-300001},{url:'https://untrusted.invalid'},{method:'POST'}])assert.equal(sanitizePassiveResponse({...event(),...patch},{runId:RUN,now:NOW}),null);
 const denied=sanitizePassiveResponse({...event(),status:403,products:[]},{runId:RUN,now:NOW});assert.equal(denied.offers[0].price,null);assert.equal(denied.outcome,'error');
 const unknown={...structuredClone(card),sizes:[{name:'unknown-SKU',qty:2,price:{product:10000}},structuredClone(card.sizes[1])]};
 assert.equal(sanitizePassiveResponse({...event(),products:[unknown]},{runId:RUN,now:NOW}).offers[0].price,249.99);
 const dup={...structuredClone(card),sizes:[structuredClone(card.sizes[1]),{...structuredClone(card.sizes[1]),qty:0,price:{product:10000}}]};
 assert.equal(sanitizePassiveResponse({...event(),products:[dup]},{runId:RUN,now:NOW}).offers[0].verificationStatus,'unconfirmed');
});
test('OFF/expiry/missingprivatebinding touches no DB, service or waitUntil; search ignored',()=>{
 let calls=0;const DB={prepare(){throw Error('PRODUCTION_DB_FORBIDDEN');}},ctx={waitUntil(){calls++;}};
 for(const e of [{},{...flags(),PRICE_OBSERVATION_ENABLED:'0'},{...flags(),PRICE_OBSERVATION_EXPIRES_AT:String(NOW-1)},flags()])assert.equal(createPassiveObserver({...e,DB},ctx,{now:()=>NOW}),undefined);
 const observer=createPassiveObserver({...flags(),DB,PRICE_OBSERVER:{fetch(){calls++;throw Error('MUST_NOT_CALL');}}},ctx,{now:()=>NOW});
 observer({...event(),kind:'search'});assert.equal(calls,0);
});
test('delivery uses only private binding, no retry; service failures never throw into source/Cron',async()=>{
 const waits=[];let calls=0;const ctx={waitUntil:p=>waits.push(p)};
 const o=createPassiveObserver({...flags(),PRICE_OBSERVER:{async fetch(request){calls++;assert.equal(request.url,'https://price-observer.internal/capture');const p=await request.json();assert.equal(p.offers[0].price,249.99);throw Error('no-secret-error');}}},ctx,{now:()=>NOW});
 assert.doesNotThrow(()=>o(event()));await Promise.all(waits);assert.equal(calls,1);
 const pending=[];let okCalls=0;const done=createPassiveObserver({...flags(),PRICE_OBSERVER:{async fetch(){okCalls++;return Response.json({status:'complete',accepted:20});}}},{waitUntil:p=>pending.push(p)},{now:()=>NOW});
 done(event());await Promise.all(pending);done(event());assert.equal(okCalls,1);
});
