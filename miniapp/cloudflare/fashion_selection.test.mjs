import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {assessFashion,chooseFashion,fashionMetadata,FASHION_TARGETS} from './fashion_selection.mjs';
import {enrichSubject} from './product_subject.mjs';import {bootstrap,nativeTick} from './native_scheduler.mjs';
import {ensureLearning,shadowChoice,recordEvent,learningRoute} from './learning.mjs';import {adminEnvironment} from './admin_test_support.mjs';
import {ensureReactions} from './feedback.mjs';
const policy={max_price:1000,min_rating:4.3,audience_quality:{enabled:true,excluded:['textbooks','study_aids','notebooks','stationery','books'],feedback_enabled:true,fashion_priority:true}};
const p=(id=1,category='Футболки',gender='Мужской')=>{const r={id,title:'Товар '+id,category,category_source:'wb-cdn',product:700,rating:4.8,feedbacks:100,image:`https://basket-01.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`};r.fashion_metadata=fashionMetadata({nm_id:id,options:[{name:'Пол',value:gender}]},r,1);return r;};
const row=p=>({pid:p.id,data:JSON.stringify(p),topic:'topic-'+p.id,title_key:'title-'+p.id,queued_at:p.id,checked_at:1});
const profile=(fields={},group='apparel')=>({version:2,group,fields:Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{value:v,confidence:.95,evidence:'Visible product geometry',hypothesis:k==='style'}]))});
test('fashion scope requires observed category, owner bans always win and title is never positive proof',()=>{
 for(const c of ['Книги','Тетради','Средства для мытья посуды','Постельное белье','Кухонные ножи','Пижамы'])assert.equal(assessFashion(p(1,c),policy).allowed,false,c);
 assert.equal(assessFashion({...p(),category:'другое',title:'streetwear oversized hoodie модный'},policy).allowed,false);
 assert.equal(assessFashion({...p(),category_source:undefined},policy).reason,'CATEGORY_UNCONFIRMED');
 assert.equal(assessFashion({...p(),title:'Футболка детская'},policy).reason,'CHILD_OR_UTILITY');
 const a=assessFashion({...p(),title:'Футболка оверсайз streetwear с принтом на спине'},policy);assert.equal(a.score,1);assert.deepEqual(a.visual,{});
 assert.match(assessFashion({...p(),title:'Учебник'},policy).reason,/Запрет/);
 assert.equal(assessFashion({...p(),image:''},policy).reason,'PHOTO_UNAVAILABLE');
});
test('official metadata uses exact item/photo and ignores query/title gender and invented fashion descriptions',()=>{
 const item={...p(),fashion_metadata:null,title:'Футболка женская тренд streetwear'};assert.equal(assessFashion(item,policy).reason,'APPAREL_AUDIENCE_UNCONFIRMED');
 assert.equal(fashionMetadata({nm_id:2,options:[]},item,1),null);
 item.fashion_metadata={...p().fashion_metadata,image:'https://other/1.webp'};assert.equal(assessFashion(item,policy).allowed,false);
 const m=fashionMetadata({nm_id:1,options:[{name:'Пол',value:'Мужской; Женский'},{name:'Стиль',value:'streetwear'}]},p(),1);assert.equal(m.audience,'unisex');assert.equal('стиль' in m.options,false);
});
test('known photo fields help; hypotheses, low confidence, wrong group and contradictory cut do not',()=>{
 const a=assessFashion(p(),policy,profile({fit:'oversize',silhouette:'loose',pattern:'graphic',style:'streetwear'}));assert.ok(Math.abs(a.score-1.28)<1e-10);assert.equal(a.reasons.includes('REVIEWED_PHOTO_STYLE'),false);
 assert.equal(assessFashion(p(),policy,profile({shape:'chunky'},'shoes')).score,1);
 const weak=profile({fit:'oversize'});weak.fields.fit.confidence=.7;assert.equal(assessFashion(p(),policy,weak).score,1);
 const item=p();item.fashion_metadata.options['покрой']='оверсайз';assert.equal(assessFashion(item,policy,profile({fit:'slim'})).reason,'CUT_PHOTO_CONFLICT');
});
test('40 real pilot selections respect 14/14/8/4 with no repeated pair beyond two and stop at 40',()=>{
 const rows=[];for(let i=0;i<20;i++)for(const [j,c,g] of [[0,'Футболки','Мужской'],[1,'Джинсы','Женский'],[2,'Кроссовки','Мужской'],[3,'Сумки','Женский']])rows.push(row(p(100+i*4+j,c,g)));
 const history=[],recent=[];let pool=rows;while(history.length<40){const r=chooseFashion(pool,recent,policy,{},history);assert.ok(r.proposed_pid,r.reason);const picked=pool.find(x=>x.pid===r.proposed_pid);history.push({...picked,fashion_bucket:r.bucket});recent.push(picked);pool=pool.filter(x=>x!==picked);}
 const counts=Object.fromEntries(Object.keys(FASHION_TARGETS).map(k=>[k,history.filter(x=>x.fashion_bucket===k).length]));assert.deepEqual(counts,FASHION_TARGETS);assert.equal(chooseFashion(pool,recent,policy,{},history).reason,'PILOT_COMPLETE_REVIEW_REQUIRED');
});
test('bucket shortages and repetitive queue cause a skip, never a household or quota renormalization',()=>{
 const history=Array.from({length:4},(_,i)=>({...row(p(i+1,'Сумки')),fashion_bucket:'accessories'}));
 assert.equal(chooseFashion([row(p(100,'Сумки')),row(p(101,'Пледы'))],[],policy,{},history).proposed_pid,null);
 const recent=[row(p(1)),row(p(2))];assert.equal(chooseFashion([row(p(3))],recent,policy).proposed_pid,null);
 assert.equal(chooseFashion([row(p(3)),row(p(4,'Лонгсливы','Женский'))],recent,policy).proposed_pid,4);
 const many={items:new Map([[3,{likes:0,dislikes:10000}]]),traits:new Map([['type:tshirt',{sufficient:true,multiplier:.01}]])};const r=chooseFashion([row(p(3))],[],policy,many);assert.equal(r.proposed_pid,3);assert.ok(r.candidates[0].itemAdjustment>=-.025);
});
test('enrichment reuses official endpoint; opt-out performs no extra request for known categories',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({nm_id:1,subj_name:'Футболки',subj_root_name:'Одежда',options:[{name:'Пол',value:'Женский'}]});};
 const known={...p(),fashion_metadata:undefined};await enrichSubject(known,fetcher);await enrichSubject(known,fetcher,{fashion:true});assert.equal(calls,0);
 const item={...known,category:'другое'};const enriched=await enrichSubject(item,fetcher,{fashion:true,now:10});assert.equal(calls,1);assert.equal(enriched.fashion_metadata.audience,'women');
 await enrichSubject(item,fetcher,{fashion:true,cached:enriched,now:20});assert.equal(calls,1);
});
test('SHADOW receipt is saved separately from all learning features, including feedback/train exports',async t=>{
 const e=await adminEnvironment(t);await ensureLearning(e);const rows=[row(p(900))];const receipt={proposed_pid:901,actual_selection:'LEGACY'};
 await shadowChoice(e,rows,rows[0],100,'Europe/Moscow',receipt);assert.deepEqual(JSON.parse(e.db.prepare('SELECT features FROM learning_shadow').get().features)._fashion_shadow,receipt);
 await recordEvent(e,{key:'fashion-fixture-vote',pid:900,kind:'like',ts:110});assert.equal('_fashion_shadow' in JSON.parse(e.db.prepare('SELECT features FROM learning_events').get().features),false);
 const exported=await(await learningRoute(new Request('https://local/api/learning/train'),e,{json:Response.json,payload:r=>r.json(),fail:(s,m)=>{throw Error(m);}})).json();assert.equal('_fashion_shadow' in JSON.parse(exported.shadows[0].features),false);
});
test('passive fashion mode proposes within scope without changing the real Telegram payload or interval',async t=>{
 const run=async enabled=>{const e=await adminEnvironment(t);await ensureReactions(e);await ensureLearning(e);e.db.exec(readFileSync(new URL('./audience_quality.sql',import.meta.url),'utf8'));
  const queue=[p(900,'Средства для мытья посуды'),p(901)];await bootstrap(e,{queue,posts:[],policy:{...policy,chat_id:'-100123456789',queries:['Химия','футболки']}});
  const cfg=JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data);e.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...cfg,search_enabled:false,post_interval_minutes:30}));
  if(enabled){e.FASHION_SHADOW_ENABLED='1';e.FASHION_PILOT_START=String(Math.floor(Date.now()/1000)-1);}
  const sent=[];const r=await nativeTick(e,Date.now(),async(url,opts)=>{const u=new URL(url);if(u.hostname==='api.telegram.org'){sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:7777}});}if(u.pathname.endsWith('card.json')){const id=Number(u.pathname.split('/').at(-4));return Response.json({nm_id:id,subj_name:queue.find(x=>x.id===id)?.category||'Футболки',subj_root_name:'Одежда',options:[{name:'Пол',value:'Мужской'}]});}if(u.hostname.endsWith('.wbbasket.ru'))return new Response('fixture',{headers:{'content-type':'image/webp'}});const id=Number(u.searchParams.get('nm'));const item=queue.find(x=>x.id===id);return Response.json({products:[{id,name:item.title,subjectName:item.category,reviewRating:4.8,feedbacks:100,sizes:[{qty:10,price:{product:70000,basic:70000}}]}]});});
  assert.equal(r.results.post.result,'success');const shadow=JSON.parse(e.db.prepare('SELECT features FROM learning_shadow').get().features);assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);return {sent,shadow};};
 const off=await run(false),on=await run(true);assert.deepEqual(off.sent,on.sent);assert.equal('_fashion_shadow' in off.shadow,false);assert.equal(on.shadow._fashion_shadow.actual_selection,'LEGACY');assert.equal(on.shadow._fashion_shadow.proposed_pid,901);
});
