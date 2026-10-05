import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {bootstrap,nativeTick,postingWindow,postDue,choose,cardDeal,checkAutopost} from './native_scheduler.mjs';
import {DEFAULT_SCHEDULE} from './scheduler_api.mjs';
import {withReadBudget} from './read_guard.mjs';
function environment(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT,overrides TEXT DEFAULT '{}',checked_at INTEGER)");
  const counter={queries:0};
  const wrap=(sql,args=[])=>({bind(...values){return wrap(sql,values);},async first(){counter.queries++;return db.prepare(sql).get(...args)??null;},async all(){counter.queries++;return {results:db.prepare(sql).all(...args)};},run(){counter.queries++;return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});
  return {db,counter,SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:test',MINIAPP_BOT_USERNAME:'WbPodborr_bot',DB:{prepare:wrap,async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}}};
}
const image='https://basket-01.wbbasket.ru/vol0/part1/1000/images/big/1.webp';
const item=(id=1000,query='платье женское')=>({id,title:'Платье женское '+id,product:700,basic:700,rating:4.8,feedbacks:100,query,category:'Платья',image,queued_ts:Math.floor(Date.now()/1000)});
const card=(id=1000)=>({id,name:'Платье женское '+id,reviewRating:4.8,feedbacks:100,subjectName:'Платья',sizes:[{qty:10,price:{product:70000,basic:70000}}]});
const seed=(env,queue=[item()],posts=[])=>bootstrap(env,{queue,posts,policy:{chat_id:'-100123456789',queries:['платье женское','сумка женская'],max_price:1000,min_rating:4.3}});

test('bad price then valid next candidate posts in the SAME guarded cold invocation',async t=>{
  const env=environment(t);await seed(env,[{...item(1000),product:500},item(1001)]);let sent=0;
  env.DB={...env.DB};env.counter.queries=0;
  const r=await withReadBudget(env,'core',25000,e=>nativeTick(e,Date.now(),async url=>{
    if(url.includes('sendPhoto')){sent++;return Response.json({ok:true,result:{message_id:901}});}
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/jpeg'}});
    return Response.json({products:[card(Number(new URL(url).searchParams.get('nm')||1000))]});
  }));
  assert.equal(r.results.post.product_id,1001);assert.equal(sent,1);
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=1000').get().state,'rejected');
  assert.ok(env.counter.queries<=50,'guard+failover+send queries: '+env.counter.queries);
});

test('photo exhaustion rejects the card; next candidate succeeds without resetting shard loop',async t=>{
  const env=environment(t);await seed(env,[{...item(1000),photo_probe:49},item(1001)]);let sends=0;
  const r=await nativeTick(env,Date.now(),async url=>{
    if(url.includes('sendPhoto')){sends++;return Response.json({ok:true,result:{message_id:902}});}
    if(url.includes('wbbasket'))return url.includes('/1001/')?new Response('fixture',{headers:{'content-type':'image/jpeg'}}):new Response('',{status:404});
    return Response.json({products:[card(Number(new URL(url).searchParams.get('nm')||1000))]});
  });
  assert.equal(r.results.post.product_id,1001);assert.equal(sends,1);
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=1000').get().state,'rejected');
});

test('definitively rejected Telegram photo skips to next product in same guarded request',async t=>{
  const env=environment(t);await seed(env,[item(1000),item(1001)]);let attempts=0,accepted=0;
  env.db.prepare("UPDATE scheduler_config SET post_request='one-real-owner-request'").run();
  env.DB={...env.DB};env.counter.queries=0;
  const r=await withReadBudget(env,'core',25000,e=>nativeTick(e,Date.now(),async url=>{
    if(url.includes('sendPhoto')){attempts++;if(attempts<=2)return Response.json({ok:false,error_code:400,description:'Bad Request: failed to get HTTP URL content'});accepted++;return Response.json({ok:true,result:{message_id:903}});}
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/jpeg'}});
    return Response.json({products:[card(Number(new URL(url).searchParams.get('nm')||1000))]});
  }));
  assert.equal(r.results.post.product_id,1001);assert.equal(accepted,1);
  assert.equal(env.db.prepare('SELECT status FROM scheduler_claims WHERE pid=1000').get().status,'rejected');
  assert.equal(env.db.prepare('SELECT post_request FROM scheduler_config').get().post_request,null);
  assert.ok(env.counter.queries<=50,'guard+photo rejection+fallback queries: '+env.counter.queries);
});
test('definitive Telegram URL rejection falls back to bounded upload; exactly one accepted message',async t=>{
  const env=environment(t);await seed(env);let attempts=0,accepted=0;
  const r=await nativeTick(env,Date.now(),async(url,options)=>{
    if(url.includes('sendPhoto')){attempts++;if(attempts===1)return Response.json({ok:false,error_code:400,description:'Bad Request: failed to get HTTP URL content'});assert.ok(options.body instanceof FormData);assert.ok(options.body.get('photo') instanceof Blob);accepted++;return Response.json({ok:true,result:{message_id:456}});}
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/jpeg'}});
    return Response.json({products:[card()]});
  });assert.equal(r.results.post.message_id,456);assert.equal(attempts,2);assert.equal(accepted,1);
});
test('known first eight search cards do not hide fresh products later in the result page',async t=>{
  const env=environment(t);await seed(env,[]);
  env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true}));
  for(let id=1000;id<1008;id++)env.db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').run(id,JSON.stringify(item(id)),Math.floor(Date.now()/1000));
  const r=await nativeTick(env,Date.now(),async url=>url.includes('wbbasket')?new Response('photo',{headers:{'content-type':'image/webp'}}):Response.json({products:Array.from({length:16},(_,i)=>card(1000+i))}));
  assert.equal(r.results.search.added,3);assert.equal(env.db.prepare('SELECT MIN(pid) AS id FROM scheduler_inventory').get().id,1008);
});
test('search reports only admitted products, excluding aggregate trigger changes',async t=>{
  const env=environment(t);await seed(env,[]);
  env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true,min_queue:2}));
  const original=env.DB.prepare;
  const inflate=s=>({bind(...values){return inflate(s.bind(...values));},first:()=>s.first(),run:()=>s.run(),async all(){return {...await s.all(),meta:{changes:999}};}});
  env.DB.prepare=sql=>inflate(original(sql));
  const r=await nativeTick(env,Date.now(),async url=>url.includes('wbbasket')?new Response('photo',{headers:{'content-type':'image/webp'}}):Response.json({products:Array.from({length:8},(_,i)=>card(4000+i))}));
  assert.equal(r.results.search.added,2);
  const status=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  assert.equal(status.last_scan_valid,3);assert.equal(status.last_scan_added,2);
  assert.deepEqual(status.last_scan_new_ids,[4000,4001]);
});

test('429 persists provenance/backoff; minute and owner retries cannot burst; success resets stale errors',async t=>{
  const env=environment(t);await seed(env,[]);
  env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true}));
  let calls=0;
  const blocked=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'600','server':'WB-test'}});};
  await nativeTick(env,Date.now(),blocked);
  let s=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  assert.equal(s.last_scan_error_code,'WB HTTP 429');assert.equal(s.search_upstream_error.host,'search.wb.ru');
  assert.equal(s.search_failures,1);assert.ok(s.search_retry_at>=s.last_scan_attempt+600);
  for(let i=0;i<4;i++)await nativeTick(env,Date.now(),blocked);
  env.db.prepare("UPDATE scheduler_config SET search_request='owner-click'").run();
  await nativeTick(env,Date.now(),blocked);assert.equal(calls,1);
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.search_retry_at',0,'$.next_search',0,'$.last_scan_attempt',0)").run();
  await nativeTick(env,Date.now(),async url=>url.includes('wbbasket')?new Response('photo',{headers:{'content-type':'image/webp'}}):Response.json({products:[card(5000)]}));
  s=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  assert.equal(s.search_failures,0);assert.equal(s.search_retry_at,0);assert.equal(s.last_scan_error_code,'');assert.equal(s.search_upstream_error,undefined);
  assert.equal(s.last_search_add_receipt.origin,'cron');assert.deepEqual(s.last_scan_new_ids,[5000]);
  assert.ok(env.db.prepare('SELECT checked_at FROM scheduler_inventory WHERE pid=5000').get().checked_at>0);
});

test('concurrent cold isolates issue ONE search; three validated images/cards fit Free query ceiling',async t=>{
  const env=environment(t);await seed(env,[]);env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true}));
  const env2={...env,DB:{...env.DB}};let searches=0,details=0,active=0,maxActive=0;env.counter.queries=0;
  const live=async url=>{
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,1));active--;
    if(url.includes('wbbasket'))return new Response('photo',{headers:{'content-type':'image/webp'}});
    if(url.includes('search.wb.ru'))searches++;else details++;
    return Response.json({products:[card(6000),card(6001),card(6002)]});
  };
  await Promise.all([nativeTick(env,Date.now(),live),nativeTick(env2,Date.now(),live)]);
  assert.equal(searches,1);assert.equal(details,1);assert.equal(maxActive,1);
  assert.equal(env.db.prepare('SELECT ready FROM scheduler_counts').get().ready,3);
  assert.ok(env.counter.queries<=75,'Two concurrent ticks combined query ceiling: '+env.counter.queries);
  env.db.prepare("UPDATE scheduler_config SET status=json_remove(status,'$.last_scan_attempt','$.next_search')").run();
  env.counter.queries=0;await nativeTick(env,Date.now(),live);assert.ok(env.counter.queries<=50,'One discovery tick: '+env.counter.queries);
  assert.equal(env.db.prepare('SELECT ready FROM scheduler_counts').get().ready,3,'known IDs never re-admitted');
});

test('no image/card means no admission, and incomplete queue does not shorten configured search interval',async t=>{
  const env=environment(t);await seed(env,[]);env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true}));
  let searches=0;const live=async url=>{
    if(url.includes('wbbasket'))return new Response('',{status:404});
    if(url.includes('search.wb.ru'))searches++;
    return Response.json({products:[card(8000)]});
  };
  await nativeTick(env,Date.now(),live);await nativeTick(env,Date.now(),live);
  const s=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  assert.equal(searches,1);assert.equal(s.search_receipt.added,0);assert.equal(s.search_receipt.rejected.photo,1);
  assert.ok(s.next_search>=s.last_scan_attempt+1200);
});

test('guarded cold discovery plus THREE detailed cards/photos stays under 50 D1 calls',async t=>{
  const env=environment(t);await seed(env,[]);env.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...DEFAULT_SCHEDULE,paused:true}));
  const raw=env.DB;env.DB={...raw};env.counter.queries=0;
  const r=await withReadBudget({...env,DISCOVERY_DB:raw},'core',25000,e=>nativeTick(e,Date.now(),async url=>url.includes('wbbasket')?new Response('photo',{headers:{'content-type':'image/webp'}}):Response.json({products:[card(9000),card(9001),card(9002)]})));
  assert.equal(r.results.search.added,3);assert.ok(env.counter.queries<=50,'All guards + cold schema + photos: '+env.counter.queries);
});
test('prior failed claim cannot monopolize ready queue; next Cron safely publishes another ID',async t=>{
  const env=environment(t),now=Math.floor(Date.now()/1000);await seed(env,[item(1000),item(1001)]);
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_maintenance',?)").run(now);
  env.db.prepare("INSERT INTO scheduler_claims(pid,owner,ts,status) VALUES(1000,'old',?,'error')").run(now-600);
  let sends=0;
  const live=async url=>{
    if(url.includes('sendPhoto')){sends++;return Response.json({ok:true,result:{message_id:222}});}
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
    const id=Number(new URL(url).searchParams.get('nm')||1000);return Response.json({products:[card(id)]});
  };
  const first=await nativeTick(env,Date.now(),live);assert.equal(first.results.post.product_id,1001);assert.equal(sends,1);
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_maintenance',?)").run(now-301);
  await nativeTick(env,Date.now(),live);
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=1000').get().state,'uncertain');assert.equal(sends,1);
});
test('maintenance reconciles multiple old claim tombstones before choosing a valid card',async t=>{
  const env=environment(t),now=Math.floor(Date.now()/1000);await seed(env,[item(1000),item(1001),item(1002)]);
  for(const id of [1000,1001])env.db.prepare("INSERT INTO scheduler_claims(pid,owner,ts,status) VALUES(?,'old',?,'error')").run(id,now-600);
  const r=await nativeTick(env,Date.now(),async url=>{
    if(url.includes('sendPhoto'))return Response.json({ok:true,result:{message_id:333}});
    if(url.includes('wbbasket'))return new Response('fixture',{headers:{'content-type':'image/jpeg'}});
    return Response.json({products:[card(1002)]});
  });assert.equal(r.results.post.product_id,1002);
  await nativeTick(env,Date.now(),()=>assert.fail('Maintenance tick does not send'));
  assert.equal(env.db.prepare("SELECT COUNT(*) n FROM scheduler_inventory WHERE state='uncertain'").get().n,2);
});
function fetcher(counts,{failSend=false,failWB=false}={}){return async(url,options)=>{
  if(url.includes('wbbasket.ru'))return new Response('photo',{headers:{'content-type':'image/webp'}});
  if(url.includes('sendPhoto')){counts.send++;if(failSend)throw new Error('Do not leak credential URL');return Response.json({ok:true,result:{message_id:321}});}
  if(url.includes('getMe'))return Response.json({ok:true,result:{id:123}});
  if(url.includes('wb.ru')){counts.wb++;if(failWB)return new Response('',{status:403});return Response.json({products:[card()]});}
  throw new Error('Unexpected request');
};}
test('Moscow and overnight quiet hours are explicit; fixed times recover across midnight',()=>{
  const at=s=>Date.parse(s)/1000;
  assert.equal(postingWindow(DEFAULT_SCHEDULE,at('2026-10-03T06:30:00Z')).clock,'09:30');
  assert.equal(postingWindow({...DEFAULT_SCHEDULE,quiet_enabled:true},at('2026-10-02T20:30:00Z')).allowed,false);
  assert.equal(postingWindow({...DEFAULT_SCHEDULE,quiet_enabled:true},at('2026-10-03T04:00:00Z')).allowed,true);
  assert.equal(postDue({...DEFAULT_SCHEDULE,mode:'times',post_times:['09:00']},at('2026-10-02T15:00:00Z'),at('2026-10-03T06:01:00Z')),true);
  assert.equal(postDue({...DEFAULT_SCHEDULE,paused:true},0,at('2026-10-03T06:30:00Z')),false);
});
test('one current price is honest, stock/rating/budget/blacklist filters remain',()=>{
  assert.equal(cardDeal(card()).discount,0);
  assert.equal(cardDeal(card(),{max_price:600}),null);
  assert.equal(cardDeal(card(),{blacklist:['1000']}),null);
  assert.equal(cardDeal({...card(),reviewRating:1}),null);
  assert.equal(cardDeal({...card(),sizes:[{qty:0,price:{product:70000,basic:70000}}]}),null);
});
test('poisoned queue cannot monopolize reserve; bootstrap imports history without secrets',async t=>{
  const env=environment(t),now=Math.floor(Date.now()/1000);
  const r=await seed(env,Array.from({length:100},(_,i)=>item(1000+i)),[{pid:1000,ts:now-1000,query:'платье женское'}]);
  assert.equal(r.queue_size,7);
  const policy=JSON.parse(env.db.prepare('SELECT data FROM scheduler_policy').get().data);
  assert.equal(policy.TG_BOT_TOKEN,undefined);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM scheduler_posts').get().n,1);
});
test('topic caps and equal accessory rotation are retained, alternative topic is chosen',()=>{
  const rows=[item(1,'сумка женская'),item(2,'платье женское')].map(p=>({pid:p.id,data:JSON.stringify(p),topic:p.query,title_key:String(p.id)}));
  assert.equal(choose(rows,[],0).pid,1);
  const recent=Array.from({length:8},()=>({topic:'сумка женская'}));assert.equal(choose(rows,recent,0).pid,2);
});
test('within the same audience slot a verified photo/price is preferred over stale inventory',()=>{
  const rows=[item(1),item(2)].map(p=>({pid:p.id,data:JSON.stringify(p),topic:p.query,title_key:String(p.id),checked_at:p.id===2?Math.floor(Date.now()/1000):0}));
  assert.equal(choose(rows,[],2).pid,2);
});
test('one native Cron cycle obtains live card, sends once, records message ID; next tick is safe',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env);
  env.DB={...env.DB};env.counter.queries=0; // Include cold-isolate schema setup.
  const result=await nativeTick(env,Date.now(),fetcher(counts));
  assert.ok(env.counter.queries<=50,'Free D1 request query budget: '+env.counter.queries);
  assert.equal(result.results.post.result,'success');assert.equal(result.results.post.message_id,321);
  assert.equal(counts.send,1);assert.equal(env.db.prepare('SELECT message_id FROM scheduler_deliveries').get().message_id,321);
  const next=await nativeTick(env,Date.now(),fetcher(counts));assert.equal(counts.send,1);assert.equal(next.enabled,true);
  const s=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  for(const k of ['last_scheduler_tick','last_search_success','last_post_attempt','last_post_success'])assert.ok(s[k]>0,k);
});
test('daily-capped inventory moves to timed reserve and cannot block refill',async t=>{
  const env=environment(t),now=Math.floor(Date.now()/1000),counts={send:0,wb:0};
  const posts=Array.from({length:8},(_,i)=>({pid:2000+i,ts:now-1000+i,query:'платье женское',title:'Другая вещь '+i}));
  await seed(env,[item()],posts);
  await nativeTick(env,Date.now(),fetcher(counts));
  await nativeTick(env,Date.now(),fetcher(counts));
  const row=env.db.prepare('SELECT state,retry_at FROM scheduler_inventory WHERE pid=1000').get();
  assert.equal(row.state,'cooldown');assert.ok(row.retry_at>now);assert.ok(row.retry_at<now+86401);
  const status=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);
  assert.equal(status.search_cursor,2);assert.equal(counts.send,0);
});
test('stale lock expires; a live concurrent lock does not duplicate posting',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env);
  env.db.prepare('INSERT INTO scheduler_leases VALUES(?,?,?)').run('post','dead',Math.floor(Date.now()/1000)-1);
  assert.equal((await nativeTick(env,Date.now(),fetcher(counts))).results.post.result,'success');
  assert.equal(counts.send,1);
});
test('Telegram timeout has bounded uncertain quarantine, no blind retry and leases released',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env);
  await nativeTick(env,Date.now(),fetcher(counts,{failSend:true}));
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=1000').get().state,'uncertain');
  await nativeTick(env,Date.now(),fetcher(counts));assert.equal(counts.send,1);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM scheduler_leases WHERE kind='post'").get().n,0);
  assert.equal(JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status).last_error.includes('http'),false);
});
test('WB 403 does not stop heartbeat or disable next tick; search fallback is bounded',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env);
  const first=await nativeTick(env,Date.now(),fetcher(counts,{failWB:true}));assert.equal(first.enabled,true);assert.equal(counts.send,0);assert.ok(counts.wb<=3);
  await nativeTick(env,Date.now(),fetcher(counts,{failWB:true}));
  const s=JSON.parse(env.db.prepare('SELECT status FROM scheduler_config').get().status);assert.ok(s.last_scheduler_tick);assert.ok(s.last_scan_error);
  assert.equal(JSON.parse(env.db.prepare('SELECT data FROM scheduler_config').get().data).enabled,true);
});
test('diagnostic checks never publish; missing main-bot secret cannot substitute miniapp credentials',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env);env.MINIAPP_BOT_TOKEN='another:bot';delete env.TG_BOT_TOKEN;
  const check=await checkAutopost(env,fetcher(counts));assert.equal(check.telegram_configured,false);assert.equal(check.telegram_posts_created,0);assert.equal(counts.send,0);
  await nativeTick(env,Date.now(),fetcher(counts));assert.equal(counts.send,0);
});
test('safe check rejects a card exceeding the queued price increase guard',async t=>{
  const env=environment(t),counts={send:0,wb:0};await seed(env,[{...item(),product:500}]);
  const result=await checkAutopost(env,fetcher(counts));
  assert.equal(result.live_card,true);assert.equal(result.price_increase_ok,false);
  assert.equal(result.ok,false);assert.equal(counts.send,0);
});
test('verified migration refreshes ready inventory without resurrecting rejected cards',async t=>{
  const env=environment(t);await seed(env,[{...item(),product:500}]);
  const fresh={...item(),checked_at:Math.floor(Date.now()/1000)};await seed(env,[fresh]);
  assert.equal(JSON.parse(env.db.prepare('SELECT data FROM scheduler_inventory').get().data).product,700);
  env.db.prepare("UPDATE scheduler_inventory SET state='rejected'").run();
  await seed(env,[fresh]);assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory').get().state,'rejected');
});
test('manual request publishes one item after safety gap and stays consumed',async t=>{
  const env=environment(t),counts={send:0,wb:0},now=Math.floor(Date.now()/1000);
  await seed(env,[item()],[{pid:1234,ts:now-360,title:'Other',query:'other'}]);
  env.db.prepare("UPDATE scheduler_config SET post_request='owner-test'").run();
  assert.equal(postDue(DEFAULT_SCHEDULE,now-360,now),false);
  assert.equal(postDue(DEFAULT_SCHEDULE,now-60,now,true),false);
  env.DB={...env.DB};env.counter.queries=0;
  const result=await nativeTick(env,Date.now(),fetcher(counts));
  assert.ok(env.counter.queries<=50,'Manual cold request query budget: '+env.counter.queries);
  assert.equal(result.results.post.result,'success');assert.equal(counts.send,1);
  assert.equal(env.db.prepare('SELECT post_request FROM scheduler_config').get().post_request,null);
  await nativeTick(env,Date.now(),fetcher(counts));assert.equal(counts.send,1);
});
test('stale price is rejected between posts without sending or exceeding Free query budget',async t=>{
  const env=environment(t),counts={send:0,wb:0},now=Math.floor(Date.now()/1000);
  await seed(env,[{...item(),product:500}],[{pid:1234,ts:now-60,title:'Other',query:'other'}]);
  env.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.min_queue',1)").run();
  env.db.prepare("UPDATE scheduler_config SET status=json_set(status,'$.last_scan_attempt',?)").run(now);
  env.DB={...env.DB};env.counter.queries=0;
  const result=await nativeTick(env,Date.now(),fetcher(counts));
  assert.ok(env.counter.queries<=50,'Preflight cold query budget: '+env.counter.queries);
  assert.equal(result.results.preflight.valid,false);assert.equal(counts.send,0);
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory').get().state,'rejected');
});
test('cards published by legacy after migration cannot poison native selection',async t=>{
  const env=environment(t),counts={send:0,wb:0},now=Math.floor(Date.now()/1000);await seed(env);
  env.db.prepare('INSERT INTO scheduler_posts VALUES(?,?)').run(1000,now-60);
  await nativeTick(env,Date.now(),fetcher(counts));
  assert.equal(env.db.prepare('SELECT state FROM scheduler_inventory').get().state,'posted');
  assert.equal(counts.send,0);
});
