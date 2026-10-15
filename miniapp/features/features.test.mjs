// Synthetic unit/integration fixtures in local SQLite only. No real votes/posts/AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessSuperfind,superfindPreview,superfindSettings} from './superfind.mjs';
import {subscriberFeatures,emptySubscriber,applySubscriberVote,styleScore,personalDeck,subscriberSummary} from './subscriber_taste.mjs';
import worker from './worker.mjs';
import {LocalD1} from './local_d1.mjs';
import {signedPreviewData} from './preview_server.mjs';
const NOW=Date.now(),DAY=86400000,context={currency:'RUB',destination:'-1257786',paymentBasis:'standard'},hash=id=>id.toString(16).padStart(64,'0');
const card=(id=101,patch={})=>({id,name:`Футболка fixture ${id}`,category:'Футболки',categoryVerified:true,type:'tshirt',price:800,priceSource:'wb_card',currency:'RUB',observedAt:NOW,stockObservedAt:NOW,available:true,rating:4.8,reviews:150,variantKey:'size-40',context,image:`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`,imageHash:hash(id),history:[7,14,21].map((day,i)=>({at:NOW-day*DAY,price:1000+i*100,source:'wb_card',currency:'RUB',variantKey:'size-40',context})),...patch});
const visual=(p,fields,patch={})=>({nmId:p.id,imageHash:p.imageHash,group:'apparel',reviewed:true,cacheVerified:true,fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{value,confidence:1,evidence:'Clearly visible on the real fixture image'}])),...patch});
const eligible=p=>assessSuperfind(p,{now:NOW,historyChecked:true});
test('superfind requires actual fresh price/stock/quality/history and formats preview only',()=>{
  const p=card(),a=eligible(p);assert.equal(a.eligible,true);assert.equal(a.reference.distinctDays,3);
  const preview=superfindPreview(p,a);assert.match(preview.caption,/СУПЕРНАХОДКА ДНЯ/);assert.match(preview.caption,/800 ₽/);
  assert.equal(preview.publication,'FORBIDDEN_PREVIEW');assert.equal(a.autoPublication,false);assert.equal(a.consumesExistingSlotOnly,true);
});
test('old seller sticker alone is never bargain evidence, even with a giant percentage',()=>{
  const p=card(101,{oldPrice:100000,history:[]}),a=eligible(p);assert.equal(a.eligible,false);assert.ok(a.reasons.includes('verified_savings_below_threshold_or_unknown'));
  assert.throws(()=>superfindPreview(p,a),/NOT_VERIFIED/);
});
test('missing/stale source, stock, quality, duplicate or photo fails closed',()=>{
  for(const patch of [{priceSource:'legacy_snapshot'},{observedAt:NOW-2*DAY},{available:null},{stockObservedAt:NOW-2*DAY},{stockObservedAt:undefined},{rating:4.2},{reviews:10},{price:0},{priceCondition:'club'},{qualityRisk:true},{imageHash:''},{image:'https://evil.example/1.webp'},{variantKey:null}])assert.equal(eligible(card(101,patch)).eligible,false,JSON.stringify(patch));
  assert.equal(assessSuperfind(card(),{now:NOW,historyChecked:false}).eligible,false);
  assert.equal(assessSuperfind(card(),{now:NOW,historyChecked:true,published:true}).eligible,false);
});
test('invalid quality settings cannot weaken universal gates or inflate saving',()=>{
  for(const p of [{minRating:3},{minReviews:1},{minSavings:0},{maxPriceAgeMinutes:9999},{enabled:'true'}])assert.throws(()=>superfindSettings(p));
  assert.equal(assessSuperfind(card(),{now:NOW,historyChecked:true,settings:{minSavings:40}}).eligible,false);
});
test('template escapes markup and uses normalized price timestamp',()=>{
  const p=card(101,{name:'<script>fixture & test</script>',observedAt:Math.floor(NOW/1000)}),preview=superfindPreview(p,eligible(p));
  assert.ok(!preview.caption.includes('<script>'));assert.ok(preview.caption.includes('&lt;script&gt;'));assert.ok(!preview.caption.includes('1970-'));
});
test('subscriber visual features require photo hash/review/group and never use title guesses',()=>{
  const p=card(),v=visual(p,{color:'black',fit:'oversize',style:'streetwear'});assert.ok(subscriberFeatures(p,v,NOW)['visual.fit=oversize']);
  for(const bad of [{...v,imageHash:'f'.repeat(64)},{...v,reviewed:false},{...v,cacheVerified:false},{...v,group:'bag'}])assert.ok(!Object.keys(subscriberFeatures(p,bad,NOW)).some(k=>k.startsWith('visual.')));
  assert.ok(!Object.hasOwn(subscriberFeatures({...p,name:'red fitted floral luxury'},null,NOW),'visual.color=red'));
  assert.ok(!Object.hasOwn(subscriberFeatures({...p,priceSource:'legacy_snapshot'},null,NOW),'budget=600–1000 ₽'));
  assert.ok(!Object.keys(subscriberFeatures({...p,brand:'Brand'},null,NOW)).some(k=>k.startsWith('brand=')));
  assert.ok(subscriberFeatures({...p,brand:'Brand',brandVerified:true},null,NOW)['brand=brand']);
});
test('repeated identical vote, switches and skip preserve distinct product counts',()=>{
  const vote={id:101,action:'like',features:{'category=Футболки':1}},m=applySubscriberVote(emptySubscriber(),null,vote);
  assert.equal(applySubscriberVote(m,vote,vote).samples,1);
  const switched=applySubscriberVote(m,vote,{...vote,action:'dislike'});assert.equal(switched.samples,1);assert.equal(switched.stats['category=Футболки'].positive,0);assert.equal(switched.stats['category=Футболки'].negative,1);
  const skipped=applySubscriberVote(switched,{...vote,action:'dislike'},{...vote,action:'skip'});assert.equal(skipped.samples,0);assert.equal(skipped.seen,1);assert.deepEqual(skipped.stats,{});
});
test('negative category is not a hard ban; group-specific visual blocks stay narrow',()=>{
  let model=emptySubscriber();for(let i=1;i<=5;i++)model=applySubscriberVote(model,null,{id:i,action:'block_similar',features:{'category=Сумки':1}});
  const bag=card(200,{category:'Сумки'});assert.equal(styleScore(bag,model,null,{now:NOW}).blocked,false);
  const bagVisual=visual(bag,{color:'black',shape:'structured',carry:'crossbody',size:'medium'},{group:'bag'}),features=subscriberFeatures(bag,bagVisual,NOW);
  model=applySubscriberVote(model,null,{id:199,action:'block_similar',features});assert.equal(styleScore(bag,model,bagVisual,{now:NOW}).blocked,true);
  assert.equal(styleScore(bag,model,visual(bag,{color:'black',shape:'soft',carry:'shoulder',size:'medium'},{group:'bag'}),{now:NOW}).blocked,false);
});
test('sequential diversity, seen/photo dedup and honest fresh-only filters',()=>{
  const cards=Array.from({length:24},(_,i)=>card(300+i,{category:['Футболки','Кеды','Сумки','Серьги'][i%4],history:[]}));
  const model=emptySubscriber(),deck=personalDeck(cards,model,{seenIds:[300],now:NOW});assert.equal(deck.length,20);assert.ok(!deck.some(p=>p.id===300));assert.equal(new Set(deck.slice(0,4).map(p=>p.group)).size,4);
  const duplicate=cards.map((p,i)=>({...p,imageHash:i<2?cards[0].imageHash:p.imageHash}));assert.equal(new Set(personalDeck(duplicate,model,{now:NOW}).map(p=>p.id)).size,20);
  assert.deepEqual(personalDeck(cards.map(p=>({...p,priceSource:'legacy_snapshot'})),model,{now:NOW,filters:{maxPrice:1000}}),[]);
  assert.equal(subscriberSummary(model).uplift,null);assert.equal(subscriberSummary(model).accuracy,null);
});
test('confirmed visual families outweigh weak category prior without pretending measured uplift',()=>{
  let model=emptySubscriber();for(let i=1;i<=5;i++){const p=card(i);model=applySubscriberVote(model,null,{id:i,action:'like',features:subscriberFeatures(p,visual(p,{color:'black',fit:'oversize',silhouette:'loose'}),NOW)});}
  const a=card(500),b=card(501),black=styleScore(a,model,visual(a,{color:'black',fit:'oversize',silhouette:'loose'}),{now:NOW}),red=styleScore(b,model,visual(b,{color:'red',fit:'slim',silhouette:'fitted'}),{now:NOW});
  assert.ok(black.score>red.score);assert.equal(black.confidence,'limited_visual_evidence');assert.equal(subscriberSummary(model).uplift,null);
});
async function fixture(file=':memory:'){
  const db=new LocalD1(file);db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  const products=Array.from({length:24},(_,i)=>({product:card(700+i,{category:['Футболки','Кеды','Сумки','Серьги'][i%4]}),visual:null}));
  for(const {product:p} of products)await db.prepare('INSERT OR REPLACE INTO feature_catalog(id,data,visual,checked_at) VALUES(?,?,?,?)').bind(p.id,JSON.stringify(p),'null',NOW).run();
  await db.prepare("INSERT OR REPLACE INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind(JSON.stringify({products})).run();
  const env={DB:db,FEATURE_PREVIEW:'1',MINIAPP_BOT_TOKEN:'unit-public-secret-not-real',TG_BOT_TOKEN:'unit-admin-secret-not-real',MINIAPP_ADMIN_ID:'33'},pending=[];
  const ctx={waitUntil:p=>pending.push(p)},auth=async(id,admin=false)=>signedPreviewData(id,admin?env.TG_BOT_TOKEN:env.MINIAPP_BOT_TOKEN);
  const call=async(route,{id=11,admin=false,method='GET',data,raw}={})=>worker.fetch(new Request('https://preview.test'+route,{method,headers:{'X-Telegram-Init-Data':raw??await auth(id,admin),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined}),env,ctx);
  return {db,env,call,products,pending,auth};
}
const command=(version,id,action='like',requestId='request-fixture-0001')=>({version,id,action,requestId});
test('public signature/main admin signature/owner gate; unauthenticated calls read zero rows',async()=>{
  const f=await fixture();try{f.db.queries=[];assert.equal((await f.call('/api/style/me',{raw:'forged'})).status,401);assert.equal(f.db.queries.length,0);
    assert.equal((await f.call('/api/admin/superfind',{id:33})).status,401);assert.equal((await f.call('/api/admin/superfind',{id:11,admin:true})).status,403);
    assert.equal((await f.call('/api/admin/superfind',{id:33,admin:true})).status,200);
    assert.equal((await f.call('/api/style/me',{id:11,admin:true})).status,401);
  }finally{f.db.close();}
});
test('first opening reads defaults, never inserts accounts or superfind settings',async()=>{
  const f=await fixture();try{await f.call('/api/style/me');await f.call('/api/admin/superfind',{id:33,admin:true});
    assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM style_accounts').get().n,0);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM superfind_settings').get().n,0);
  }finally{f.db.close();}
});
test('vote persistence, lost response replay, switches and client feature/identity rejection',async()=>{
  const f=await fixture();try{const input=command(0,700),one=await f.call('/api/style/vote',{method:'POST',data:input});assert.equal(one.status,200);await one.body.cancel();
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:input})).status,200);assert.equal((await (await f.call('/api/style/me')).json()).rated,1);
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:{...input,action:'dislike'}})).status,409);
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:command(1,700,'dislike','request-fixture-0002')})).status,200);
    const profile=JSON.parse(f.db.sqlite.prepare('SELECT model FROM style_accounts WHERE user_id=11').get().model);assert.equal(profile.samples,1);assert.equal(profile.stats['category=Футболки'].negative,1);
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:{...command(2,701),user_id:22}})).status,400);
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:{...command(2,701),features:{'visual.color=red':1}}})).status,400);
  }finally{f.db.close();}
});
test('two users never share personal history, favorites or preference summaries',async()=>{
  const f=await fixture();try{await f.call('/api/style/vote',{method:'POST',data:command(0,700)});
    await f.call('/api/style/favorite',{method:'POST',data:{version:1,id:700,saved:true,requestId:'request-fixture-save'}});
    const a=await (await f.call('/api/style/feed')).json(),b=await (await f.call('/api/style/feed',{id:22})).json();assert.ok(!a.items.some(p=>p.id===700));assert.ok(b.items.some(p=>p.id===700));
    assert.equal((await (await f.call('/api/style/me',{id:22})).json()).rated,0);assert.deepEqual((await (await f.call('/api/style/favorites',{id:22})).json()).items,[]);
    assert.equal((await (await f.call('/api/style/favorites')).json()).items[0].id,700);
  }finally{f.db.close();}
});
test('concurrent same-version actions yield one winner without partial votes/counters',async()=>{
  const f=await fixture();try{const responses=await Promise.all([f.call('/api/style/vote',{method:'POST',data:command(0,700,'like','request-fixture-race1')}),f.call('/api/style/vote',{method:'POST',data:command(0,701,'dislike','request-fixture-race2')})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=11').get().n,1);
    assert.equal((await (await f.call('/api/style/me')).json()).rated,1);
  }finally{f.db.close();}
});
test('reset removes only that subscriber history/profile and rejects stale pre-reset writes',async()=>{
  const f=await fixture();try{const old=command(0,700);await f.call('/api/style/vote',{method:'POST',data:old});await f.call('/api/style/vote',{id:22,method:'POST',data:command(0,701)});
    const reset=await f.call('/api/style/me',{method:'DELETE',data:{version:1,requestId:'request-fixture-reset'}});assert.equal(reset.status,200);
    assert.equal((await (await f.call('/api/style/me')).json()).rated,0);assert.equal((await (await f.call('/api/style/me',{id:22})).json()).rated,1);
    assert.equal((await f.call('/api/style/vote',{method:'POST',data:old})).status,409);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=11').get().n,0);
  }finally{f.db.close();}
});
test('indexed point/range queries and shared one-row catalogue, no history/count scans per click',async()=>{
  const f=await fixture();try{f.db.queries=[];await f.call('/api/style/feed');assert.ok(f.db.queries.some(x=>x.sql.includes('shared_catalog_snapshot')));
    assert.ok(!f.db.queries.some(x=>/count\(|SELECT.+FROM feature_catalog ORDER|SELECT.+FROM style_votes ORDER/i.test(x.sql)));
    for(const [sql,args] of [['SELECT pid FROM style_votes WHERE user_id=? AND pid=?',[11,700]],['SELECT pid FROM style_saved WHERE user_id=? ORDER BY ts DESC LIMIT 100',[11]],['SELECT payload FROM feature_requests WHERE user_id=? AND id=?',[11,'request-fixture-0001']]]){
      const plan=f.db.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all(...args).map(x=>x.detail).join(' ');assert.match(plan,/SEARCH/);assert.ok(!/SCAN style_/.test(plan));
    }
  }finally{f.db.close();}
});
test('optional quota exhaustion stops features, no scheduler/AI/Telegram paths exist',async()=>{
  const f=await fixture();try{await f.db.prepare('INSERT INTO feature_budget VALUES(?,?,?)').bind(new Date().toISOString().slice(0,10),50000,8000).run();assert.equal((await f.call('/api/style/me')).status,429);
    assert.equal(worker.scheduled,undefined);assert.equal((await f.call('/api/admin/superfind/publish',{id:33,admin:true,method:'POST',data:{}})).status,429);
  }finally{f.db.close();}
});
test('refresh acknowledges202, durable job completes once, preview approval never sends a post',async()=>{
  const f=await fixture();try{await f.db.prepare("INSERT INTO feature_meta VALUES('publication_history_complete','1')").run();
    const settings=await f.call('/api/admin/superfind/settings',{id:33,admin:true,method:'PUT',data:{version:0,requestId:'request-fixture-setting',settings:{enabled:true}}});assert.equal(settings.status,200);
    const request={requestId:'request-fixture-refresh'},r=await f.call('/api/admin/superfind/refresh',{id:33,admin:true,method:'POST',data:request});assert.equal(r.status,202);
    await Promise.all(f.pending);const job=await (await f.call('/api/admin/superfind/job?id='+request.requestId,{id:33,admin:true})).json();assert.equal(job.status,'done');assert.ok(job.eligible>0);
    const preview=await (await f.call('/api/admin/superfind',{id:33,admin:true})).json();assert.equal(preview.publicationEnabled,false);assert.ok(preview.candidates[0].preview.caption.includes('800 ₽'));
    const decision=await f.call('/api/admin/superfind/decision',{id:33,admin:true,method:'POST',data:{version:1,requestId:'request-fixture-approve',id:preview.candidates[0].id,action:'approve'}});assert.equal(decision.status,200);assert.equal((await decision.json()).publication,'FORBIDDEN_PREVIEW');
    assert.equal((await f.call('/api/admin/superfind/publish',{id:33,admin:true,method:'POST',data:{}})).status,404);
  }finally{f.db.close();}
});
test('stale job lease is reclaimed; stale candidate price cannot be approved',async()=>{
  const f=await fixture();try{await f.db.prepare("INSERT INTO feature_jobs(id,status,created_at,lease_until) VALUES(?,'running',?,?)").bind('request-fixture-stale',NOW-60000,NOW-1).run();
    await f.call('/api/admin/superfind/job?id=request-fixture-stale',{id:33,admin:true});await Promise.all(f.pending);assert.equal(f.db.sqlite.prepare('SELECT status FROM feature_jobs').get().status,'done');
    const candidates=await (await f.call('/api/admin/superfind',{id:33,admin:true})).json();assert.equal(candidates.candidates.length,0);assert.ok(candidates.rejected.some(p=>p.reasons.includes('publication_history_unverified')));
  }finally{f.db.close();}
});
test('SQLite restart preserves only subscriber-owned ratings/filters',async()=>{
  const root=fileURLToPath(new URL('../../.test-temp/feature-tests/',import.meta.url));await fs.mkdir(root,{recursive:true});const folder=await fs.mkdtemp(path.join(root,'restart-')),file=path.join(folder,'local.sqlite3');
  const f=await fixture(file);await f.call('/api/style/vote',{method:'POST',data:command(0,700)});f.db.close();const restarted=await fixture(file);
  try{assert.equal((await (await restarted.call('/api/style/me')).json()).rated,1);assert.equal((await (await restarted.call('/api/style/me',{id:22})).json()).rated,0);}finally{restarted.db.close();}
});
test('disabled preview, foreign origin and forged body are denied before application writes',async()=>{
  const f=await fixture();try{
    f.env.FEATURE_PREVIEW='0';f.db.queries=[];assert.equal((await f.call('/api/style/me')).status,404);assert.equal(f.db.queries.length,0);f.env.FEATURE_PREVIEW='1';
    const r=await worker.fetch(new Request('https://preview.test/api/style/me',{headers:{Origin:'https://other.test','X-Telegram-Init-Data':await f.auth(11)}}),f.env);assert.equal(r.status,403);
    assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM style_accounts').get().n,0);
  }finally{f.db.close();}
});
test('concurrent refresh IDs have a single atomic slot; slow work does not delay HTTP202',async()=>{
  const f=await fixture();let unblock;const waiting=new Promise(resolve=>unblock=resolve),prepare=f.db.prepare.bind(f.db);
  f.db.prepare=sql=>{const statement=prepare(sql);if(sql.includes('shared_catalog_snapshot')){const first=statement.first;statement.first=async function(){await waiting;return first.call(this);};}return statement;};
  try{
    const started=performance.now(),first=await f.call('/api/admin/superfind/refresh',{id:33,admin:true,method:'POST',data:{requestId:'request-fixture-single1'}});
    assert.equal(first.status,202);assert.ok(performance.now()-started<500);
    const second=await f.call('/api/admin/superfind/refresh',{id:33,admin:true,method:'POST',data:{requestId:'request-fixture-single2'}});assert.equal(second.status,409);
    assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM feature_jobs').get().n,1);
    unblock();await Promise.all(f.pending);assert.equal(f.db.sqlite.prepare('SELECT status FROM feature_jobs').get().status,'done');
  }finally{unblock();await Promise.all(f.pending);f.db.close();}
});

test('replaying a completed refresh neither rewrites candidates nor leaves its slot busy',async()=>{
  const f=await fixture();try{
    const call=id=>f.call('/api/admin/superfind/refresh',{id:33,admin:true,method:'POST',data:{requestId:id}});
    assert.equal((await call('request-fixture-finished')).status,202);await Promise.all(f.pending);
    f.db.queries=[];assert.equal((await call('request-fixture-finished')).status,202);await Promise.all(f.pending);
    assert.ok(!f.db.queries.some(q=>q.sql.startsWith('INSERT INTO superfind_candidates')));
    assert.equal(f.db.sqlite.prepare('SELECT expires FROM feature_job_lock WHERE id=1').get().expires,0);
    assert.equal((await call('request-fixture-finished-next')).status,202);await Promise.all(f.pending);
    assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM feature_jobs WHERE status='done'").get().n,2);
  }finally{f.db.close();}
});
test('overnight candidates are revalidated on read and cannot be approved on old evidence',async()=>{
  const f=await fixture();try{
    await f.db.prepare("INSERT INTO feature_meta VALUES('publication_history_complete','1')").run();
    await f.call('/api/admin/superfind/settings',{id:33,admin:true,method:'PUT',data:{version:0,requestId:'request-fixture-fresh-set',settings:{enabled:true}}});
    await f.call('/api/admin/superfind/refresh',{id:33,admin:true,method:'POST',data:{requestId:'request-fixture-fresh-job'}});await Promise.all(f.pending);
    const before=await (await f.call('/api/admin/superfind',{id:33,admin:true})).json();assert.ok(before.candidates.length);
    for(const item of f.products){item.product.observedAt=NOW-2*DAY;item.product.stockObservedAt=NOW-2*DAY;await f.db.prepare('UPDATE feature_catalog SET data=? WHERE id=?').bind(JSON.stringify(item.product),item.product.id).run();}
    await f.db.prepare("UPDATE feature_meta SET value=? WHERE key='shared_catalog_snapshot'").bind(JSON.stringify({products:f.products})).run();
    const after=await (await f.call('/api/admin/superfind',{id:33,admin:true})).json();assert.equal(after.candidates.length,0);assert.ok(after.rejected.some(item=>item.reasons.includes('price_not_fresh_verified')));
    assert.equal((await f.call('/api/admin/superfind/decision',{id:33,admin:true,method:'POST',data:{version:1,requestId:'request-fixture-stale-approve',id:before.candidates[0].id,action:'approve'}})).status,409);
  }finally{f.db.close();}
});
