// Isolated real SQLite and synthetic HTTP responses only. No WB, Telegram,
// Cloudflare production, subscriber data or live posting is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cardDeal,nativeTick,bootstrap,checkAutopost} from './native_scheduler.mjs';
import {adminEnvironment} from './admin_test_support.mjs';
import {DEFAULT_SCHEDULE} from './scheduler_api.mjs';
const photo=id=>`https://basket-01.wbbasket.ru/vol0/part1/${id}/images/big/1.webp`;
const card=(id=1000,sizes)=>({id,name:'Футболка хлопковая '+id,brand:'Fixture',subjectName:'Футболки',reviewRating:4.8,feedbacks:100,
  sizes:sizes??[{chrtId:700000+id,name:'42',qty:5,price:{product:70099,basic:100000}}]});
const queued=(id=1000)=>({id,title:'Футболка хлопковая '+id,product:700.99,basic:700.99,rating:4.8,feedbacks:100,
  image:photo(id),category:'Футболки',query:'футболка мужская'});
const receipt=(patch={})=>({receivedAt:Date.now()-1,status:200,method:'GET',kind:'details',requestedContext:{currency:'RUB',destination:'-1257786',spp:'30',paymentBasis:'unknown',authentication:'anonymous'},...patch});
async function fixture(t,queue=[queued()]){
  const env=await adminEnvironment(t);
  await bootstrap(env,{queue,posts:[],policy:{chat_id:'-1234567',queries:['футболка мужская'],max_price:1000,min_rating:4.3,min_feedbacks:20}});
  env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,post_interval_minutes:30,search_enabled:false}));
  return env;
}
const state=env=>JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
const saved=env=>env.db.prepare('SELECT data,checked_at,retry_at FROM scheduler_inventory WHERE pid=1000').get();
const live=(calls,{raw=card(),status=200,send}={})=>async(url,options)=>{
  calls.push(url);
  if(url.includes('sendPhoto')){send?.(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:701}});}
  if(url.includes('wbbasket.ru'))return new Response('local-photo',{headers:{'Content-Type':'image/webp'}});
  if(url.includes('getMe'))return Response.json({ok:true,result:{id:1}});
  if(url.includes('card.wb.ru'))return status===200?Response.json({products:[raw]}):new Response('DO_NOT_LOG_BODY',{status});
  if(url.includes('search.wb.ru'))return Response.json({products:[raw]});
  throw Error('NETWORK_FORBIDDEN');
};

test('same stable available SKU supplies exact kopecks; absent cheapest and unknown/conflicting stock cannot pass',()=>{
  const sizes=[{chrtId:1,name:'40',qty:0,price:{product:10000,basic:90000}},
    {chrtId:2,name:'42',qty:5,price:{product:20095,basic:90000}}];
  const p=cardDeal(card(1000,sizes),{},receipt());assert.equal(p.product,200.95);assert.equal(p.price,200.95);assert.equal(p.variantKey,'2');
  assert.equal(p.size,'42');assert.equal(p.available,true);assert.equal(p.priceStatus,'api_observed');assert.equal(p.context.paymentBasis,'unknown');
  assert.equal(p.retailConfirmed,false);assert.equal(p.retailPriceConfirmed,false);assert.equal(p.priceContextConfirmed,false);
  for(const bad of [
    [{chrtId:1,name:'42',price:{product:10000}}],
    [{chrtId:1,name:'42',qty:0,price:{product:10000}}],
    [{name:'42',qty:5,price:{product:10000}}],
    [{chrtId:1,name:'42',qty:0,stocks:[{qty:5}],price:{product:10000}}],
    [{chrtId:1,name:'42',qty:5,stocks:[{qty:0}],price:{product:10000}}]
  ])assert.equal(cardDeal(card(1000,bad),{},receipt()),null);
  const stockRows=cardDeal(card(1000,[{sizeId:3,name:'44',stocks:[{qty:2}],price:{product:10001}}]),{},receipt());
  assert.equal(stockRows.product,100.01);assert.equal(stockRows.variantKey,'3');
  assert.equal(cardDeal(card(1000,[{chrtId:1,name:'42',qty:0,price:{product:10000}},
    {chrtId:1,name:'42',qty:5,price:{product:20000}}]),{},receipt()),null);
});

test('pure cardDeal and search receipts cannot manufacture a details-price observation or buyer confirmation',()=>{
  const pure=cardDeal(card());assert.equal(pure.priceStatus,'unconfirmed');assert.equal(pure.priceObservedAt,null);
  assert.equal(pure.observedAt,null);assert.equal(pure.stockObservedAt,null);assert.equal(pure.context,null);assert.equal(pure.retailConfirmed,false);
  assert.equal(pure.variants[0].context,null);assert.equal(pure.variants[0].currency,null);
  const search=cardDeal(card(),{},receipt({kind:'search'}));assert.equal(search.priceSource,'wb_search');assert.equal(search.priceProvenance.kind,'search');
  assert.equal(search.retailConfirmed,false);assert.equal(search.priceContextConfirmed,false);
  const stale=cardDeal(card(),{},receipt({receivedAt:Date.now()+3600000}));assert.equal(stale.priceStatus,'unconfirmed');
});

test('403 and timeout never rejuvenate a 13-hour cached price or publish it; failure attempts have separate timestamps',async t=>{
  const original=Date.now()-13*3600000;
  const cached={...queued(),price:700.99,priceObservedAt:original,observedAt:original,stockObservedAt:original,
    priceStatus:'api_observed',fallback:false,retailConfirmed:false,variantKey:'701000',priceProvenance:{kind:'details'}};
  const env=await fixture(t,[cached]);const checked=Math.floor((Date.now()-1000)/1000);
  env.db.prepare('UPDATE scheduler_inventory SET checked_at=?').run(checked);
  const calls=[];const first=await nativeTick(env,Date.now(),live(calls,{status:403}));
  assert.equal(first.results.post.result,'no_eligible_product');assert.equal(calls.some(url=>url.includes('sendPhoto')),false);
  let row=saved(env),data=JSON.parse(row.data);assert.equal(row.checked_at,checked);assert.equal(data.priceObservedAt,original);
  assert.equal(data.observedAt,original);assert.equal(data.stockObservedAt,original);assert.equal(data.fallback,true);assert.equal(data.priceStatus,'unconfirmed');
  assert.ok(data.validationAttemptAt>original);assert.ok(data.validationFailedAt>=data.validationAttemptAt);assert.equal(data.retailConfirmed,false);
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.post_retry_at',0)").run();env.db.prepare('UPDATE scheduler_inventory SET retry_at=0').run();
  const next=await nativeTick(env,Date.now(),async url=>{assert.match(url,/card\.wb\.ru/);throw Error('secret timeout payload must not be stored');});
  assert.equal(next.results.post.result,'no_eligible_product');row=saved(env);data=JSON.parse(row.data);
  assert.equal(row.checked_at,checked);assert.equal(data.priceObservedAt,original);assert.equal(data.validation_error,'WB unavailable');
  assert.equal(data.priceStatus,'unconfirmed');assert.equal(data.fallback,true);assert.equal(env.db.prepare('SELECT count(*) n FROM scheduler_posts').get().n,0);
  assert.equal(JSON.stringify(data).includes('secret timeout'),false);assert.equal(JSON.parse(env.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
});

test('a recent cache also fails closed; a separate successful live response restores API quote without buyer-price claims',async t=>{
  const original=Date.now()-1000,env=await fixture(t,[{...queued(),priceObservedAt:original,observedAt:original,stockObservedAt:original}]);
  env.db.prepare('UPDATE scheduler_inventory SET checked_at=?').run(Math.floor(original/1000));
  const failed=[];await nativeTick(env,Date.now(),live(failed,{status:429}));assert.equal(failed.some(url=>url.includes('sendPhoto')),false);
  assert.equal(JSON.parse(saved(env).data).priceObservedAt,original);
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.post_retry_at',0)").run();env.db.prepare('UPDATE scheduler_inventory SET retry_at=0').run();
  let caption;const calls=[];const result=await nativeTick(env,Date.now(),live(calls,{send:body=>{caption=body.caption;}}));
  assert.equal(result.results.post.result,'success');assert.equal(calls.filter(url=>url.includes('card.wb.ru')).length,1);
  assert.match(caption,/Цена из ответа WB/);assert.match(caption,/700\.99/);assert.match(caption,/42/);assert.match(caption,/размера, региона и условий оплаты/);
  assert.doesNotMatch(caption,/Сейчас|Цена проверена/);
  const published=JSON.parse(env.db.prepare('SELECT data FROM scheduler_deliveries').get().data);
  assert.equal(published.priceStatus,'api_observed');assert.equal(published.fallback,false);assert.ok(published.priceObservedAt>original);
  assert.equal(published.priceObservedAt,published.stockObservedAt);assert.equal(published.retailConfirmed,false);assert.equal(published.context.paymentBasis,'unknown');
});

test('unavailable WB stops this publication cycle after one request even with several recent cached candidates',async t=>{
  for(const failure of ['403','timeout']){
    const original=Date.now()-1000,queue=[1000,1001,1002].map(id=>({...queued(id),priceObservedAt:original,stockObservedAt:original}));
    const env=await fixture(t,queue),calls=[];
    env.db.prepare('UPDATE scheduler_inventory SET checked_at=?').run(Math.floor(original/1000));
    const result=await nativeTick(env,Date.now(),async url=>{calls.push(url);assert.match(url,/card\.wb\.ru/);if(failure==='timeout')throw Error('fixture timeout');return new Response('fixture denied',{status:403});});
    assert.equal(result.results.post.result,'no_eligible_product');assert.equal(calls.length,1);
    assert.equal(env.db.prepare('SELECT count(*) n FROM scheduler_posts').get().n,0);
    assert.equal(env.db.prepare("SELECT count(*) n FROM scheduler_inventory WHERE json_extract(data,'$.fallback')=1").get().n,1);
    const rows=env.db.prepare('SELECT data,checked_at FROM scheduler_inventory').all();
    assert.ok(rows.every(row=>row.checked_at===Math.floor(original/1000)&&JSON.parse(row.data).priceObservedAt===original));
  }
});


test('read-only check requires an actual details response and creates no Telegram post',async t=>{
  const env=await fixture(t),calls=[];
  const result=await checkAutopost(env,live(calls));
  assert.equal(result.live_card,true);assert.equal(result.priceStatus,'api_observed');assert.equal(result.retailConfirmed,false);
  assert.equal(calls.some(url=>url.includes('sendPhoto')),false);
  const failure=await checkAutopost(env,live([],{status:403}));assert.equal(failure.live_card,false);assert.equal(failure.ok,false);
  assert.equal(env.db.prepare('SELECT count(*) n FROM scheduler_posts').get().n,0);assert.equal(state(env).last_post_success??null,null);
});

test('actual details JSON must finish before the recorded price/stock observation timestamp',async t=>{
  const env=await fixture(t),calls=[],fetcher=live(calls);let completedAt=0;
  const result=await nativeTick(env,Date.now(),async(url,options)=>{
    if(url.includes('card.wb.ru'))return {ok:true,status:200,async json(){await Promise.resolve();completedAt=Date.now();return {products:[card()]};}};
    return fetcher(url,options);
  });
  assert.equal(result.results.post.result,'success');
  const published=JSON.parse(env.db.prepare('SELECT data FROM scheduler_deliveries').get().data);
  assert.ok(published.priceObservedAt>=completedAt);assert.equal(published.stockObservedAt,published.priceObservedAt);
  assert.equal(published.fallback,false);assert.equal(published.priceProvenance.kind,'details');
});
