import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from './worker.mjs';
import {telegramUser} from './auth.mjs';
import {normalize,safeImage,build} from './domain.mjs';

const token='123456789:test-token-not-real',now=Math.floor(Date.now()/1000);
function signed(id=11,date=now) {
  const fields={auth_date:String(date),query_id:'test',user:JSON.stringify({id,first_name:'Test'})};
  const check=Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  return new URLSearchParams({...fields,hash:createHmac('sha256',secret).update(check).digest('hex')}).toString();
}
function environment() {
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){return db.prepare(sql).get(...args)??null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}});
  return {db,MINIAPP_BOT_TOKEN:token,MINIAPP_SYNC_KEY:'s'.repeat(40),MINIAPP_ADMIN_ID:'11',MINIAPP_BOT_USERNAME:'test_bot',DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}},ASSETS:{fetch:async r=>new Response(new URL(r.url).pathname)},RATE_LIMITER:{limit:async()=>({success:true})}};
}
async function request(env,path,method='GET',body=undefined,id=11,headers={}) {
  return worker.fetch(new Request('https://test.example'+path,{method,headers:{'Content-Type':'application/json',...(id?{'X-Telegram-Init-Data':signed(id)}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
}
const raw=(id,title='Платье женское',price=1000,extras={})=>({id,title,price,checked_at:now,rating:4.8,image:'https://basket-01.wbbasket.ru/image.webp',...extras});
async function sync(env,products){const r=await request(env,'/api/sync','POST',{products},null,{Authorization:'Bearer '+env.MINIAPP_SYNC_KEY});assert.equal(r.status,200,await r.clone().text());return r;}

test('Telegram HMAC validates independently signed data and rejects spoof/expiry/duplicates',async()=>{
  assert.equal(await telegramUser(signed(),token,now),11);
  for(const input of [signed().replace('Test','Evil'),signed(11,now-3601),signed(11,now+31),signed()+'&auth_date=1',signed(true)])await assert.rejects(()=>telegramUser(input,token,now));
  await assert.rejects(()=>telegramUser(signed(),'wrong',now));
});
test('catalogue allowlist sanitizes image URLs and derives categories',()=>{
  const p=normalize(raw(1,'Ремень для платья',500,{category:'Ремни',user_id:8,token:'secret',image:'https://evil.example/x'}));
  assert.equal(p.slot,'belt');assert.equal(p.image,'');assert.equal(p.user_id,undefined);assert.equal(p.token,undefined);
  assert.equal(safeImage('https://basket-01.wbbasket.ru/x'),'https://basket-01.wbbasket.ru/x');
  for(const u of ['https://user@basket-01.wbbasket.ru/x','https://basket-01.wbbasket.ru.evil/x','http://basket-01.wbbasket.ru/x','https://basket-01.wbbasket.ru:444/x'])assert.equal(safeImage(u),'');
  assert.throws(()=>normalize(raw(1,'x',Infinity)));assert.throws(()=>normalize(raw(1.5)));
});
test('outfits enforce budget, owned, replacement, freshness and genuine variants',()=>{
  const items=[raw(1),raw(2,'Кроссовки женские',1000),raw(3,'Туфли женские',1100),raw(4,'Балетки женские',1200),raw(5,'Сумка женская',500)].map(normalize);
  const results=build(items,1,2500,'everyday',[],[],now);assert.equal(results.length,3);assert.ok(results.every(r=>r.total<=2500));
  assert.equal(new Set(results.map(r=>r.items.find(p=>p.slot==='shoes').id)).size,3);
  assert.ok(build(items,1,1500,'everyday',[1],[2],now).every(r=>r.total<=1500&&!r.items.some(p=>p.id===2)&&r.owned.includes(1)));
  assert.throws(()=>build(items,1,5000,'everyday',[],[],now+172801));
  assert.throws(()=>build(items,1,5000,'constructor',[],[],now));
});
test('sync set-based upsert preserves images/newer checks/owner overrides and skips identical writes',async()=>{
  const env=environment(),p=raw(1,'Платье женское',1000,{image:'https://basket-01.wbbasket.ru/x'});
  await sync(env,[p]);let changes=env.db.prepare('SELECT total_changes() AS n').get().n;
  await sync(env,[p]);assert.equal(env.db.prepare('SELECT total_changes() AS n').get().n-changes,1); // metadata only
  assert.equal((await request(env,'/api/admin/products/1','PUT',{slot:'top',audience:'women',enabled:false})).status,200);
  await sync(env,[{...p,price:900,image:'',checked_at:now+1}]);await sync(env,[{...p,price:1,checked_at:now-1}]);
  const stored=env.db.prepare('SELECT data,overrides FROM products WHERE id=1').get();assert.equal(JSON.parse(stored.data).price,900);assert.ok(JSON.parse(stored.data).image);assert.equal(JSON.parse(stored.overrides).enabled,false);
  assert.equal((await (await request(env,'/api/catalog')).json()).products.length,0);
  assert.equal((await request(env,'/api/sync','POST',{products:[p]},null)).status,403);
  env.db.close();
});
test('user isolation, hidden saved products, preferences, outfits and scoped deletion',async()=>{
  const env=environment();await sync(env,[raw(1),raw(2,'Кроссовки женские')]);
  assert.equal((await request(env,'/api/saved/1','PUT',{folder:'Подарки',owned:true})).status,200);
  assert.equal((await request(env,'/api/preferences','PUT',{budget:2000,occasion:'office'})).status,200);
  assert.equal((await request(env,'/api/outfits/saved','POST',{ids:[1,2],title:'Office'})).status,200);
  await request(env,'/api/admin/products/1','PUT',{slot:'dress',audience:'women',enabled:false});
  let own=await(await request(env,'/api/me')).json();assert.equal(own.saved.length,1);assert.equal(own.products.length,2);assert.equal(own.preferences.budget,2000);assert.equal(own.is_admin,true);
  const other=await(await request(env,'/api/me','GET',undefined,22)).json();assert.deepEqual(other.saved,[]);assert.deepEqual(other.products,[]);assert.equal(other.is_admin,false);
  assert.equal((await request(env,'/api/admin/products','GET',undefined,22)).status,403);
  await request(env,'/api/outfits/saved/'+own.outfits[0].id,'DELETE',undefined,22);
  assert.equal((await(await request(env,'/api/me')).json()).outfits.length,1);
  await request(env,'/api/saved/2','PUT',{},22);await request(env,'/api/me','DELETE');
  own=await(await request(env,'/api/me')).json();assert.deepEqual(own.saved,[]);assert.deepEqual(own.outfits,[]);assert.deepEqual(own.preferences,{});
  assert.equal((await(await request(env,'/api/me','GET',undefined,22)).json()).saved.length,1);env.db.close();
});
test('anonymous auth, input limits, private rate limiter, security headers and asset mapping',async()=>{
  const env=environment();assert.equal((await request(env,'/api/me','GET',undefined,null)).status,401);
  assert.equal((await request(env,'/api/preferences','PUT',{budget:true})).status,400);
  assert.equal((await request(env,'/api/preferences','PUT',{budget:500,occasion:'__proto__'})).status,400);
  assert.equal((await request(env,'/api/preferences','PUT',{text:'x'.repeat(33000)})).status,413);
  env.RATE_LIMITER.limit=async()=>({success:false});assert.equal((await request(env,'/api/me')).status,429);
  const asset=await request(env,'/');assert.equal(await asset.text(),'/index.html');assert.ok(asset.headers.get('Content-Security-Policy').includes("object-src 'none'"));
  assert.equal(await(await request(env,'/static/app.js')).text(),'/static/app.js');assert.equal((await request(env,'/secret')).status,404);env.db.close();
});
test('webhook rejects forged calls and ignores non-start messages',async()=>{
  const env=environment();env.MINIAPP_WEBHOOK_SECRET='w'.repeat(40);
  assert.equal((await request(env,'/telegram/webhook','POST',{})).status,403);
  assert.equal((await request(env,'/telegram/webhook','POST',{message:{chat:{id:11,type:'private'},text:'hello'}},null,{'X-Telegram-Bot-Api-Secret-Token':env.MINIAPP_WEBHOOK_SECRET})).status,200);env.db.close();
});
test('webhook start launch fixes URL to own origin, forwards only validated product parameter',async()=>{
  const env=environment();env.MINIAPP_WEBHOOK_SECRET='w'.repeat(40);
  const original=globalThis.fetch;let call;const pending=[];
  globalThis.fetch=async(url,options)=>{call={url,body:JSON.parse(options.body)};return new Response('{}');};
  try {
    const response=await worker.fetch(new Request('https://test.example/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.MINIAPP_WEBHOOK_SECRET},body:JSON.stringify({message:{chat:{id:11,type:'private'},text:'/start save_123'}})}),env,{waitUntil:p=>pending.push(p)});
    assert.equal(response.status,200);await Promise.all(pending);
    assert.equal(call.body.chat_id,11);assert.equal(call.body.reply_markup.inline_keyboard[0][0].web_app.url,'https://test.example/?tgWebAppStartParam=save_123');
  } finally {globalThis.fetch=original;env.db.close();}
});
test('saved cap is enforced by SQL while updates remain allowed',async()=>{
  const env=environment();await sync(env,[raw(1),raw(1001)]);
  const insert=env.db.prepare('INSERT INTO saved VALUES (11,?,\'Себе\',0,?)');for(let i=1;i<=1000;i++)insert.run(i,now);
  assert.equal((await request(env,'/api/saved/1001','PUT',{})).status,400);
  assert.equal((await request(env,'/api/saved/1','PUT',{folder:'Дом',owned:true})).status,200);
  assert.equal(env.db.prepare('SELECT count(*) AS n FROM saved WHERE user_id=11').get().n,1000);env.db.close();
});
