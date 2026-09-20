import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Execute the actual shipped frontend, without starting network initialization.
// A deliberately small DOM models append vs replacement; browser QA covers layout.
const source=readFileSync(new URL('../static/app.js',import.meta.url),'utf8').replace(/\binit\(\);\s*$/,'');
function harness(stored=null,{blockedStorage=false}={}) {
  const nodes=new Map(),listeners=new Map(),writes=[];
  function element(){return {value:'',textContent:'',hidden:false,children:[],replacements:0,appends:0,_html:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(){},showModal(){this.open=true;},close(){this.open=false;},get innerHTML(){return this._html;},set innerHTML(value){this.replacements++;this._html=value;this.children=value?[{}]:[];},insertAdjacentHTML(position,value){assert.equal(position,'beforeend');this.appends++;this._html+=value;this.children.push(...[...value.matchAll(/<article /g)].map(()=>({})));}};}
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);};
  const storage={getItem(){if(blockedStorage)throw Error('Storage blocked');return stored;},setItem(k,v){if(blockedStorage)throw Error('Storage blocked');writes.push([k,v]);}};
  const context=vm.createContext({window:{},document:{querySelector:node,querySelectorAll:()=>[],addEventListener:(name,fn)=>listeners.set(name,fn),createElement:element},localStorage:storage,Intl,URLSearchParams,setTimeout:()=>0,clearTimeout(){},console});
  vm.runInContext(source,context,{filename:'app.js'});
  const run=expression=>vm.runInContext(expression,context);
  const inject=(name,value)=>run(`${name}=${JSON.stringify(value)}`);
  node('#sort').value='mix';
  return {run,inject,node,listeners,writes};
}
const sample=(id,extra={})=>({id,title:`Вещь ${id}`,category:'',slot:'top',audience:'women',price:1000,checked_at:1700000000+id,rating:4.8,image:'https://basket-01.wbbasket.ru/a.webp',url:'https://www.wildberries.ru/catalog/'+id+'/detail.aspx',...extra});

test('UI category interleave is deterministic, complete and does not mutate input',()=>{
  const h=harness(),items=[sample(1),sample(2),sample(3,{slot:'shoes'}),sample(4,{slot:'bag'}),sample(5,{slot:'shoes'})];
  h.inject('state.products',items);
  assert.equal(h.run('interleave(state.products).map(p=>p.id).join(",")'),'1,3,4,2,5');
  assert.equal(h.run('state.products.map(p=>p.id).join(",")'),'1,2,3,4,5');
  assert.equal(h.run('interleave([]).length'),0);
  for(const [slot,want] of [['outer','apparel'],['shoes','apparel'],['hat','accessories'],['jewelry','accessories']])assert.equal(h.run(`interestOf({slot:${JSON.stringify(slot)}})`),want);
  assert.equal(h.run('interestOf({slot:"other",title:"Полотенце для кухни"})'),'home');
  assert.equal(h.run('interestOf({slot:"other",title:"Наушники"})'),'other');
});

test('UI discovery combines image, audience, budget, interest, category and search gates',()=>{
  const h=harness();h.inject('state.products',[sample(1),sample(2,{image:''}),sample(3,{audience:'men'}),sample(4,{price:2000}),sample(5,{slot:'bag'}),sample(6)]);
  h.run('failedImages.add(6)');h.inject('discovery',{audience:'women',maxPrice:1500,interest:'apparel'});h.run('renderCatalog()');
  assert.equal(h.run('feed.map(p=>p.id).join(",")'),'1');assert.equal(h.node('#count').textContent,'1 вещей с фото');
  h.node('#search').value='не существует';h.run('renderCatalog()');assert.equal(h.run('feed.length'),0);assert.match(h.node('#products').innerHTML,/Изменить фильтры/);
  h.node('#search').value='';h.inject('discovery',{audience:'all',maxPrice:0,interest:'all'});h.run('state.category="bag";renderCatalog()');assert.equal(h.run('feed.map(p=>p.id).join(",")'),'5');
});

test('UI feed appends pages without replacing existing cards and exposes finite ending',()=>{
  const h=harness();h.inject('state.products',Array.from({length:55},(_,i)=>sample(i+1)));h.run('renderCatalog()');
  const grid=h.node('#products'),first=grid.children[0],replacements=grid.replacements;
  assert.equal(grid.children.length,24);assert.equal(h.node('#load-more').hidden,false);
  h.run('appendFeed()');assert.equal(grid.children.length,48);assert.equal(grid.children[0],first);assert.equal(grid.replacements,replacements);
  h.run('appendFeed()');assert.equal(grid.children.length,55);assert.equal(h.node('#load-more').hidden,true);assert.match(h.node('#feed-status').textContent,/все находки/);
  h.run('appendFeed()');assert.equal(grid.children.length,55);
});

test('UI runtime image failure hides discovery card but retains saved item with placeholder',()=>{
  const h=harness();h.inject('state.products',[sample(1),sample(2)]);h.run('renderCatalog()');
  let removed=false;const card={dataset:{product:'1'},remove(){removed=true;h.node('#products').children.pop();}};
  h.listeners.get('error')({target:{tagName:'IMG',closest:()=>card}});
  assert.equal(removed,true);assert.equal(h.run('failedImages.has(1)'),true);assert.equal(h.node('#count').textContent,'1 вещей с фото');
  let replacement;h.listeners.get('error')({target:{tagName:'IMG',closest:()=>null,replaceWith(box){replacement=box;}}});
  assert.equal(replacement.textContent,'Фото временно недоступно');
});

test('UI storage is optional and validates persisted preferences',()=>{
  const h=harness(JSON.stringify({version:1,audience:'malicious',interest:'constructor',maxPrice:-10}));
  assert.equal(h.run('JSON.stringify(discovery)'),'{"audience":"all","interest":"all","maxPrice":0}');
  const remembered=harness(JSON.stringify({version:1,audience:'men',interest:'accessories',maxPrice:3000}));assert.equal(remembered.run('discovery.maxPrice'),3000);assert.equal(remembered.run('discoverySeen'),true);
  const blocked=harness(null,{blockedStorage:true});assert.doesNotThrow(()=>blocked.run('rememberDiscovery()'));assert.equal(blocked.run('discoverySeen'),true);
});

test('UI escapes product text and uses accessible image and save controls',()=>{
  const h=harness();assert.equal(h.run(`esc(${JSON.stringify('<>&"\'')})`),'&lt;&gt;&amp;&quot;&#39;');
  h.inject('state.products',[sample(1,{title:'<script>alert(1)</script>'})]);const card=h.run('card(state.products[0])');
  assert.ok(!card.includes('<script>'));assert.match(card,/&lt;script&gt;/);assert.match(card,/aria-pressed="false"/);assert.match(card,/alt="/);
  const html=readFileSync(new URL('../static/index.html',import.meta.url),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);assert.match(html,/aria-labelledby="discovery-title"/);
});
