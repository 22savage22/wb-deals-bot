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
