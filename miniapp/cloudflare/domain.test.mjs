import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,build} from './domain.mjs';
const now=1800000000;
const product=(id,title,extras={})=>normalize({id,title,price:1000,rating:4.9,checked_at:now,image:`https://basket-01.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`,...extras});
test('rejects misleading home, child, costume and underwear keywords',()=>{
  for(const title of ['Платье для куклы','Сумка детская','Подушка кольцо','Топ нижнее белье','Костюм карнавальный с юбкой','Топ купальный'])assert.equal(product(1,title).slot,'other');
});
test('formal evening excludes explicit sports, missing photos and stale prices',()=>{
  const items=[product(1,'Платье вечернее женское черное'),product(2,'Кроссовки беговые женские'),product(3,'Туфли женские черные'),product(4,'Туфли женские',{image:''}),product(5,'Туфли женские',{checked_at:now-172801})];
  const result=build(items,1,10000,'evening',[],[],now);
  assert.equal(result.length,1);assert.deepEqual(result[0].items.map(p=>p.id),[1,3]);assert.match(result[0].disclaimer,/не виртуальная примерка/);
});
test('summer/winter and multiple explicit accent colors do not mix',()=>{
  const dress=product(1,'Платье летнее женское красное');
  assert.deepEqual(build([dress,product(2,'Ботинки зимние женские')],1,10000,'everyday',[],[],now),[]);
  assert.deepEqual(build([dress,product(2,'Туфли женские зеленые')],1,10000,'everyday',[],[],now),[]);
  assert.equal(build([dress,product(2,'Туфли женские белые')],1,10000,'everyday',[],[],now).length,1);
});
test('unknown audience anchor does not permit mixed male and female items',()=>{
  const items=[product(1,'Сумка'),product(2,'Футболка женская'),product(3,'Брюки мужские'),product(4,'Кеды')];
  assert.deepEqual(build(items,1,10000,'everyday',[],[],now),[]);
});
test('no incomplete outfits and photographed owned anchor retains zero cost',()=>{
  const anchor=product(1,'Футболка женская');
  assert.deepEqual(build([anchor,product(2,'Джинсы женские')],1,10000,'everyday',[],[],now),[]);
  const result=build([anchor,product(2,'Джинсы женские'),product(3,'Кеды женские')],1,2000,'everyday',[1],[],now);
  assert.equal(result[0].total,2000);assert.deepEqual(result[0].owned,[1]);
});
test('affordable path survives many higher scoring expensive candidates',()=>{
  const items=[product(1,'Футболка женская',{price:100}),...Array.from({length:30},(_,i)=>product(i+10,'Джинсы женские',{price:1800,rating:5})),product(50,'Брюки женские',{price:700,rating:4.5}),product(51,'Туфли женские',{price:800})];
  const result=build(items,1,2000,'everyday',[],[],now);
  assert.ok(result.length);assert.deepEqual(result[0].items.map(p=>p.id),[1,50,51]);assert.equal(result[0].total,1600);
});
test('incompatible high ranked products cannot hide matching shoes',()=>{
  const items=[product(1,'Платье летнее женское'),...Array.from({length:30},(_,i)=>product(i+10,'Ботинки зимние женские',{rating:5})),product(50,'Босоножки женские',{rating:4.5})];
  assert.equal(build(items,1,3000,'everyday',[],[],now).length,1);
});
test('budget choice omits extras and variants change the clothing foundation',()=>{
  const items=[product(1,'Сумка женская',{price:100}),product(2,'Футболка женская'),product(3,'Футболка женская',{price:500}),product(4,'Джинсы женские'),product(5,'Брюки женские',{price:500}),product(6,'Кроссовки женские'),product(7,'Туфли женские',{price:500}),product(8,'Серьги женские')];
  const result=build(items,1,10000,'everyday',[],[],now);
  assert.equal(result.length,3);assert.equal(result[1].label,'Экономнее');assert.equal(result[1].total,1600);assert.ok(!result[1].items.some(p=>p.id===8));
  const cores=result.map(o=>o.items.filter(p=>['top','bottom','shoes'].includes(p.slot)).map(p=>p.id).sort().join(','));
  assert.equal(new Set(cores).size,3);assert.ok(result.every(o=>o.total<=10000));
});
