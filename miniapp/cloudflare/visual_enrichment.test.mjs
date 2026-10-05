import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureLearning,recordEvent,shadowChoice,learningRoute} from './learning.mjs';
import {ensureVisual,visualRun,visualStatus,maintainVisualEvents,photoURLs,VISUAL_DAILY_CALLS} from './visual_enrichment.mjs';
import {normalizeAnalysis,mergeAnalyses,profileFeatures} from './visual_features.mjs';
const raw=(view='front')=>({group:'apparel',view,fields:{color:{value:'black',confidence:.95,evidence:'Black garment body'},fit:{value:'oversize',confidence:.9,evidence:'Dropped shoulder wide silhouette'},pattern:{value:'graphic',confidence:.9,evidence:'Large printed graphic'},print_location:{value:view,confidence:.9,evidence:'Printed graphic on visible '+view}}});
async function env(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
  const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes),rows_read:1,rows_written:1}};}});
  const e={db,calls:0,DB:{prepare:wrap,async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}},AI:{async run(){e.calls++;return {response:JSON.stringify(raw(e.calls%2?'front':'back'))};}}};
  await ensureScheduler(e);await ensureLearning(e);e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.post_interval_minutes',30)").run();
  await ensureVisual(e);return e;
}
function insert(e,pid=123){const p={id:pid,title:'Футболка мужская',category:'Футболки',price:800,product:800,image:`https://basket-01.wbbasket.ru/vol1/part123/${pid}/images/big/1.webp`};e.db.prepare("INSERT INTO scheduler_inventory(pid,state,topic,title_key,data,queued_at,expires,checked_at) VALUES(?,'ready','shirt',?,?,1,9999999999,1)").run(pid,String(pid),JSON.stringify(p));return p;}
const picture=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/webp'}});
test('closed category vocab, visible evidence and unknowns: no title-only oversize/back/material',()=>{
  const a=normalizeAnalysis({group:'apparel',view:'front',fields:{fit:{value:'oversize',confidence:.95},color:{value:'black',confidence:.9,evidence:'Visible black body'},print_location:{value:'back',confidence:.99,evidence:'Title mentions back'},material:{value:'cotton',confidence:.99,evidence:'Looks soft'},sole:{value:'thick',confidence:.95,evidence:'unrelated'}}});
  assert.deepEqual(Object.keys(a.fields),['color']);
  const f=profileFeatures(mergeAnalyses([a],1,'model'));assert.equal(f['visual.color=black'],1);assert.equal(f['visual.fit=oversize'],undefined);assert.equal(f['visual.print_location=back'],undefined);
  for(const [group,field,value] of [['shoes','sole','thick'],['bag','carry','crossbody'],['home','finish','wood_like'],['electronics','shape','compact'],['beauty','form','tube'],['accessory','decoration','stones']])assert.equal(normalizeAnalysis({group,fields:{[field]:{value,confidence:.9,evidence:'Directly visible geometry'}}}).fields[field].value,value);
});
test('bounded interactions survive front/back merging; conflicting colors stay unknown',()=>{
  const p=mergeAnalyses([normalizeAnalysis(raw('front')),normalizeAnalysis(raw('back'),{image_index:1})],1,'model');
  assert.equal(p.fields.print_location.value,'front_and_back');assert.equal(profileFeatures(p)['visual.combo=color:black+fit:oversize+print_location:front_and_back'],1);assert.ok(Object.keys(profileFeatures(p)).length<30);
  const second=raw();second.fields.color.value='white';const c=mergeAnalyses([normalizeAnalysis(raw()),normalizeAnalysis(second)],1,'model');assert.equal(c.fields.color,undefined);assert.ok(c.unknown.includes('color'));
});
test('real photo pipeline, persistent cache/restart and future inventory enqueue do not change schedule',async()=>{
  const e=await env();insert(e);const before=e.db.prepare('SELECT * FROM scheduler_config').get();
  const r=await visualRun(e,{force:true,fetcher:picture});assert.equal(r.state,'complete');assert.equal(e.calls,2);assert.equal(r.profile.images.length,2);assert.ok(r.profile.images[0].hash);assert.equal(r.profile.material,'unknown');
  assert.deepEqual(e.db.prepare('SELECT * FROM scheduler_config').get(),before);
  e.db.prepare("UPDATE visual_queue SET state='pending'").run();assert.equal((await visualRun({...e},{force:true,fetcher:()=>{throw new Error('must not refetch');}})).state,'cached');assert.equal(e.calls,2);
  insert(e,124);assert.equal(e.db.prepare('SELECT state FROM visual_queue WHERE pid=124').get().state,'pending');e.db.close();
});
test('parallel jobs are serialized by persistent expiring lease',async()=>{
  const e=await env();insert(e);let release;const waiting=new Promise(r=>{release=r;});
  const first=visualRun(e,{force:true,fetcher:async()=>{await waiting;return picture();}});
  await new Promise(r=>setImmediate(r));assert.equal((await visualRun(e,{force:true,fetcher:picture})).state,'busy');release();await first;
  assert.equal(e.db.prepare('SELECT expires FROM visual_state').get().expires,0);
  e.db.prepare("UPDATE visual_state SET expires=1,lease='stale'").run();assert.equal((await visualRun(e,{force:true,fetcher:picture})).state,'idle');e.db.close();
});
test('free quota, AI 429 and missing photo back off without changing real queue/settings',async()=>{
  const e=await env();insert(e);const day=new Date().toISOString().slice(0,10);e.db.prepare('INSERT INTO visual_usage VALUES(?,?)').run(day,VISUAL_DAILY_CALLS);
  const r=await visualRun(e,{force:true,fetcher:picture});assert.equal(r.error,'VISUAL_FREE_QUOTA');assert.equal(e.calls,0);assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory').get().state,'ready');
  e.db.prepare('DELETE FROM visual_usage').run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{throw new Error('3036 allocation quota');};assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_FREE_QUOTA');
  e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{throw new Error('must agree license');};assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_MODEL_TERMS_REQUIRED');assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);
  assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);e.db.close();
});
test('visual feedback statistics are real, replay-safe, sparse and insufficient without five products',async()=>{
  const e=await env();insert(e);await visualRun(e,{force:true,fetcher:picture});
  await recordEvent(e,{key:'actual-event-fixture',pid:123,kind:'like',ts:100});const event=e.db.prepare('SELECT features FROM learning_events').get();assert.equal(JSON.parse(event.features)['visual.fit=oversize'],1);
  await maintainVisualEvents(e,123);await maintainVisualEvents(e);await maintainVisualEvents(e,123);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n,1);const s=await visualStatus(e);assert.equal(s.insights[0].likes,1);assert.equal(s.insights[0].products,1);assert.equal(s.insights[0].direction,'insufficient');
  assert.ok(e.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM learning_events WHERE pid=123 AND id>0 ORDER BY id LIMIT 5').all().some(r=>r.detail.includes('learning_events_pid_id')));e.db.close();
});
test('shadow chooses visually but never controls Legacy; existing features and frozen comparison remain',async()=>{
  const e=await env();const p=insert(e);await visualRun(e,{force:true,fetcher:picture});
  const row=e.db.prepare('SELECT pid,data FROM scheduler_inventory WHERE pid=123').get();await shadowChoice(e,[row],row,100);
  const shadow=e.db.prepare('SELECT * FROM learning_shadow').get();assert.equal(JSON.parse(shadow.features)['visual.fit=oversize'],1);assert.equal(shadow.legacy_pid,123);
  await recordEvent(e,{key:'real-fixture',pid:123,kind:'dislike',ts:110});
  const result=await learningRoute(new Request('https://internal/api/scheduler/learning/train'),e,{json:Response.json});const batch=await result.json();assert.equal(JSON.parse(batch.events[0].features)['visual.pattern=graphic'],1);assert.equal(batch.shadows[0].river_p,shadow.river_p);assert.equal(batch.config.mode,'SHADOW');e.db.close();
});
test('photo URL allowlist does not permit arbitrary fetch or unrelated shards',()=>{
  assert.equal(photoURLs({image:'https://attacker.example/a.jpg'}).length,0);assert.equal(photoURLs({image:'https://basket-01.wbbasket.ru/vol1/part1/123/images/big/1.webp'}).length,2);
});
