import test from 'node:test';import assert from 'node:assert/strict';
import {analysePricePool,analysePriceRecord,planBudgetSearch,catalogueEnvelope,SEARCH_QUERIES} from './analysis.mjs';
const NOW=Date.parse('2026-10-18T10:00:00Z'),DAY=86400000;
const offer=(id=12)=>({id,name:'Футболка хлопковая',title:'Футболка хлопковая',category:'Футболки',categoryVerified:true,category_source:'wb-cdn',categoryObservedAt:NOW,type:'tshirt',rating:4.9,reviews:120,qualityVerified:true,qualityObservedAt:NOW,price:150,oldPrice:9999,currency:'RUB',priceSource:'wb_page',observedAt:NOW,stockObservedAt:NOW,available:true,variantKey:String(id*100),priceCondition:'standard',priceContextConfirmed:true,context:{currency:'RUB',destination:'-1257786',paymentBasis:'standard',authentication:'anonymous'},image:'https://basket-01.wbbasket.ru/vol0/part0/'+id+'/images/big/1.webp',imageHash:'a'.repeat(64),variants:[{variantKey:String(id*100),price:150,size:'M',available:true,condition:'standard'}]});
const record=p=>({id:p.id,source:'approved-retail',metadata:p,product:p,confirmed:true,priceStatus:'confirmed'});
test('cheap price and crossed-out baseline never become a verified discount or Superfind',()=>{
 const r=analysePricePool([record(offer())],{now:NOW});assert.equal(r.confirmed,1);assert.equal(r.items[0].kind,'cheap');assert.equal(r.verifiedBargains.length,0);assert.equal(r.superfindState,'WAIT');assert.equal(r.items[0].sellerDiscountEvidence,false);assert.equal(r.autoPublication,false);
});
test('own-price anomaly uses actual matching observations across days; region/SKU mismatch is excluded',()=>{
 const p=offer(),history=[2,7,10].map(day=>({at:NOW-day*DAY,price:500,source:'wb_page',currency:'RUB',variantKey:p.variantKey,context:p.context}));
 let r=analysePriceRecord(record({...p,history}),{now:NOW,publication:{historyChecked:true,published:false}});assert.equal(r.kind,'own_price_drop');assert.equal(r.anomalousOwnDrop,true);assert.equal(r.superfind.eligible,true);assert.equal(r.superfind.autoPublication,false);
 r=analysePriceRecord(record({...p,history:history.map(h=>({...h,context:{...h.context,destination:'123585633'}}))}),{now:NOW});assert.equal(r.kind,'cheap');assert.equal(r.value.history.known,false);
 r=analysePriceRecord(record({...p,history:history.map(h=>({...h,variantKey:'different'}))}),{now:NOW});assert.equal(r.value.history.known,false);
});
test('price proof remains separate from quality; current PR14 bans and unverified metadata cannot be bypassed',()=>{
 const low=analysePriceRecord(record({...offer(),rating:3.1}),{now:NOW});assert.equal(low.confirmedPrice,150);assert.equal(low.kind,'rejected');assert.equal(low.superfind.eligible,false);
 const book=analysePriceRecord(record({...offer(),name:'Учебник химии',title:'Учебник химии',category:'Учебники'}),{now:NOW});assert.equal(book.kind,'rejected');assert.ok(book.rejectedReasons.some(x=>x.includes('Запрет владельца')));
 const stale=analysePriceRecord({...record(offer()),confirmed:false,priceStatus:'failed',product:{...offer(),price:null}},{now:NOW});assert.equal(stale.confirmedPrice,null);assert.equal(stale.superfind.eligible,false);
 assert.throws(()=>catalogueEnvelope({...offer(),priceContextConfirmed:false},{},{now:NOW}),/CATALOGUE_PROOF_INCOMPLETE/);
});
test('budget lanes include500, stay fashion-only and leave production policy untouched',()=>{
 assert.equal(planBudgetSearch(3*SEARCH_QUERIES.length).maxPrice,500);assert.ok(SEARCH_QUERIES.every(q=>!/книг|тетрад|канцеляр/.test(q)));assert.equal(planBudgetSearch(0).changesProductionPolicy,false);assert.throws(()=>planBudgetSearch(-1),/INVALID_SEARCH_CURSOR/);
});

 test('separate stock/quality freshness and canonical output prevent accidental stale promotion',()=>{
 for(const patch of [{stockObservedAt:undefined},{stockObservedAt:NOW-DAY},{stockObservedAt:NOW+1}]){const a=analysePriceRecord(record({...offer(),...patch}),{now:NOW});assert.equal(a.confirmedPrice,null);assert.equal(a.kind,'unconfirmed');}
 const a=analysePricePool([record({...offer(),qualityVerified:false}),record({...offer(13),rating:3})],{now:NOW});assert.equal(a.confirmed,2);assert.ok(a.tiers.every(t=>t.items.length===0));
 const personal=analysePriceRecord(record({...offer(),context:{...offer().context,authentication:'personal'}}),{now:NOW});assert.equal(personal.confirmedPrice,null);assert.equal(personal.priceStatus,'unconfirmed');
 const b=analysePriceRecord(record({...offer(),image:'data:text/html,test',url:'javascript:alert(1)'}),{now:NOW});assert.equal(b.image,null);assert.equal(b.url,'https://www.wildberries.ru/catalog/12/detail.aspx');
 });
test('stale or unverified peers cannot create a bargain for an otherwise good candidate',()=>{
 const base={...offer(),price:150,priceBasis:'unit',packCount:1};base.variants[0].price=150;
 const peers=Array.from({length:5},(_,n)=>{const p={...offer(20+n),price:200,priceBasis:'unit',packCount:1,qualityVerified:false,qualityObservedAt:NOW-DAY,stockObservedAt:NOW-DAY};p.variants[0].price=200;return record(p);});
 const out=analysePricePool([record(base),...peers],{now:NOW,publication:{historyChecked:true,published:false}});
 assert.equal(out.items[0].kind,'cheap');assert.equal(out.items[0].value.market.known,false);assert.equal(out.items[0].superfind.eligible,false);
 for(const patch of [{stockObservedAt:NOW-DAY},{qualityObservedAt:NOW-DAY},{qualityVerified:false},{categoryVerified:false},{context:{...base.context,authentication:'personal'}}])assert.throws(()=>catalogueEnvelope({...base,...patch},{bytes:new Uint8Array(32),sourceUrl:base.image,observedAt:NOW},{now:NOW}),/CATALOGUE_PROOF_INCOMPLETE/);
});
