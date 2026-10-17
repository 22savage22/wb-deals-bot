// Local synthetic fixtures only. These are NOT two real Telegram accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {LocalD1} from './local_d1.mjs';
import {account,filters,styleMe,styleFeed,mutate,forgetSubscriber} from './store.mjs';
import {emptySubscriber,applySubscriberVote,subscriberFeatures,personalDeck,styleScore,stylePriceEvidence} from './subscriber_taste.mjs';
const NOW=Date.now(),DAY=86400000,context={currency:'RUB',destination:'-1257786',paymentBasis:'standard'};
const photo=id=>id.toString(16).padStart(64,'0');
const card=(id,patch={})=>({id,name:`Синтетическая футболка товар${id}`,category:'Футболки',categoryVerified:true,type:'tshirt',
  price:800,currency:'RUB',priceSource:'wb_card',observedAt:NOW,stockObservedAt:NOW,available:true,context,variantKey:'size40',
  rating:4.8,reviews:150,image:`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`,imageHash:photo(id),...patch});
const visual=(p,fields)=>({nmId:p.id,imageHash:p.imageHash,group:'apparel',reviewed:true,cacheVerified:true,
  fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,confidence:1,evidence:'Clearly visible synthetic test fixture'}]))});
async function fixture(){
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const products=[card(1,{audience:'women'}),card(2,{audience:'men'}),card(3,{audience:'neutral',category:'Кеды'}),card(4,{audience:'unknown',category:'Сумки'})].map(product=>({product,visual:null}));
  for(const {product:p} of products)await db.prepare('INSERT INTO feature_catalog(id,data,visual,checked_at) VALUES(?,?,?,?)').bind(p.id,JSON.stringify(p),'null',NOW).run();
  await db.prepare("INSERT INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind(JSON.stringify({products})).run();
  return {db,products};
}
const vote=(version,id=1,action='like',requestId='subscriber-backend-vote')=>({version,id,action,requestId});
test('audience/multiple category contract is strict, bounded and backward compatible',()=>{
  assert.deepEqual(filters({}),{audience:'all',groups:[]});
  assert.deepEqual(filters({group:'shoes'}),{audience:'all',groups:['shoes'],group:'shoes'});
  assert.deepEqual(filters({audience:'women',groups:['accessories','clothing','clothing']}),{audience:'women',groups:['clothing','accessories']});
  for(const input of [{groups:'shoes'},{groups:['home']},{audience:'children'},{group:'shoes',groups:['bags']},{minPrice:100,maxPrice:1},{groups:['clothing','shoes','bags','accessories','shoes']},{defaults:true}])assert.throws(()=>filters(input),/Некоррект|Конфликт|Минимальная/);
});
test('opening shows normalized defaults without configuring or inserting the account',async()=>{
  const {db}=await fixture();try{const me=await styleMe(db,11);assert.equal(me.filtersConfigured,false);assert.deepEqual(me.filters,{audience:'all',groups:[]});assert.equal(db.sqlite.prepare('SELECT count(*) n FROM style_accounts').get().n,0);
    const result=await mutate(db,11,{version:0,requestId:'subscriber-filter-first',filters:{audience:'women',groups:['clothing','shoes']}},'filters');
    assert.equal(result.profile.filtersConfigured,true);assert.equal(result.version,1);assert.equal((await styleMe(db,11)).filters.audience,'women');assert.equal((await styleMe(db,22)).filtersConfigured,false);
    const feed=await styleFeed(db,11,{now:NOW});assert.deepEqual(new Set(feed.items.map(p=>p.id)),new Set([1,3]));
  }finally{db.close();}
});
test('unknown audience is not guessed from titles; neutral fits both audiences and filters intersect',()=>{
  const products=[card(1,{name:'Женская красная футболка',audience:'unknown'}),card(2,{audience:'women'}),card(3,{audience:'men'}),card(4,{audience:'neutral',category:'Кеды'}),card(5,{audience:'women',audienceVerified:false})];
  const ids=(filter)=>personalDeck(products,emptySubscriber(),{filters:filter,now:NOW}).map(p=>p.id).sort();
  assert.deepEqual(ids({audience:'women'}),[2,4]);assert.deepEqual(ids({audience:'men'}),[3,4]);assert.deepEqual(ids({audience:'neutral'}),[4]);assert.deepEqual(ids({audience:'women',groups:['clothing']}),[2]);assert.equal(ids({audience:'all'}).length,5);
});
test('price and learned budget require fresh stock, explicit variant and unconditional standard context',()=>{
  const p=card(1);assert.equal(stylePriceEvidence(p,NOW).confirmed,true);assert.ok(Object.keys(subscriberFeatures(p,null,NOW)).some(key=>key.startsWith('budget=')));
  for(const patch of [{stockObservedAt:undefined},{stockObservedAt:NOW-2*DAY},{stockObservedAt:NOW+1},{available:null},{priceSource:'legacy_snapshot'},{priceCondition:'club'},{context:{...context,paymentBasis:'wallet'}},{variantKey:'unknown'},{variants:[{available:true,price:999,variantKey:'size40'}]}]){
    const bad=card(2,patch),item=personalDeck([bad],emptySubscriber(),{now:NOW})[0];assert.equal(stylePriceEvidence(bad,NOW).confirmed,false,JSON.stringify(patch));
    assert.ok(!Object.keys(subscriberFeatures(bad,null,NOW)).some(key=>key.startsWith('budget=')),JSON.stringify(patch));
    if(item){assert.equal(item.price,null);assert.equal(item.priceConfirmed,false);assert.equal(item.priceObservedAt,null);}
    assert.deepEqual(personalDeck([bad],emptySubscriber(),{now:NOW,filters:{maxPrice:1000}}),[]);
  }
});
test('empty feeds report missing evidence honestly instead of inventing budget or audience matches',async()=>{
  const {db,products}=await fixture();try{
    const unknown=products.map(({product:p})=>({product:{...p,audience:undefined,priceSource:'legacy_snapshot'},visual:null}));
    await db.prepare("UPDATE feature_meta SET value=? WHERE key='shared_catalog_snapshot'").bind(JSON.stringify({products:unknown})).run();
    await mutate(db,11,{version:0,requestId:'subscriber-filter-price',filters:{maxPrice:300}},'filters');
    const budget=await styleFeed(db,11,{now:NOW});assert.equal(budget.emptyReason,'fresh_price_evidence_unavailable');assert.equal(budget.catalogueEvidence.freshPriceCount,0);
    await mutate(db,11,{version:1,requestId:'subscriber-filter-gender',filters:{audience:'women'}},'filters');
    const audience=await styleFeed(db,11,{now:NOW});assert.equal(audience.emptyReason,'audience_evidence_unavailable');assert.equal(audience.catalogueEvidence.audienceKnown,0);
  }finally{db.close();}
});
test('new recommendations exclude rated IDs, their photo/family clones, and already saved items',()=>{
  const products=[card(1),card(2,{imageHash:photo(1)}),card(3,{familyId:'verified-family',familyVerified:true}),card(4,{familyId:'verified-family',familyVerified:true}),card(5),card(6)];
  const deck=personalDeck(products,emptySubscriber(),{seenIds:[1,3],savedIds:[5],mode:'recommend',now:NOW});assert.deepEqual(deck.map(p=>p.id),[6]);
  assert.ok(personalDeck(products,emptySubscriber(),{seenIds:[1,3],savedIds:[5],mode:'learn',now:NOW}).some(p=>p.id===5));
});
test('votes move genuinely unseen visual matches ahead without pretending quality or trained uplift',()=>{
  let model=emptySubscriber();for(let id=11;id<=15;id++){const p=card(id);model=applySubscriberVote(model,null,{id,action:'like',features:subscriberFeatures(p,visual(p,{color:'black',fit:'oversize',silhouette:'loose'}),NOW)});}
  const red=card(21),black=card(22),v={21:visual(red,{color:'red',fit:'slim',silhouette:'fitted'}),22:visual(black,{color:'black',fit:'oversize',silhouette:'loose'})};
  const deck=personalDeck([red,black],model,{visualById:v,mode:'recommend',now:NOW});assert.equal(deck[0].id,22);assert.equal(deck[0].confidence,'limited_visual_evidence');assert.equal(deck[0].qualityEvidence.status,'historical_or_unverified');assert.ok(deck[0].reasons.some(reason=>reason.includes('цвет')||reason.includes('Чаще')));
  assert.equal(personalDeck([red,black],model,{mode:'recommend',now:NOW})[0].confidence,'category_only_low');
});
test('negative category never becomes a broad ban and explicit exploration stays visible',()=>{
  let model=emptySubscriber();for(let id=1;id<=5;id++)model=applySubscriberVote(model,null,{id,action:'dislike',features:{'category=Футболки':1}});
  const products=Array.from({length:12},(_,i)=>card(30+i,{category:['Футболки','Кеды','Сумки','Серьги'][i%4]})),deck=personalDeck(products,model,{mode:'recommend',now:NOW});
  assert.ok(deck.some(p=>p.category==='Футболки'));assert.equal(deck[4].exploration,true);assert.equal(deck[4].confidence,'exploration_not_prediction');assert.equal(new Set(deck.slice(0,4).map(p=>p.group)).size,4);assert.equal(styleScore(card(99),model,null,{now:NOW}).blocked,false);
});
test('evenly split feedback is not described as a negative preference',()=>{
  let model=emptySubscriber();for(let id=1;id<=6;id++)model=applySubscriberVote(model,null,{id,action:id%2?'like':'dislike',features:{'category=Футболки':1}});
  const result=styleScore(card(99),model,null,{now:NOW});assert.equal(result.score,0);assert.ok(!result.reasons.some(reason=>reason.startsWith('Реже нравилось')));assert.match(result.reasons[0],/оценки разделились/);
});
test('fresh verified quality is a small tie-break, never fabricated from historical ratings',()=>{
  const historical=card(1,{rating:5,reviews:5000}),fresh=card(2,{qualityVerified:true,qualityObservedAt:NOW,rating:4.8,reviews:100});
  const result=personalDeck([historical,fresh],emptySubscriber(),{mode:'recommend',now:NOW});assert.equal(result[0].id,2);assert.equal(result[0].qualityEvidence.status,'fresh_verified');assert.equal(result.find(p=>p.id===1).qualityEvidence.status,'historical_or_unverified');
  assert.deepEqual(personalDeck([card(3,{rating:4.2}),card(4,{reviews:1}),card(5,{qualityRisk:true})],emptySubscriber(),{now:NOW}),[]);
});
test('same request concurrent retries return ONE durable receipt and ONE vote',async()=>{
  const {db}=await fixture();try{
    const responses=await Promise.all([mutate(db,11,vote(0),'vote',{now:NOW}),mutate(db,11,vote(0),'vote',{now:NOW})]);
    assert.deepEqual(responses[0],responses[1]);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM style_votes').get().n,1);assert.equal((await account(db,11)).model.samples,1);
  }finally{db.close();}
});
test('deletion tombstone rejects a first-ever vote whose read began before privacy cleanup',async()=>{
  const {db}=await fixture();let release,entered;const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),batch=db.batch.bind(db);
  let blocked=false;db.batch=async statements=>{if(!blocked){blocked=true;entered();await waiting;}return batch(statements);};
  try{
    const pending=mutate(db,11,vote(0),'vote',{now:NOW});await started;
    await forgetSubscriber(db,11);assert.equal((await account(db,11)).version,1);release();
    await assert.rejects(pending,error=>error.status===409);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM style_votes').get().n,0);assert.equal((await account(db,11)).model.samples,0);
    assert.equal((await mutate(db,11,vote(1,1,'like','subscriber-after-erase'),'vote',{now:NOW})).version,2);
  }finally{release?.();db.close();}
});
test('receipts stay bounded and rejected history-cap writes cannot partly mutate personal data',async()=>{
  const {db}=await fixture();try{
    for(let version=0;version<45;version++)await mutate(db,11,{version,requestId:`subscriber-filter-${String(version).padStart(3,'0')}`,filters:{audience:'all',groups:[]}},'filters',{now:NOW});
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM feature_requests WHERE user_id=11').get().n,41);
    const model=emptySubscriber();model.seen=500;await db.prepare('UPDATE style_accounts SET model=? WHERE user_id=?').bind(JSON.stringify(model),11).run();
    await assert.rejects(mutate(db,11,vote(45),'vote',{now:NOW}),error=>error.status===409);
    assert.equal((await account(db,11)).version,45);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM style_votes').get().n,0);
  }finally{db.close();}
});
