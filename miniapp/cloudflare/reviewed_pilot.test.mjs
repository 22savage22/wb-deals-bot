import test from 'node:test';import assert from 'node:assert/strict';
import {adminEnvironment} from './admin_test_support.mjs';import {bootstrap,nativeTick} from './native_scheduler.mjs';
import {parseReviewedPilot} from './fashion_selection.mjs';import {visualSourceVersion} from './visual_enrichment.mjs';
const product=(id,type='Футболки')=>({id,title:'Вещь '+id,query:'topic-'+id,category:type,category_source:'wb-cdn',product:700,rating:4.8,feedbacks:100,image:`https://basket-01.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`});
const review=(products,now)=>({version:1,owner_approved:true,starts_at:now-1,ends_at:now+43200-1,items:products.map(p=>({pid:p.id,source_version:visualSourceVersion(p),audience:'men',reviewed_at:now}))});
async function setup(t){const e=await adminEnvironment(t),products=Array.from({length:10},(_,i)=>product(1000+i,i%2?'Рубашки':'Футболки'));await bootstrap(e,{queue:[...products,product(2000)],posts:[],policy:{chat_id:'-100123456789',queries:products.map(p=>p.query),max_price:1000,min_rating:4.3}});const cfg=JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data);e.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...cfg,search_enabled:false,post_interval_minutes:30}));e.FASHION_PILOT_ENABLED='1';e.FASHION_PILOT_REVIEW=JSON.stringify(review(products,Math.floor(Date.now()/1000)));return {e,products};}
function network(sent,{blocked=false,photoChanged=false}={}){return async(url,opts)=>{const u=new URL(url);if(u.hostname==='api.telegram.org'){sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:9900+sent.length}});}if(u.hostname==='card.wb.ru'){if(blocked)return new Response('',{status:403});const id=Number(u.searchParams.get('nm')),p=product(id,id%2?'Рубашки':'Футболки');return Response.json({products:[{id,name:p.title,subjectName:p.category,reviewRating:4.8,feedbacks:100,sizes:[{qty:10,price:{product:70000,basic:70000}}]}]});}if(u.hostname.endsWith('.wbbasket.ru'))return photoChanged&&u.hostname==='basket-01.wbbasket.ru'?new Response('',{status:404}):new Response('fixture image',{headers:{'content-type':'image/webp'}});throw Error('LIVE_NETWORK_FORBIDDEN');};}
test('pilot requires approval, 10–15 unique reviews, current time window and bounded data',()=>{
 const now=Math.floor(Date.now()/1000),r=review(Array.from({length:10},(_,i)=>product(i+1)),now),parse=x=>parseReviewedPilot(JSON.stringify(x),now);
 assert.equal(parse(r).ready,true);assert.equal(parse(null).ready,false);assert.equal(parse({...r,items:[null,...r.items.slice(1)]}).ready,false);assert.equal(parse({...r,owner_approved:false}).ready,false);assert.equal(parse({...r,items:r.items.slice(0,8)}).ready,false);assert.equal(parse({...r,items:[...r.items,r.items[0]]}).ready,false);assert.equal(parse({...r,ends_at:now-1}).ready,false);assert.equal(parseReviewedPilot('x'.repeat(5000),now).ready,false);
});
test('finite pilot sends only approved products, retains 30 minutes including manual requests, then holds without Legacy fallback',async t=>{
 let ms=Date.now();t.mock.method(Date,'now',()=>ms);const {e}=await setup(t),sent=[];
 for(let i=0;i<10;i++){const r=await nativeTick(e,ms,network(sent));assert.equal(r.results.post?.product_id,1000+i);assert.equal(sent.length,i+1);assert.match(sent.at(-1).caption,/Для выбранного размера/);
  const request='queue:post:2000:early';e.db.prepare("UPDATE scheduler_config SET post_request=?,status=json_patch(status,?)").run(request,JSON.stringify({admin_product_request:request,admin_product_id:2000}));ms+=6*60*1000;const early=await nativeTick(e,ms,network(sent));assert.equal(early.results.post?.result,'not_due');assert.equal(sent.length,i+1);e.db.prepare('UPDATE scheduler_config SET post_request=NULL').run();ms+=25*60000;
 }
 const end=await nativeTick(e,ms,network(sent));assert.equal(end.results.post.result,'no_eligible_product');assert.equal(sent.length,10);assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=2000').get().state,'ready');
});
test('pilot refuses price fallback on WB403 and rejects a repaired unreviewed photo source',async t=>{
 for(const mode of ['blocked','photoChanged']){const {e,products}=await setup(t);e.db.prepare('UPDATE scheduler_inventory SET checked_at=?').run(Math.floor(Date.now()/1000));const sent=[];await nativeTick(e,Date.now(),network(sent,{[mode]:true}));assert.equal(sent.length,0,mode);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_deliveries').get().n,0);assert.equal(products.length,10);}
});
test('eight items are never padded with an unreviewed eleventh item',async t=>{
 const {e,products}=await setup(t);const r=review(products.slice(0,8),Math.floor(Date.now()/1000));e.FASHION_PILOT_REVIEW=JSON.stringify(r);const sent=[];const out=await nativeTick(e,Date.now(),network(sent));assert.equal(out.results.post.result,'no_eligible_product');assert.equal(sent.length,0);
});
test('conflicting passive/live flags hold the slot instead of mislabelling a pilot as Legacy',async t=>{
 const {e}=await setup(t);e.FASHION_SHADOW_ENABLED='1';const sent=[];const out=await nativeTick(e,Date.now(),network(sent));assert.equal(out.results.post.reason,'PILOT_AND_SHADOW_FLAGS_CONFLICT');assert.equal(sent.length,0);
});
test('owner textbook ban wins even for a requested item in the reviewed list',async t=>{
 const {e}=await setup(t),book={...product(1000),title:'Учебник химии',category:'Учебники'};e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=1000').run(JSON.stringify(book));const policy=JSON.parse(e.db.prepare('SELECT data FROM scheduler_policy').get().data);e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...policy,audience_quality:{enabled:true,excluded:['textbooks'],feedback_enabled:false,fashion_priority:true}}));const request='queue:post:1000:owner-ban';e.db.prepare("UPDATE scheduler_config SET post_request=?,status=json_patch(status,?)").run(request,JSON.stringify({admin_product_request:request,admin_product_id:1000}));const sent=[];await nativeTick(e,Date.now(),network(sent));assert.equal(sent.length,0);
});

