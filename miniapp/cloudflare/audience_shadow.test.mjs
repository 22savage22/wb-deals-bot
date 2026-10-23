import test from 'node:test';import assert from 'node:assert/strict';
import {buildAudienceEvidence,audienceFactor,audienceKeys,audienceProposal,audienceReceipt,signTest} from './audience_shadow.mjs';
import {choose} from './native_scheduler.mjs';import {summariseVotes,QUALITY_CATEGORIES} from './audience_quality.mjs';
import {adminEnvironment} from './admin_test_support.mjs';import {ensureLearning,shadowChoice,recordEvent,learningRoute} from './learning.mjs';
import {ensureReactions} from './feedback.mjs';import {bootstrap,nativeTick} from './native_scheduler.mjs';import {readFileSync} from 'node:fs';
const policy={max_price:1000,audience_quality:{enabled:true,feedback_enabled:true,fashion_priority:true,excluded:Object.keys(QUALITY_CATEGORIES)}};
const image='https://basket-01.wbbasket.ru/vol0/part0/123/images/big/1.webp';
const p=(id,category='Футболки')=>({id,title:category+' '+id,category,category_source:'wb-cdn',product:700,rating:4.8,feedbacks:100,image,query:category});
const row=p=>({pid:p.id,data:JSON.stringify(p),topic:p.query,title_key:p.title,queued_at:p.id,checked_at:1});
const vote=(pid,voter,sentiment='l',category='Футболки',extra={})=>({scope:'channel',pid,voter,sentiment,data:JSON.stringify(p(pid,category)),...extra});
const cohort=(people=20)=>Array.from({length:people},(_,i)=>[1,2,3,4,5,6,7,8].map(id=>vote(id,'person'+i,id<=4?'l':'d',id<=4?'Футболки':'Лонгсливы'))).flat();
const context=rs=>({...summariseVotes(rs),visual:new Map(),audience:buildAudienceEvidence(rs)});
test('two people with hundreds of votes cannot become hundreds of independent people',()=>{
 const votes=Array.from({length:240},(_,i)=>vote(i+1,'p'+i%2,i%3?'d':'l',i%2?'Платья':'Футболки')),model=buildAudienceEvidence(votes);
 assert.equal(model.people,2);assert.ok(model.traits.every(t=>!t.supported));assert.equal(audienceFactor(p(999),model).factor,1);
 const rows=[row(p(1001)),row(p(1002,'Лонгсливы'))],c=context(votes),legacy=choose(rows,[],42,policy,c),proposal=audienceProposal(choose,rows,[],42,policy,c);
 assert.equal(proposal.proposed_pid,legacy.pid);assert.equal(proposal.selected_pid,legacy.pid);assert.equal(proposal.changed,false);
});
test('only channel current unique votes count; duplicates and private opinions cannot inflate evidence',()=>{
 const a=vote(1,'a'),model=buildAudienceEvidence([a,a,{...vote(2,'b'),scope:'personal:owner'},vote(1,'a','d')]);
 assert.equal(model.votes,0);assert.equal(model.ambiguous,1);assert.equal(signTest(5,0),.0625);
});
test('enough separate voters can learn relative preference with bounded adjustment; one tireless voter cannot',()=>{
 const model=buildAudienceEvidence(cohort());assert.ok(model.traits.find(t=>t.key==='type:tshirt').supported);
 assert.ok(audienceFactor(p(900),model).factor>1);assert.ok(audienceFactor(p(901,'Лонгсливы'),model).factor<1);
 assert.ok(audienceFactor(p(900),model).factor<=1.15);assert.ok(audienceFactor(p(901,'Лонгсливы'),model).factor>=.85);
 assert.ok(buildAudienceEvidence(cohort(1)).traits.every(t=>!t.supported));
});
test('uniformly negative voters do not turn every category into a negative preference',()=>{
 const rs=cohort().map(r=>({...r,sentiment:'d'}));assert.ok(buildAudienceEvidence(rs).traits.every(t=>!t.supported));
});
test('style cannot come from title, unverified features or a different visual group',()=>{
 assert.deepEqual(audienceKeys({...p(1),title:'oversize black print on back'},['visual.fit=oversize'],'apparel',false),['type:tshirt']);
 const keys=audienceKeys(p(1),['visual.fit=oversize','visual.combo=x','visual.group=apparel'],'apparel',true);assert.deepEqual(keys,['type:tshirt','apparel|visual.fit=oversize']);
 const m={traits:[{key:'shoes|visual.color=black',supported:true,adjustment:.15}]};assert.equal(audienceFactor(p(2),m,['visual.color=black'],'apparel',true).factor,1);
 assert.deepEqual(audienceKeys({...p(1),category:'другое',category_source:undefined,title:'Футболка oversize'}),[]);
});
test('missing fit or unverified subjects cannot become negative reference examples',()=>{
 const rs=cohort().map(r=>({...r,data:JSON.stringify(p(r.pid)),visual_verified:true,visual_group:'apparel',visual_keys:r.pid<=4?['visual.fit=oversize']:['visual.color=black']}));
 assert.ok(buildAudienceEvidence(rs).traits.filter(t=>t.key.includes('|visual.fit=')).every(t=>!t.supported&&t.referenceProducts===0));
});
test('owner exclusions always win and proposed ranking never changes the actual selected item',()=>{
 const c=context(cohort()),rows=[row(p(901,'Лонгсливы')),row(p(900)),row({...p(902,'Учебники'),title:'Учебник'})];
 const result=audienceProposal(choose,rows,[],42,policy,c);assert.notEqual(result.proposed_pid,902);assert.equal(result.selected_pid,result.legacy_pid);
 const receipt=audienceReceipt(result,c.audience,rows,100);assert.equal(receipt.selected_pid,result.legacy_pid);assert.ok(receipt.cohort_ids.every(id=>!c.audience.trainIds.includes(id)));assert.equal(receipt.test_votes_used_for_training,0);
});
test('metadata reuses SHADOW storage but is excluded from River training events and exports',async t=>{
 const e=await adminEnvironment(t);await ensureLearning(e);const rows=[row(p(900)),row(p(901,'Лонгсливы'))];
 const receipt={version:1,legacy_pid:900,proposed_pid:901,training_people:20};await shadowChoice(e,rows,rows[0],100,'Europe/Moscow',receipt);
 const stored=JSON.parse(e.db.prepare('SELECT features FROM learning_shadow WHERE pid=900').get().features);assert.deepEqual(stored._audience_shadow,receipt);
 await recordEvent(e,{key:'real-fixture-vote',pid:900,kind:'like',ts:110});const ev=JSON.parse(e.db.prepare('SELECT features FROM learning_events').get().features);assert.equal('_audience_shadow' in ev,false);
 const response=await learningRoute(new Request('https://local/api/learning/train'),e,{json:Response.json,payload:r=>r.json(),fail:(s,m)=>{throw Error(m);}}),exported=await response.json();
 assert.equal('_audience_shadow' in JSON.parse(exported.events[0].features),false);assert.equal('_audience_shadow' in JSON.parse(exported.shadows[0].features),false);
});
test('opt-in SHADOW can propose another item while both modes send identical real publisher payloads',async t=>{
 const run=async enabled=>{const e=await adminEnvironment(t);await ensureReactions(e);await ensureLearning(e);e.db.exec(readFileSync(new URL('./audience_quality.sql',import.meta.url),'utf8'));if(enabled)e.AUDIENCE_SHADOW_ENABLED='1';
  e.db.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify({...JSON.parse(e.db.prepare('SELECT data FROM scheduler_policy').get().data),...policy}));
  await bootstrap(e,{queue:[p(900,'Лонгсливы'),p(901)],posts:[],policy:{...policy,chat_id:'-100123456789',queries:['Футболки','Лонгсливы']}});
  const config=JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data);e.db.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify({...config,search_enabled:false,post_interval_minutes:30}));
  for(const r of cohort()){e.db.prepare('INSERT OR REPLACE INTO products(id,data,checked_at) VALUES(?,?,?)').run(r.pid,r.data,1);e.db.prepare('INSERT INTO reaction_votes(scope,pid,voter,sentiment,last_event,last_changed_event) VALUES(?,?,?,?,?,?)').run('channel',r.pid,r.voter,r.sentiment,r.pid,r.pid);}
  const sent=[];const out=await nativeTick(e,Date.now(),async(url,opts)=>{const u=new URL(url);if(u.hostname==='api.telegram.org'){sent.push(JSON.parse(opts.body));return Response.json({ok:true,result:{message_id:7777}});}if(u.hostname.endsWith('.wbbasket.ru'))return new Response('fixture',{headers:{'content-type':'image/webp'}});const id=Number(u.searchParams.get('nm')),item=id===900?p(900,'Лонгсливы'):p(901);return Response.json({products:[{id,name:item.title,brand:'',subjectName:item.category,reviewRating:4.8,feedbacks:100,sizes:[{qty:10,price:{product:70000,basic:70000}}]}]});});
  assert.equal(out.results.post.result,'success');assert.equal(sent.length,1);const shadow=JSON.parse(e.db.prepare('SELECT features FROM learning_shadow WHERE pid=?').get(out.results.post.product_id).features);return {sent,selected:out.results.post.product_id,shadow};};
 const off=await run(false),on=await run(true);assert.deepEqual(on.sent,off.sent);assert.equal(on.selected,off.selected);assert.equal('_audience_shadow' in off.shadow,false);assert.equal(on.shadow._audience_shadow.selected_pid,on.selected);assert.equal(on.shadow._audience_shadow.proposed_pid,901);
});
