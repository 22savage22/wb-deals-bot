import test from 'node:test';import assert from 'node:assert/strict';
import {fashionBudget,fashionQuoteState,fashionAcceptance,fashionCaption,FASHION_BUDGETS} from './fashion_policy.mjs';
import {assessFashion,chooseFashion,fashionMetadata} from './fashion_selection.mjs';import {selectionReason} from './selection_policy.mjs';
const p=(category='Худи',price=2200,id=1)=>{const p={id,title:'Вещь '+id,category,category_source:'wb-cdn',product:price,rating:4.8,feedbacks:100,image:'https://basket-01.wbbasket.ru/vol0/part0/'+id+'/images/big/1.webp'};p.fashion_metadata=fashionMetadata({nm_id:id,options:[{name:'Пол',value:'Мужской'}]},p,1);return p;};
test('owner category ceilings and four clarified categories are exact maxima, not targets',()=>{
 for(const [c,max] of [['Футболки',800],['Топы',800],['Лонгсливы',1500],['Свитеры',1500],['Джинсы',2500],['Брюки',2500],['Худи',2500],['Кроссовки',3500],['Кеды',3500],['Ботинки',3500],['Куртки',4500],['Бомберы',4500],['Платья',2500],['Юбки',1500],['Рубашки',1500],['Кардиганы',2500]]){assert.equal(fashionBudget(p(c,max)).allowed,true,c);assert.equal(fashionBudget(p(c,max+.01)).allowed,false,c);}
 assert.equal(fashionBudget(p('Сумки',1500),{group:'bags'}).allowed,true);assert.equal(fashionBudget(p('Сумки',1501),{group:'bags'}).allowed,false);assert.equal(FASHION_BUDGETS.accessories,1500);
 assert.equal(fashionBudget({...p(),category_source:null}).allowed,false);assert.equal(fashionBudget(p('Неизвестно',100)).allowed,false);
});
test('category budget applies to fashion proposals without overwriting the audited Legacy limit or owner bans',()=>{
 const policy={max_price:1000,selection:{max_price:1000,min_rating:4.3,min_feedbacks:0,blocked_words:['учебник']}};
 assert.equal(selectionReason(p(),policy),'Цена вне диапазона');assert.equal(assessFashion(p(),policy).allowed,true);assert.equal(policy.max_price,1000);assert.equal(policy.selection.max_price,1000);
 assert.equal(assessFashion({...p(),title:'учебник'},policy).allowed,false);assert.equal(assessFashion(p('Худи',2501),policy).reason,'ABOVE_OWNER_CATEGORY_BUDGET');
});
test('under-300 tag and huge seller discount never bypass photograph review or category ceiling',()=>{
 const cheap=p('Футболки',299),row={pid:1,data:JSON.stringify(cheap),topic:'a',title_key:'a',queued_at:1};assert.equal(fashionBudget(cheap).budgetFind,true);assert.equal(chooseFashion([row],[],{}).proposed_pid,null);
 const expensive={...p('Худи',2600),oldPrice:100000};assert.equal(fashionBudget(expensive).allowed,false);assert.equal(fashionBudget(expensive,{exceptions:{enabled:true,maxPrices:{bottoms_hoodies:5000}},valueProduct:{id:1,name:'Вещь',price:2600,oldPrice:100000}}).allowed,false);
});
test('visible quality can outweigh an underfilled audience bucket; missing visual features are not inferred',()=>{
 const a=p('Худи',700,1),b=p('Кроссовки',700,2),rows=[a,b].map(x=>({pid:x.id,data:JSON.stringify(x),topic:'t'+x.id,title_key:'k'+x.id,queued_at:x.id}));
 const profile={version:2,group:'apparel',fields:Object.fromEntries([['fit','oversize'],['pattern','graphic']].map(([k,value])=>[k,{value,confidence:.95,evidence:'Visible photograph feature'}]))};
 const history=Array.from({length:14},()=>({...rows[0],fashion_bucket:'men'}));const context={profiles:new Map([[1,profile],[2,{version:2,group:'shoes',fields:{shape:{value:'slim',confidence:.95,evidence:'Visible footwear shape'}}}]]),reviewed:new Map([[2,{approved:false}]])};
 assert.equal(chooseFashion(rows,[],{},context,history).proposed_pid,1);assert.deepEqual(assessFashion({...b,title:'модные тренд2026'},{}).visual,{});
});
const quote=now=>{const context={currency:'RUB',destination:'-1257786',paymentBasis:'unknown'};return {...p(),variantKey:'7001',size:'M',currency:'RUB',available:true,context,variants:[{variantKey:'7001',size:'M',currency:'RUB',available:true,price:2200,context}],priceStatus:'api_observed',priceSource:'wb_card',priceObservedAt:now,stockObservedAt:now,fallback:false,retailPriceConfirmed:false,priceContextConfirmed:false,priceProvenance:{method:'GET',kind:'details',status:200,receivedAt:now,requestedContext:context}};};
test('style, fresh API variant observation, ordinary retail confirmation and owner acceptance remain separate',()=>{
 const now=Date.now(),item=quote(now),budget=fashionBudget(item);const a=fashionAcceptance(item,{styleApproved:true,ownerApproved:true,budget,now});assert.equal(a.styleSuitable,true);assert.equal(a.priceObserved,true);assert.equal(a.retailPriceConfirmed,false);assert.equal(a.readyForPublication,false);
 for(const patch of [{variantKey:''},{priceSource:'wb_search'},{available:false},{fallback:true},{priceObservedAt:now-16*60000},{stockObservedAt:now-1}])assert.equal(fashionQuoteState({...item,...patch},now).freshVariantObservation,false);
 assert.equal(fashionAcceptance({...item,retailPriceConfirmed:true,priceContextConfirmed:true},{styleApproved:true,ownerApproved:true,budget,now}).readyForPublication,false);
 const known={currency:'RUB',destination:'-1257786',paymentBasis:'standard'},confirmed={...item,context:known,variants:[{...item.variants[0],context:known}],priceProvenance:{...item.priceProvenance,requestedContext:known},retailPriceConfirmed:true,priceContextConfirmed:true};assert.equal(fashionAcceptance(confirmed,{styleApproved:true,ownerApproved:true,budget,now}).readyForPublication,true);
 const changed={...confirmed,category:'Футболки'};assert.equal(fashionAcceptance(changed,{styleApproved:true,ownerApproved:true,budget,now}).readyForPublication,false);
 for(const patch of [{variants:[{...item.variants[0],variantKey:'7002'}]},{variants:[{...item.variants[0],available:false}]},{variants:[{...item.variants[0],price:100}]},{priceProvenance:{...item.priceProvenance,pid:999}},{priceProvenance:{...item.priceProvenance,variantKey:'7002'}}])assert.equal(fashionQuoteState({...item,...patch},now).freshVariantObservation,false);
});
test('post preview includes marketplace, exact observed size/time, short reason and known quality without discount promises',()=>{
 const now=Date.UTC(2026,9,27,9,15),item=quote(now),text=fashionCaption(item,{now,reason:'Свободный силуэт подтверждён фотографией.'});assert.match(text,/WB · 2.?200 ₽ · размер M/u);assert.match(text,/27\.10.*12:15.*МСК/u);assert.match(text,/100 отзывов/u);assert.doesNotMatch(text,/скидка|\d+%/u);assert.equal(fashionCaption({...item,priceObservedAt:0},{now,reason:'Вещь'}),null);
});
