import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {ownerCategory,ownerReason,productType,qualitySettings,summariseVotes,candidateQuality,qualityRank,QUALITY_CATEGORIES} from './audience_quality.mjs';
import {audienceContext,FEEDBACK_SQL} from './audience_feedback.mjs';
import {reconcileOwnerInventory} from './audience_inventory.mjs';
import {adminEnvironment,adminRequest,rawPolicy,testCard} from './admin_test_support.mjs';
import {ensureReactions,vote} from './feedback.mjs';
import {ensureLearning} from './learning.mjs';
import {subjectURL,enrichSubject} from './product_subject.mjs';
import {withReadBudget} from './read_guard.mjs';
import {bootstrap,cardDeal,choose,nativeTick,runDiscovery} from './native_scheduler.mjs';
import {discoveryQueries} from './query_control.mjs';
const proposed={enabled:true,excluded:Object.keys(QUALITY_CATEGORIES),feedback_enabled:true,fashion_priority:true};
const policy={audience_quality:proposed};
const image='https://basket-01.wbbasket.ru/vol0/part0/777/images/big/1.webp';
const product=(id,title='Футболка хлопок')=>({id,title,category:'другое',query:'футболка мужская',product:700,rating:4.9,feedbacks:50,image});
const row=p=>({pid:p.id,data:JSON.stringify(p),topic:p.query,title_key:p.title,checked_at:1,queued_at:p.id});
const index=e=>e.db.exec(readFileSync(new URL('./audience_quality.sql',import.meta.url),'utf8'));
async function setup(t){const e=await adminEnvironment(t);await ensureReactions(e);await ensureLearning(e);index(e);e.MINIAPP_SYNC_KEY='offline-only-not-a-credential';return e;}
function insert(e,p,state='ready'){e.db.prepare('INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,state) VALUES(?,?,?,?,?,?,?,?)').run(p.id,JSON.stringify(p),p.query,p.title,p.id,Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)+86400,state);}
test('all five owner categories and academic titles with missing WB subject are excluded',()=>{
 for(const [title,type] of [['Учебник Химия','textbooks'],['Рабочая тетрадь 9 класс','notebooks'],['ОГЭ 2027 Химия 30 вариантов','study_aids'],['Таблица Менделеева. Формат А6','study_aids'],['Химия в таблицах и схемах. 8-11 классы','study_aids'],['Путеводитель по ФГОС дошкольного образования','study_aids'],['Ручки шариковые набор','stationery'],['Книга Роман приключений','books']]){
  const p=product(1,title);assert.equal(ownerCategory(p),type,title);assert.match(ownerReason(p,policy),/Запрет владельца/);assert.equal(cardDeal({...testCard(),name:title,subjectName:'другое'},policy),null);
 }
});
test('no blanket ban on home/chemistry/electronics or fashion mentioning school supplies',()=>{
 for(const title of ['Бытовая химия для кухни','Сумка для учебников','Футболка с принтом книга','Лонгслив школьный','Ручка для сумки металлическая','Электронная книга ридер','Кроссовки женские','Плед на кровать']){
  const p=product(1,title);if(title==='Ручка для сумки металлическая')p.category='Фурнитура для сумок';
  assert.equal(ownerReason(p,policy),null,title);
 }
 assert.equal(ownerReason({...product(1,'Новый товар'),category:'Учебники'},policy),'Запрет владельца: Учебники');
});
test('feature is OFF by default and owner can re-enable one category, not everything',()=>{
 const p=product(1,'Учебник Химия');assert.equal(ownerReason(p,{}),null);assert.equal(qualitySettings({}).enabled,false);
 assert.equal(ownerReason(p,{audience_quality:{...proposed,excluded:proposed.excluded.filter(k=>k!=='textbooks')}}),null);
 assert.ok(ownerReason(product(2,'Книга приключений'),policy));
});
test('old queued banned items cannot be chosen; empty quality pool skips, no fallback bypass',()=>{
 const a=row(product(1,'Рабочая тетрадь')),b=row(product(2,'Сумка женская'));
 assert.equal(choose([a,b],[],0,policy).pid,2);assert.equal(choose([a],[],0,policy),null);
 assert.equal(discoveryQueries({...policy,queries:['Учебники','Тетради','Канцелярия','Сумка женская'],disabled_topics:[]}).join(','),'Сумка женская');
});
test('positive votes improve ranking; two users cannot penalise an entire type',()=>{
 const rows=[];for(let pid=1;pid<=8;pid++)for(let n=0;n<2;n++)rows.push({pid,voter:'person'+n,sentiment:'d',data:product(pid)});
 const c=summariseVotes(rows),t=c.traits.get('type:tshirt');assert.equal(t.sufficient,false);assert.equal(t.multiplier,1);assert.equal(t.people,2);
 const good=product(20);c.items.set(20,{likes:5,dislikes:0});assert.ok(candidateQuality(good,policy,c).score>candidateQuality(product(21),policy,c).score);
});
test('stable independent negative feedback downranks a narrow type, but NEVER bans it',()=>{
 const rows=[];for(let pid=1;pid<=4;pid++)for(let n=0;n<5;n++)rows.push({pid,voter:'person'+n,sentiment:'d',data:product(pid)});
 const c=summariseVotes(rows),v=candidateQuality(product(9),policy,c);assert.equal(c.traits.get('type:tshirt').sufficient,true);assert.ok(v.score<1.15);assert.equal(v.allowed,true);
 const bag=candidateQuality(product(10,'Сумка женская'),policy,c);assert.ok(bag.score>v.score);
 assert.equal(candidateQuality(product(11,'Тетрадь'),policy,c).allowed,false);
 const positive=summariseVotes(rows.map(r=>({...r,sentiment:'l'})));assert.ok(candidateQuality(product(9),policy,positive).score>candidateQuality(product(9),policy).score);
});
test('diversity is soft and available good categories remain eligible',()=>{
 const a=row(product(1)),b=row(product(2,'Сумка женская')),recent=[row(product(10)),row(product(11))];
 assert.equal(qualityRank([a,b],recent,policy)[0].pid,2);assert.equal(qualityRank([a],recent,policy)[0].pid,1);
});
test('organizers FOR shoes are not treated as fashion; weak majority is not a stable negative trait',()=>{
 assert.equal(productType(product(1,'Органайзер для хранения обуви')),'query:футболка мужская');
 const rows=[];for(let n=0;n<12;n++)rows.push({pid:1+n%4,voter:'person'+n%5,sentiment:n<7?'d':'l',data:product(1+n%4)});
 const trait=summariseVotes(rows).traits.get('type:tshirt');assert.equal(trait.sufficient,true);assert.equal(trait.direction,'insufficient');assert.equal(trait.multiplier,1);
});
test('official CDN subject checks nmId, caches current metadata and does not invent style',async()=>{
 const p=product(777,'Сборник неизвестного названия');let calls=0;
 const fetcher=async url=>{calls++;assert.ok(url.endsWith('/777/info/ru/card.json'));return Response.json({nm_id:777,subj_name:'Учебники',subj_root_name:'Книжная продукция и диски'});};
 const result=await enrichSubject(p,fetcher,{now:100});assert.equal(result.category,'Учебники');assert.ok(ownerReason(result,policy));assert.equal(result.style,undefined);
 assert.equal((await enrichSubject(p,fetcher,{cached:result,now:200})).category,'Учебники');assert.equal(calls,1);
 assert.equal((await enrichSubject(p,async()=>Response.json({nm_id:999,subj_name:'Учебники'}))).category,'другое');
 assert.equal((await enrichSubject(p,async()=>{throw Error('timeout');})).category,'другое');
 for(const bad of ['https://evil.test/777/images/big/1.webp','http://basket-01.wbbasket.ru/777/images/big/1.webp','https://basket-01.wbbasket.ru/888/images/big/1.webp'])assert.equal(subjectURL({...p,image:bad}),null);
});
test('real storage vote switches/retries count current sentiment once, not cumulative events',async t=>{
 const e=await setup(t);insert(e,product(777));
 await vote(e,{pid:777,voter:'a',action:'l',event_id:1});await vote(e,{pid:777,voter:'a',action:'l',event_id:2});
 await vote(e,{pid:777,voter:'b',action:'l',event_id:3});await vote(e,{pid:777,voter:'a',action:'d',event_id:4});
 await vote(e,{pid:777,voter:'a',action:'l',event_id:2});
 const c=await audienceContext(e);assert.equal(c.likes,1);assert.equal(c.dislikes,1);assert.equal(c.sampled_votes,2);
 await vote(e,{scope:'test:private',pid:777,voter:'c',action:'d',event_id:5});assert.equal((await audienceContext(e)).dislikes,1);
 const plan=e.db.prepare('EXPLAIN QUERY PLAN '+FEEDBACK_SQL).all().map(r=>r.detail).join('\n');assert.match(plan,/reaction_votes_quality_recent/);assert.doesNotMatch(plan,/SCAN reaction_votes/);assert.match(plan,/INTEGER PRIMARY KEY/);
});
test('feedback missing index fails open ONLY for soft scores, never for explicit bans',async t=>{
 const e=await setup(t);e.db.exec('DROP INDEX reaction_votes_quality_recent');const c=await audienceContext(e);assert.equal(c.available,false);assert.equal(candidateQuality(product(1,'Учебник'),policy,c).allowed,false);
});
test('owner quarantine preserves history and can restore a re-enabled category safely',async t=>{
 const e=await setup(t),p=product(777,'Рабочая тетрадь');insert(e,p);insert(e,product(778,'Сумка женская'));
 await reconcileOwnerInventory(e,policy,Math.floor(Date.now()/1000));assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=777').get().state,'owner_excluded');
 assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=778').get().state,'ready');
 await reconcileOwnerInventory(e,{audience_quality:{...proposed,excluded:[]}},Math.floor(Date.now()/1000));assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=777').get().state,'ready');
 assert.deepEqual(JSON.parse(e.db.prepare('SELECT data FROM scheduler_inventory WHERE pid=777').get().data),p);
});
test('quality GET cannot save defaults; owner-only confirmed idempotent CAS save preserves production settings',async t=>{
 const e=await setup(t),before=rawPolicy(e),schedule=e.db.prepare('SELECT data FROM scheduler_config').get().data;
 assert.equal((await adminRequest(e,'/api/admin/selection/quality','GET',null,22)).status,403);
 const r=await(await adminRequest(e,'/api/admin/selection/quality')).json();assert.equal(rawPolicy(e),before);assert.equal(r.settings.enabled,false);
 assert.equal((await adminRequest(e,'/api/admin/selection/quality','PUT',{revision:r.revision,settings:proposed})).status,400);
 const input={revision:r.revision,settings:proposed,confirmed:true,request_id:'once'};
 assert.equal((await adminRequest(e,'/api/admin/selection/quality','PUT',input)).status,200);
 assert.equal((await(await adminRequest(e,'/api/admin/selection/quality','PUT',input)).json()).duplicate,true);
 const after=JSON.parse(rawPolicy(e));delete after.audience_quality;assert.deepEqual(after,JSON.parse(before));assert.equal(e.db.prepare('SELECT data FROM scheduler_config').get().data,schedule);
 assert.equal(e.db.prepare("SELECT COUNT(*) n FROM admin_changes WHERE scope='audience_quality'").get().n,1);
 const history=await(await adminRequest(e,'/api/admin/config/history')).json(),current=await(await adminRequest(e,'/api/admin/selection/quality')).json();
 assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:history.items[0].id,revision:current.revision,confirmed:true,request_id:'restore'})).status,200);
 assert.equal(JSON.parse(rawPolicy(e)).audience_quality.enabled,false);
});
test('legacy bootstrap cannot replace owner quality rules or insert forbidden cards',async t=>{
 const e=await setup(t);e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(rawPolicy(e)),...policy}));
 await bootstrap(e,{queue:[product(777,'Учебник'),product(778)],posts:[],policy:{chat_id:'-1234567',queries:['футболка мужская']}});
 assert.deepEqual(JSON.parse(rawPolicy(e)).audience_quality,proposed);assert.equal(e.db.prepare('SELECT pid FROM scheduler_inventory WHERE pid=777').get(),undefined);assert.ok(e.db.prepare('SELECT pid FROM scheduler_inventory WHERE pid=778').get());
});
test('active-quality native cycle rejects hidden book via official subject, posts once and keeps Free query limit',async t=>{
 const e=await setup(t);insert(e,product(777,'Необычная находка'));insert(e,product(778,'Худи мужское'));
 e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(rawPolicy(e)),...policy}));
 const before=e.calls;let sent=0;
 const result=await withReadBudget(e,'core',25000,env=>nativeTick(env,Date.now(),async(url,options)=>{
  if(url.includes('sendPhoto')){sent++;assert.ok(options.body.includes('778'));return Response.json({ok:true,result:{message_id:12345}});}
  if(url.includes('/info/ru/card.json'))return Response.json({nm_id:Number(url.match(/\/(\d+)\/info/)[1]),subj_name:url.includes('/777/')?'Учебники':'Худи',subj_root_name:'Одежда'});
  if(url.includes('wbbasket.ru'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
  const id=Number(new URL(url).searchParams.get('nm'));return Response.json({products:[{...testCard(id),subjectName:'другое',name:id===777?'Необычная находка':'Худи мужское'}]});
 }));
 assert.equal(result.results.post.result,'success');assert.equal(result.results.post.product_id,778);assert.equal(sent,1);assert.ok(e.calls-before<=50,'D1 calls '+(e.calls-before));
 assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
 const next=await nativeTick(e,Date.now(),async url=>{assert.ok(!url.includes('sendPhoto'));return Response.json({products:[]});});assert.equal(sent,1);assert.ok(!next.results.post);
});
test('all banned inventory leads to no publication and the next idle maintenance frees reserve without deleting rows',async t=>{
 const e=await setup(t);insert(e,product(777,'Тетрадь'));e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(rawPolicy(e)),...policy}));
 const fetcher=async url=>{assert.ok(!url.includes('sendPhoto'));return Response.json({products:[]});};
 const first=await nativeTick(e,Date.now(),fetcher);assert.equal(first.results.post.result,'no_eligible_product');
 await nativeTick(e,Date.now(),fetcher);assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory WHERE pid=777').get().state,'owner_excluded');assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_inventory').get().n,1);
});
test('search never admits textbooks/notebooks or a hidden CDN-classified book into inventory',async t=>{
 const e=await setup(t);e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(rawPolicy(e)),...policy}));
 const cards=[{...testCard(777),name:'Учебник',subjectName:'Учебники'},{...testCard(778),name:'Тетрадь',subjectName:'Тетради'},{...testCard(779),name:'Новая находка',subjectName:'другое'},testCard(780)];
 const result=await runDiscovery(e,{},async url=>{
  assert.ok(!url.includes('api.telegram.org'));
  if(url.includes('/info/ru/card.json'))return Response.json({nm_id:Number(url.match(/\/(\d+)\/info/)[1]),subj_name:'Учебные пособия',subj_root_name:'Книжная продукция и диски'});
  if(url.includes('wbbasket.ru'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
  return Response.json({products:cards});
 });assert.equal(result.added,1);assert.deepEqual(e.db.prepare('SELECT pid FROM scheduler_inventory').all().map(r=>r.pid),[780]);
});
test('a ban saved during slow WB validation is re-read before claim, next valid item sends exactly once',async t=>{
 const e=await setup(t);insert(e,product(777,'Необычная находка'));insert(e,product(778,'Худи мужское'));let sent=0;
 const result=await nativeTick(e,Date.now(),async(url,options)=>{
  if(url.includes('sendPhoto')){sent++;assert.ok(options.body.includes('778'));return Response.json({ok:true,result:{message_id:12346}});}
  if(url.includes('wbbasket.ru'))return new Response('fixture',{headers:{'content-type':'image/webp'}});
  const id=Number(new URL(url).searchParams.get('nm'));
  if(id===777)e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(rawPolicy(e)),...policy}));
  return Response.json({products:[{...testCard(id),subjectName:id===777?'Учебники':'Худи',name:id===777?'Учебник':'Худи мужское'}]});
 });assert.equal(result.results.post.product_id,778);assert.equal(sent,1);assert.equal(e.db.prepare('SELECT pid FROM scheduler_claims WHERE pid=777').get(),undefined);
});
