import test from 'node:test';import assert from 'node:assert/strict';
import {selectionCursor,bootstrap,nativeTick} from './native_scheduler.mjs';import {adminEnvironment} from './admin_test_support.mjs';
const state=(cursor,n=46)=>({row:{status:JSON.stringify(cursor===undefined?{}:{selection_cursor:cursor})},policy:{total_posts:1850},recent:Array(n).fill({})});
test('persisted phase advances independently of the rolling history length; initial phase matches Legacy',()=>{
 assert.equal(selectionCursor(state(undefined)),1896);assert.equal(selectionCursor(state(1897,46)),1897);assert.equal(selectionCursor(state(1897,0)),1897);assert.equal(selectionCursor(state(1897,45)),1897);
 for(const invalid of [-1,1.2,'1897',Number.MAX_SAFE_INTEGER])assert.equal(selectionCursor(state(invalid)),1896);
});
const item=id=>({id,title:'Футболка мужская '+id,product:700,rating:4.8,feedbacks:100,query:'футболка мужская',category:'Футболки',image:`https://basket-01.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`});
async function seeded(t){const e=await adminEnvironment(t);await bootstrap(e,{queue:[item(900),item(901),item(902)],posts:[],policy:{chat_id:'-100123456789',queries:['футболка мужская'],total_posts:1850,max_price:1000,min_rating:4.3}});const cfg=JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data);e.db.prepare('UPDATE scheduler_config SET data=?,status=?').run(JSON.stringify({...cfg,search_enabled:false,post_interval_minutes:30}),JSON.stringify({selection_cursor:1896}));return e;}
function network(sent,{reject=false}={}){return async(url,options)=>{const u=new URL(url);if(u.hostname==='api.telegram.org'){sent.push(JSON.parse(options.body));return reject?Response.json({ok:false,error_code:503,description:'fixture unavailable'}):Response.json({ok:true,result:{message_id:9900+sent.length}});}if(u.hostname.endsWith('.wbbasket.ru'))return new Response('fixture image',{headers:{'content-type':'image/webp'}});const id=Number(u.searchParams.get('nm'));return Response.json({products:[{id,name:item(id).title,subjectName:'Футболки',reviewRating:4.8,feedbacks:100,sizes:[{qty:10,price:{product:70000,basic:70000}}]}]});};}
test('only confirmed sends advance phase once; early ticks preserve the 30-minute automatic interval',async t=>{
 const e=await seeded(t),sent=[];let ms=Date.now();t.mock.method(Date,'now',()=>ms);
 const read=()=>JSON.parse(e.db.prepare('SELECT status FROM scheduler_config').get().status).selection_cursor;
 assert.equal((await nativeTick(e,ms,network(sent))).results.post.result,'success');assert.equal(read(),1897);assert.equal(sent.length,1);
 ms+=1000;await nativeTick(e,ms,network(sent));assert.equal(read(),1897);assert.equal(sent.length,1);
 ms+=30*60000;assert.equal((await nativeTick(e,ms,network(sent))).results.post.result,'success');assert.equal(read(),1898);assert.equal(sent.length,2);
 assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
});
test('Telegram failure leaves phase unchanged and never pretends the delivery succeeded',async t=>{
 const e=await seeded(t),sent=[];const r=await nativeTick(e,Date.now(),network(sent,{reject:true}));assert.equal(r.results.post.result,'error');assert.equal(JSON.parse(e.db.prepare('SELECT status FROM scheduler_config').get().status).selection_cursor,1896);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_deliveries').get().n,0);
});
test('failure of delivery batch cannot commit a phase without its delivery; success claim prevents re-send',async t=>{
 const e=await seeded(t),batch=e.DB.batch.bind(e.DB),sent=[];e.DB.batch=async statements=>{if(statements.length===4)throw Error('fixture delivery batch unavailable');return batch(statements);};
 await nativeTick(e,Date.now(),network(sent));assert.equal(sent.length,1);assert.equal(JSON.parse(e.db.prepare('SELECT status FROM scheduler_config').get().status).selection_cursor,1896);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_deliveries').get().n,0);assert.equal(e.db.prepare('SELECT status FROM scheduler_claims WHERE pid=900').get().status,'success');
});

