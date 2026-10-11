import test from 'node:test';
import assert from 'node:assert/strict';
import {fashionCategory,selectFashionCalibration,tasteFeatureLabel} from './calibration.mjs';
const card=(id,category='Футболки',extra={})=>({id,category,categoryVerified:true,name:`Уникальная модель номер ${id}`,brand:'Unit Brand',price:700,imageHash:id.toString(16).padStart(64,'0'),photoVerifiedAt:1791705600000,localPhoto:`photos/${id}.webp`,...extra});

test('only exact confirmed fashion categories are allowed, never historical topics or titles',()=>{
  for(const category of ['Футболки','Платья','Кроссовки','Сумки','Серьги','Ремни','Кепки','Джинсы'])assert.equal(fashionCategory(card(1,category)).allowed,true);
  assert.equal(fashionCategory(card(1,' ПЛАТЬЯ ')).group,'clothing');
  for(const product of [card(1,'Футболки',{categoryVerified:false}),card(1,'Футболки',{categoryVerified:undefined}),card(1,'unknown',{name:'Красивое платье женское',historicalTopic:'платье женское'})])assert.equal(fashionCategory(product).allowed,false);
});

test('books, document inserts, patches, parts and crafts remain excluded despite fashion words',()=>{
  for(const category of ['Книги','Учебники','Обложки для автодокументов','Вкладыши для документов','Декор для одежды','Нашивки','Наборы для создания украшений','Ремни для привода','Запчасти для садовой техники','Сумки для инструментов'])assert.equal(fashionCategory(card(1,category,{name:'Футболка платье сумка украшения'})).allowed,false,category);
  for(const name of ['Книга о платьях','Учебник моды','Нашивка на футболку','Шеврон на липучке','Набор для создания украшений','Выкройка платья','Ремкомплект обуви','Вкладыш для автодокументов','Обложка на документы','Декор для одежды'])assert.equal(fashionCategory(card(1,'Платья',{name})).allowed,false,name);
  assert.equal(fashionCategory(card(1,'Худи',{name:'Худи с нашивкой на рукаве'})).allowed,true);
});

test('requires pinned real-photo evidence, not a plausible URL alone',()=>{
  for(const extra of [{imageHash:undefined},{photoVerifiedAt:undefined},{localPhoto:undefined,image:'https://images.example/image.webp'},{localPhoto:'../photos/1.webp'},{localPhoto:undefined,image:'http://basket-01.wbbasket.ru/vol1/1.webp'}])assert.equal(selectFashionCalibration([card(1,'Платья',extra)]).selected,0);
  assert.equal(selectFashionCalibration([card(1,'Платья',{localPhoto:undefined,image:'https://basket-01.wbbasket.ru/vol1/part1/1/images/big/1.webp'})]).selected,1);
});

test('40 genuinely different cards are balanced across fashion groups and categories',()=>{
  const categories=['Футболки','Платья','Джинсы','Кроссовки','Ботинки','Сумки','Рюкзаки','Серьги','Ремни','Кепки'];
  const pool=categories.flatMap((category,index)=>Array.from({length:8},(_,offset)=>card(index*8+offset+1,category)));
  const result=selectFashionCalibration(pool);
  assert.equal(result.selected,40);
  assert.equal(result.ready,true);
  assert.equal(result.shortfall,0);
  assert.equal(new Set(result.selectedIds).size,40);
  assert.deepEqual(result.products.slice(0,4).map(p=>fashionCategory(p).group),['clothing','shoes','bags','accessories']);
  assert.equal(Object.keys(result.breakdown.categories).length,10);
  assert.ok(Object.values(result.breakdown.groups).every(count=>count===10));
});

test('category cap prevents all 40 being same kind and reports honest minimum shortage',()=>{
  const result=selectFashionCalibration(Array.from({length:40},(_,i)=>card(i+1)));
  assert.equal(result.selected,8);
  assert.equal(result.shortfall,32);
  assert.equal(result.minimumShortfall,22);
  assert.equal(result.ready,false);
  assert.match(result.note,/не выдуманы/);
});

test('duplicate nmId and identical pinned photo cannot count twice',()=>{
  const result=selectFashionCalibration([card(1),card(1),card(2,'Платья',{imageHash:card(1).imageHash}),card(3,'Платья')]);
  assert.equal(result.selected,2);
  assert.deepEqual(result.rejectionCounts,{DUPLICATE_IMAGE:1,DUPLICATE_NMID:1});
});

test('explicit verified family and strongly equal titles reject same-size variants',()=>{
  const result=selectFashionCalibration([card(1,'Футболки',{name:'Футболка базовая хлопковая оверсайз черная размер M'}),card(2,'Футболки',{name:'Футболка базовая хлопковая оверсайз черная размер L'}),card(3,'Платья',{familyId:50,familyVerified:true}),card(4,'Платья',{familyId:50,familyVerified:true})]);
  assert.equal(result.selected,2);
  assert.equal(result.rejectionCounts.NEAR_IDENTICAL_FAMILY,2);
});

test('color variants with different photographs and generic titles are not blanket excluded',()=>{
  const result=selectFashionCalibration([card(1,'Футболки',{name:'Футболка базовая хлопковая оверсайз черная'}),card(2,'Футболки',{name:'Футболка базовая хлопковая оверсайз белая'}),card(3,'Сумки',{name:'Сумка женская'}),card(4,'Сумки',{name:'Сумка женская'}),card(5,'Платья',{familyId:5,familyVerified:false}),card(6,'Платья',{familyId:5,familyVerified:false})]);
  assert.equal(result.selected,6);
});

test('category and budget filters preserve fashion proof and label historical price basis',()=>{
  const result=selectFashionCalibration([card(1,'Платья',{price:250}),card(2,'Платья',{price:350}),card(3,'Сумки',{price:150}),card(4,'Платья',{price:null})],{priceMax:300,categories:['Платья']});
  assert.deepEqual(result.selectedIds,[1]);
  assert.equal(result.rejectionCounts.PRICE_FILTER,1);
  assert.equal(result.rejectionCounts.CATEGORY_FILTER,1);
  assert.equal(result.rejectionCounts.FILTER_PRICE_UNKNOWN,1);
  assert.match(result.priceFilterNote,/не подтверждает сегодняшнюю/);
});

test('invalid options or sparse pool never produce artificial fill',()=>{
  assert.equal(selectFashionCalibration([]).shortfall,40);
  for(const options of [{target:50},{target:29},{min:20},{target:30,min:31},{priceMax:-1},{maxPerCategory:100},{categories:[1]}])assert.throws(()=>selectFashionCalibration([] ,options),/INVALID_OPTIONS/);
});

test('labels are human-readable and unknown style remains unknown without Vision',()=>{
  assert.equal(tasteFeatureLabel('category=Платья'),'Категория: Платья');
  assert.equal(tasteFeatureLabel('budget=600–1000 ₽'),'Ценовой диапазон: 600–1000 ₽');
  assert.equal(tasteFeatureLabel('visual.color=black'),'Цвет: чёрный');
  assert.equal(tasteFeatureLabel('visual.fit=oversize'),'Крой: свободный oversize');
  assert.equal(tasteFeatureLabel('visual.style=romantic'),'Стиль: романтический');
  assert.equal(tasteFeatureLabel('style'),'Стиль: пока неизвестно');
  assert.equal(tasteFeatureLabel('visual.style=unknown'),'Стиль: пока неизвестно');
  assert.equal(tasteFeatureLabel('visual.style=fashionable'),'Стиль: пока неизвестно');
  assert.equal(tasteFeatureLabel('secret/token'),'Признак пока неизвестен');
});
