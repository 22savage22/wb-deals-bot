import test from 'node:test';import assert from 'node:assert/strict';
import {createWBPriceSource,normalizeApprovedObservation} from './source.mjs';
const NOW=Date.parse('2026-10-18T10:00:00Z');
const card=()=>({id:12,name:'Футболка хлопковая',subjectName:'Футболки',reviewRating:4.8,feedbacks:100,sizes:[{chrtId:1201,name:'S',qty:0,price:{product:10000,basic:90000}},{chrtId:1202,name:'L',qty:3,price:{product:24999,basic:90000}}]});
test('WB adapter reuses available-SKU normalizer, preserves kopecks and unknown retail conditions',async()=>{
  let requests=0;const source=createWBPriceSource({now:()=>NOW,fetcher:async(url,options)=>{requests++;assert.equal(new URL(url).hostname,'card.wb.ru');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);return Response.json({products:[card()]});}});
  const result=await source.details([12]),p=result.products[0];assert.equal(requests,1);assert.equal(p.price,249.99);assert.equal(p.variantKey,'1202');assert.equal(p.stockObservedAt,NOW);assert.equal(p.available,true);assert.equal(p.retailPriceConfirmed,false);assert.equal(p.priceContextConfirmed,false);assert.equal(p.context.paymentBasis,'unknown');assert.equal(p.sellerDiscountIsEvidence,false);
});
test('403/429/redirect do not trigger fallback requests or expose error body',async()=>{
  for(const status of [403,429,302]){let calls=0;const source=createWBPriceSource({now:()=>NOW,fetcher:async()=>{calls++;return new Response('raw-upstream-must-not-be-logged',{status,headers:{'content-type':'text/html','retry-after':'3600'}});}});await assert.rejects(source.details([12]),e=>{assert.equal(e.status,status);assert.equal(e.retryAfterMs,3600000);assert.doesNotMatch(JSON.stringify(e),/raw-upstream/);return true;});assert.equal(calls,1);}
});
test('IDs, duplicates, HTML success and wrong metadata identity fail before being price evidence',async()=>{
  let calls=0;const source=createWBPriceSource({now:()=>NOW,fetcher:async()=>{calls++;return new Response('<html>challenge</html>',{headers:{'content-type':'text/html'}});}});
  await assert.rejects(source.details([12,12]),/INVALID_DETAIL_IDS/);await assert.rejects(source.details(Array.from({length:21},(_,i)=>i+1)),/INVALID_DETAIL_IDS/);assert.equal(calls,0);await assert.rejects(source.details([12]),/SOURCE_NOT_JSON/);
  const bad=createWBPriceSource({fetcher:async()=>Response.json({nm_id:13,subj_name:'Футболки'})});await assert.rejects(bad.metadata({id:12,image:'https://basket-01.wbbasket.ru/vol0/part0/12/images/big/1.webp'}),/METADATA_PRODUCT_MISMATCH/);
});
test('operator retail observation requires external approval and exact anonymous standard context',()=>{
  const p={id:12,name:'Футболка',url:'https://www.wildberries.ru/catalog/12/detail.aspx',currency:'RUB',price:150,available:true,priceSource:'wb_page',observedAt:NOW,stockObservedAt:NOW,variantKey:'1202',context:{currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'},priceCondition:'standard',variants:[{variantKey:'1202',price:150,available:true,condition:'standard'}]};
  const options={authorizationReference:'verified-operator-session-reference',provider:'own-observer',now:NOW};assert.equal(normalizeApprovedObservation(p,options).priceContextConfirmed,true);assert.throws(()=>normalizeApprovedObservation(p,{now:NOW}),/APPROVED_SOURCE_REQUIRED/);
  for(const mutation of [{context:{...p.context,paymentBasis:'wallet'}},{context:{...p.context,authentication:'personal'}},{observedAt:NOW+1},{stockObservedAt:NOW-3600001},{available:false},{priceSource:'seller_api'},{priceCondition:'club'},{url:'https://www.wildberries.ru.evil.invalid/catalog/12/detail.aspx'}])assert.throws(()=>normalizeApprovedObservation({...p,...mutation},options),/INVALID_RETAIL_OBSERVATION/);
});

test('a selected variant cannot contradict parent payment, auth, currency or region',()=>{
 const p={id:12,name:'Футболка',url:'https://www.wildberries.ru/catalog/12/detail.aspx',currency:'RUB',price:150,available:true,priceSource:'wb_page',observedAt:NOW,stockObservedAt:NOW,variantKey:'1202',context:{currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'},priceCondition:'standard',variants:[{variantKey:'1202',price:150,available:true,condition:'standard'}]};
 for(const patch of [{paymentBasis:'wallet'},{authentication:'personal'},{currency:'USD'},{destination:'123585633'}])assert.throws(()=>normalizeApprovedObservation({...p,variants:[{...p.variants[0],context:{...p.context,...patch}}]},{authorizationReference:'verified-reference',provider:'own',now:NOW}),/INVALID_RETAIL_OBSERVATION/);
});
