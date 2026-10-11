import test from 'node:test';import assert from 'node:assert/strict';
import {adminEnvironment,adminRequest,rawPolicy,testCard} from './admin_test_support.mjs';
import {selectionSettings,selectionReason,similarity,diverseChoice} from './selection_policy.mjs';
import {cardDeal,choose} from './native_scheduler.mjs';
test('selection reads without writing defaults; save validates, preserves query/channel/30min and restores with CAS',async t=>{
  const e=await adminEnvironment(t),original=rawPolicy(e);const r=await(await adminRequest(e,'/api/admin/selection')).json();assert.equal(rawPolicy(e),original);assert.equal(r.active,false);assert.equal(r.styles_available,false);
  const settings={...r.settings,min_price:600,allowed_brands:['Fixture'],diversity_enabled:true};
  assert.equal((await adminRequest(e,'/api/admin/selection','PUT',{revision:r.revision,settings:{...settings,weights:{...settings.weights,other:0}}})).status,400);
  assert.equal((await adminRequest(e,'/api/admin/selection','PUT',{revision:r.revision,settings})).status,200);const p=JSON.parse(rawPolicy(e));assert.equal(p.chat_id,JSON.parse(original).chat_id);assert.deepEqual(p.queries,JSON.parse(original).queries);assert.ok(cardDeal(testCard(),p));assert.equal(cardDeal({...testCard(),brand:'Another'},p),null);assert.equal(cardDeal(testCard(),{...p,selection:{...p.selection,min_price:800}}),null);
  assert.equal((await adminRequest(e,'/api/admin/selection','PUT',{revision:r.revision,settings})).status,409);
  const h=await(await adminRequest(e,'/api/admin/config/history')).json(),current=await(await adminRequest(e,'/api/admin/selection')).json();assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:h.items[0].id,revision:current.revision})).status,200);
  assert.equal(JSON.parse(rawPolicy(e)).selection,undefined);assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
});
test('metadata filters do not invent audience; similarity rejects type, pack and dimension mismatch',()=>{
  const p={id:1,title:'Футболка хлопковая',category:'Футболки',brand:'Brand',price:500,rating:4.9,feedbacks:50},s=selectionSettings({}),policy={selection:{...s,audiences:['women'],include_unknown_audience:false}};
  assert.equal(selectionReason(p,policy),'Аудитория не подходит');assert.equal(selectionReason(p,{selection:{...policy.selection,include_unknown_audience:true}}),null);
  assert.equal(selectionReason({...p,category:'Обувь'},{selection:{...s,included_categories:['футболки']}}),'Категория не включена');
  assert.equal(similarity(p,{...p,category:'Сумки'}).score,0);assert.equal(similarity({...p,title:'Носки 2 шт'},{...p,title:'Носки 5 шт'}).score,0);assert.equal(similarity({...p,title:'Сумка 20x30'},{...p,title:'Сумка 25x30'}).score,0);
});
test('diversity uses available categories and soft fallback, without bypassing dedup or hard filters',()=>{
  const make=(id,category,title)=>({pid:id,title_key:title,topic:category,checked_at:1,queued_at:id,data:JSON.stringify({id,category,title,product:500,rating:5,feedbacks:100,image:'https://basket-01.wbbasket.ru/a.webp'})});
  const a=make(1,'Футболки','Футболка'),b=make(2,'Кроссовки','Кроссовки'),s={...selectionSettings({}),diversity_enabled:true,weights:{clothes:40,shoes:25,accessories:25,other:10},max_consecutive:2,similar_window:4},policy={selection:s},recent=[{data:a.data,topic:a.topic,title_key:'old1'},{data:a.data,topic:a.topic,title_key:'old2'}];
  assert.equal(diverseChoice([a,b],recent,policy).pid,2);assert.equal(diverseChoice([a],recent,policy).pid,1);assert.equal(choose([a],recent,0,{selection:{...s,min_price:600}}),null);assert.equal(choose([a],[{...recent[0],title_key:a.title_key}],0,policy),null);
});
test('similar candidates and query suggestions are bounded local reads; subscriber denied and GET preserves settings',async t=>{
  const e=await adminEnvironment(t),original=rawPolicy(e);assert.equal((await adminRequest(e,'/api/admin/selection','GET',null,22)).status,403);
  const r=await(await adminRequest(e,'/api/admin/selection/suggestions')).json();assert.ok(r.items.length<=12);assert.equal(rawPolicy(e),original);
  assert.equal((await adminRequest(e,'/api/admin/selection/similar?pid=unknown')).status,400);assert.equal((await adminRequest(e,'/api/admin/selection/similar?pid=999')).status,404);
});
