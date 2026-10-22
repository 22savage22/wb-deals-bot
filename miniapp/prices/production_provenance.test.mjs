// Forensic regression of the native price path; every external request is a
// fixture. This is evidence of a code path, never a real price or Telegram send.
import test from 'node:test';import assert from 'node:assert/strict';
import {LocalD1} from '../features/local_d1.mjs';
import {bootstrap,nativeTick} from '../cloudflare/native_scheduler.mjs';

test('regression: repeated403 cannot renew checked_at or publish the13hour cached price',async t=>{
 const db=new LocalD1();t.after(()=>db.close());
 db.exec("CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT,overrides TEXT DEFAULT '{}',checked_at INTEGER)");
 let clock=Date.parse('2026-10-17T10:00:00Z');const initial=clock;
 t.mock.method(Date,'now',()=>clock);
 t.mock.method(console,'log',()=>{}); // Suppress simulated send/cron messages.
 const env={DB:db,SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:fixture-not-a-secret',MINIAPP_BOT_USERNAME:'fixture_bot'};
 const image='https://basket-01.wbbasket.ru/vol0/part1/1000/images/big/1.webp';
 await bootstrap(env,{queue:[{id:1000,title:'Fixture футболка хлопковая',product:700,basic:700,rating:4.8,feedbacks:120,category:'Футболки',query:'футболка мужская',image,checked_at:initial/1000,priceObservedAt:initial,observedAt:initial,stockObservedAt:initial}],posts:[],policy:{chat_id:'-100123456789',queries:['футболка мужская'],max_price:1000,min_rating:4.3}});
 const schedule=JSON.parse(db.sqlite.prepare('SELECT data FROM scheduler_config WHERE id=1').get().data);
 Object.assign(schedule,{paused:true,search_enabled:false,min_queue:1,timezone:'UTC',quiet_enabled:false,weekdays:[0,1,2,3,4,5,6]});
 db.sqlite.prepare('UPDATE scheduler_config SET data=? WHERE id=1').run(JSON.stringify(schedule));
 let cardRequests=0,sends=0,caption=null;
 const fetcher=async(url,options)=>{
   if(url.startsWith('https://card.wb.ru/')){cardRequests++;return new Response('fixture access denied',{status:403});}
   if(url.startsWith('https://basket-01.wbbasket.ru/'))return new Response('fixture photo',{headers:{'content-type':'image/webp'}});
   if(url.includes('/sendPhoto')){sends++;caption=JSON.parse(options.body).caption;return Response.json({ok:true,result:{message_id:42}});}
   throw Error('UNEXPECTED_EXTERNAL_REQUEST');
 };
 for(const hours of [3,6,9,12]){
   clock=initial+hours*3600000;
   db.sqlite.prepare("UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1").run(JSON.stringify({last_scan_attempt:clock/1000}));
   const tick=await nativeTick(env,clock,fetcher,'cron');assert.equal(tick.results.preflight.valid,false);
   assert.equal(db.sqlite.prepare('SELECT checked_at FROM scheduler_inventory WHERE pid=1000').get().checked_at,initial/1000);
 }
 assert.equal(sends,0);assert.equal(cardRequests,4);
 clock=initial+13*3600000;schedule.paused=false;db.sqlite.prepare('UPDATE scheduler_config SET data=? WHERE id=1').run(JSON.stringify(schedule));
 const tick=await nativeTick(env,clock,fetcher,'cron');assert.notEqual(tick.results.post.result,'success');assert.equal(sends,0);assert.equal(cardRequests,5);
 assert.equal(db.sqlite.prepare('SELECT count(*) n FROM scheduler_deliveries').get().n,0);
 const saved=JSON.parse(db.sqlite.prepare('SELECT data FROM scheduler_inventory WHERE pid=1000').get().data);
 assert.equal(saved.priceObservedAt,initial);assert.equal(saved.fallback,true);assert.equal(saved.priceStatus,'unconfirmed');assert.equal(caption,null);assert.ok(clock-initial>6*3600000);
});
