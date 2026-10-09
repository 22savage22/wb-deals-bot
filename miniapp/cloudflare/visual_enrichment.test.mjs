import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureLearning,recordEvent,shadowChoice,learningRoute} from './learning.mjs';
import {ensureVisual,visualRun,visualStatus,maintainVisualEvents,photoURLs,VISUAL_DAILY_CALLS,VISUAL_DAILY_PRODUCTS,VISUAL_DAILY_NEURONS,VISUAL_REQUEST_RESERVE,VISUAL_MODEL,visualRoute,inferenceUsage,visualInputs,cachedProfiles} from './visual_enrichment.mjs';
import {normalizeAnalysis,mergeAnalyses,profileFeatures} from './visual_features.mjs';
import {visualErrorText} from '../admin/view.mjs';
import staging,{STAGING_PRODUCTS} from './visual_staging.mjs';
const raw=(view='front')=>({group:'apparel',view,fields:{color:{value:'black',confidence:.95,evidence:'Black garment body'},fit:{value:'oversize',confidence:.9,evidence:'Dropped shoulder wide silhouette'},pattern:{value:'graphic',confidence:.9,evidence:'Large printed graphic'},print_location:{value:view,confidence:.9,evidence:'Printed graphic on visible '+view}}});
async function env(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('schema.sql',import.meta.url),'utf8'));
  const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes),rows_read:1,rows_written:1}};}});
  const e={db,calls:0,DB:{prepare:wrap,async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}},AI:{async run(){e.calls++;return {response:JSON.stringify(raw(e.calls%2?'front':'back')),usage:{neurons:10}};}}};
  await ensureScheduler(e);await ensureLearning(e);e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.post_interval_minutes',30)").run();
  await ensureVisual(e);return e;
}
function insert(e,pid=123){const p={id:pid,title:'Футболка мужская',category:'Футболки',price:800,product:800,image:`https://basket-01.wbbasket.ru/vol1/part123/${pid}/images/big/1.webp`};e.db.prepare("INSERT INTO scheduler_inventory(pid,state,topic,title_key,data,queued_at,expires,checked_at) VALUES(?,'ready','shirt',?,?,1,9999999999,1)").run(pid,String(pid),JSON.stringify(p));return p;}
const picture=async(url,options)=>{assert.equal(options?.redirect,'manual');return new Response(new TextEncoder().encode(url),{headers:{'Content-Type':'image/webp'}});};
async function complete(e){let r=await visualRun(e,{force:true,fetcher:picture});if(r.state==='partial')r=await visualRun(e,{force:true,fetcher:picture});return r;}
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
  const r=await complete(e);assert.equal(r.state,'complete');assert.equal(e.calls,2);assert.equal(r.profile.images.length,2);assert.ok(r.profile.images[0].hash);assert.equal(r.profile.material,'unknown');
  assert.deepEqual(e.db.prepare('SELECT * FROM scheduler_config').get(),before);
  e.db.prepare("UPDATE visual_queue SET state='pending'").run();assert.equal((await visualRun({...e},{force:true,fetcher:()=>{throw new Error('must not refetch');}})).state,'cached');assert.equal(e.calls,2);
  insert(e,124);assert.equal(e.db.prepare('SELECT state FROM visual_queue WHERE pid=124').get().state,'pending');e.db.close();
});
test('parallel jobs are serialized by persistent expiring lease',async()=>{
  const e=await env();insert(e);let release;const waiting=new Promise(r=>{release=r;});
  const first=visualRun(e,{force:true,fetcher:async(url,options)=>{await waiting;return picture(url,options);}});
  await new Promise(r=>setImmediate(r));assert.equal((await visualRun(e,{force:true,fetcher:picture})).state,'busy');release();await first;await complete(e);
  assert.equal(e.db.prepare('SELECT expires FROM visual_state').get().expires,0);
  e.db.prepare("UPDATE visual_state SET expires=1,lease='stale'").run();assert.equal((await visualRun(e,{force:true,fetcher:picture})).state,'idle');e.db.close();
});
test('free quota, AI 429 and missing photo back off without changing real queue/settings',async()=>{
  const e=await env();insert(e);const day=new Date().toISOString().slice(0,10);e.db.prepare('INSERT INTO visual_usage VALUES(?,?)').run(day,VISUAL_DAILY_CALLS);
  const r=await visualRun(e,{force:true,fetcher:picture});assert.equal(r.error,'VISUAL_FREE_QUOTA');assert.equal(e.calls,0);assert.equal(e.db.prepare('SELECT state FROM scheduler_inventory').get().state,'ready');
  e.db.prepare('DELETE FROM visual_usage').run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{throw new Error('3036 allocation quota');};assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_FREE_QUOTA');
  e.db.prepare('DELETE FROM visual_neuron_budget').run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{throw new Error('must agree license');};assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_MODEL_TERMS_REQUIRED');assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);
  assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);e.db.close();
});
test('visual feedback statistics are real, replay-safe, sparse and insufficient without five products',async()=>{
  const e=await env();insert(e);await complete(e);
  await recordEvent(e,{key:'actual-event-fixture',pid:123,kind:'like',ts:100});const event=e.db.prepare('SELECT features FROM learning_events').get();assert.equal(JSON.parse(event.features)['visual.fit=oversize'],1);
  await maintainVisualEvents(e,123);await maintainVisualEvents(e);await maintainVisualEvents(e,123);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n,1);const s=await visualStatus(e);assert.equal(s.insights[0].likes,1);assert.equal(s.insights[0].products,1);assert.equal(s.insights[0].direction,'insufficient');
  assert.ok(e.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM learning_events WHERE pid=123 AND id>0 ORDER BY id LIMIT 5').all().some(r=>r.detail.includes('learning_events_pid_id')));e.db.close();
});
test('shadow chooses visually but never controls Legacy; existing features and frozen comparison remain',async()=>{
  const e=await env();const p=insert(e);await complete(e);
  const row=e.db.prepare('SELECT pid,data FROM scheduler_inventory WHERE pid=123').get();await shadowChoice(e,[row],row,100);
  const shadow=e.db.prepare('SELECT * FROM learning_shadow').get();assert.equal(JSON.parse(shadow.features)['visual.fit=oversize'],1);assert.equal(shadow.legacy_pid,123);
  await recordEvent(e,{key:'real-fixture',pid:123,kind:'dislike',ts:110});
  const result=await learningRoute(new Request('https://internal/api/scheduler/learning/train'),e,{json:Response.json});const batch=await result.json();assert.equal(JSON.parse(batch.events[0].features)['visual.pattern=graphic'],1);assert.equal(batch.shadows[0].river_p,shadow.river_p);assert.equal(batch.config.mode,'SHADOW');e.db.close();
});
test('photo URL allowlist does not permit arbitrary fetch or unrelated shards',()=>{
  assert.equal(photoURLs({image:'https://attacker.example/a.jpg'}).length,0);assert.equal(photoURLs({image:'https://basket-01.wbbasket.ru/vol1/part1/123/images/big/1.webp'}).length,2);
});

test('provider diagnostics redact credentials and distinguish capacity from daily quota',async()=>{
  const e=await env();insert(e);e.AI.run=async()=>{throw new Error('3040 Capacity temporarily exceeded Bearer do-not-log-this-credential');};
  const capacity=await visualRun(e,{force:true,fetcher:picture});assert.equal(capacity.error,'VISUAL_MODEL_CAPACITY');assert.deepEqual(capacity.provider.codes,['3040']);assert.ok(!capacity.provider.detail.includes('do-not-log'));
  e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{const err=new Error('AI upstream failure');err.cause={code:5016};throw err;};
  const terms=await visualRun(e,{force:true,fetcher:picture});assert.equal(terms.error,'VISUAL_MODEL_TERMS_REQUIRED');assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);e.db.close();
});

test('Workers-compatible manual redirects reject an image redirect without calling AI',async()=>{
  const e=await env();insert(e);let fetches=0;
  const result=await visualRun(e,{force:true,fetcher:async(url,options)=>{fetches++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://attacker.example/image.jpg'}});}});
  assert.equal(result.error,'VISUAL_IMAGE_UNAVAILABLE');assert.equal(fetches,1);assert.equal(e.calls,0);e.db.close();
});

test('owner sees an honest human-readable license gate, not a successful vision claim',()=>{
  assert.match(visualErrorText('VISUAL_MODEL_TERMS_REQUIRED'),/разрешение владельца/);assert.match(visualErrorText('VISUAL_MODEL_TERMS_REQUIRED'),/выключен/);
  assert.match(visualErrorText('VISUAL_FREE_QUOTA'),/Бесплатный/);assert.match(visualErrorText('unknown'),/Публикации продолжаются/);
});

test('frozen real-inventory sample is only three IDs, retry never expands it, cache never reinfers',async()=>{
  const e=await env();for(const id of [200,201,202,203,204])insert(e,id);
  const helpers={json:Response.json,fail(status,message){throw Object.assign(new Error(message),{status});}},call=(path,data={})=>visualRoute(new Request('https://internal/api/scheduler/learning/visual/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),e,helpers);
  const before=e.db.prepare('SELECT * FROM scheduler_config').get();const a=await (await call('sample')).json();assert.equal(a.products.length,3);insert(e,205);
  assert.deepEqual((await (await call('sample')).json()).products,a.products);assert.deepEqual(e.db.prepare('SELECT * FROM scheduler_config').get(),before);
  await assert.rejects(call('run',{pid:205}),error=>error.status===409);await assert.rejects(call('activate'),error=>error.status===409);
  for(const p of a.products){let r=await visualRun(e,{force:true,pid:p.pid,fetcher:picture});if(r.state==='partial')r=await visualRun(e,{force:true,pid:p.pid,fetcher:picture});assert.equal(r.state,'complete');}
  const calls=e.calls;assert.equal((await visualRun(e,{force:true,pid:a.products[0].pid,fetcher:()=>{throw new Error('no download');}})).state,'cached');assert.equal(e.calls,calls);assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);e.db.close();
});

test('specific authorized terms operation is receipt-idempotent and does not activate enrichment',async()=>{
  const e=await env();const before=e.db.prepare('SELECT * FROM scheduler_config').get();e.AI.run=async(model,inputs)=>{e.calls++;assert.equal(model,'@cf/meta/llama-3.2-11b-vision-instruct');assert.deepEqual(inputs,{prompt:'agree'});return new Response(JSON.stringify({response:'Accepted',usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'Content-Type':'application/json'}});};
  const helpers={json:Response.json,fail(status,message){throw Object.assign(new Error(message),{status});}},call=data=>visualRoute(new Request('https://internal/api/scheduler/learning/visual/accept-terms',{method:'POST',body:JSON.stringify(data)}),e,helpers);
  await assert.rejects(call({approval:'wrong'}),error=>error.status===400);assert.equal(e.calls,0);
  const receipt=await (await call({approval:'meta-llama-3.2-11b-vision-20261005'})).json();assert.equal(receipt.state,'accepted');assert.equal(receipt.usage.provider_neurons,null);assert.equal(receipt.usage.source,'provider_tokens_pricing_estimate');
  await call({approval:'meta-llama-3.2-11b-vision-20261005'});assert.equal(e.calls,1);assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);assert.deepEqual(e.db.prepare('SELECT * FROM scheduler_config').get(),before);e.db.close();
});

test('missing or model-invented metering is unknown, not falsely called measured neurons',()=>{
  assert.equal(inferenceUsage({response:'{"neurons":7}'}).provider_neurons,null);assert.equal(inferenceUsage({response:'text'}).tokens_calculated_neurons,null);
  assert.deepEqual(inferenceUsage({usage:{prompt_tokens:100,completion_tokens:10}}),{input_tokens:100,output_tokens:10,total_tokens:null,provider_neurons:null,tokens_calculated_neurons:.1*4.410+.01*61.493,source:'provider_tokens_pricing_estimate'});
  assert.equal(inferenceUsage({usage:{neurons:7}}).provider_neurons,7);
});

test('JSON is fully parsed, typed arrays/prose/truncation rejected, synonyms normalized without inventing evidence',()=>{
  assert.throws(()=>normalizeAnalysis('{"group":"apparel","fields":{"color":["navy"]}}.'),/INVALID_JSON/);
  assert.throws(()=>normalizeAnalysis({group:'apparel',fields:{color:['navy']}}),/INVALID_PROFILE/);
  assert.throws(()=>normalizeAnalysis('{"group":"apparel","fields":{}'),/INVALID_JSON/);
  assert.throws(()=>normalizeAnalysis('explanation {"group":"apparel","fields":{}}'),/INVALID_JSON/);
  const a=normalizeAnalysis({group:'apparel',view:'front',fields:{color:{value:'navy blue',confidence:.9,evidence:'Very dark blue body'},pattern:{value:'graphic',confidence:.9,evidence:'Small heart motifs visible'},print_location:{value:'all_over',confidence:.9,evidence:'Hearts across visible front'},fit:{value:'oversized',confidence:.9,evidence:'Probably loose based on the title'}}});
  const p=mergeAnalyses([a],1,VISUAL_MODEL);assert.equal(p.fields.color.value,'navy');assert.equal(p.fields.print_location.value,'front');assert.equal(p.back_print,'unknown');assert.equal(p.fields.fit,undefined);
});
test('format retry is once per image hash/model/version across restarts, empty profiles are never useful',async()=>{
  const e=await env(),p=insert(e);p.image=p.image.replace('/1.webp','/9.webp');e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify(p),p.id);
  e.AI.run=async(model,inputs)=>{e.calls++;assert.equal(model,VISUAL_MODEL);assert.equal(inputs.response_format.type,'json_object');if(e.calls===2)assert.match(inputs.messages[0].content[0].text,/FORMAT RETRY/);return {response:'{"group":"apparel","fields":{"color":["navy"]}}',usage:{neurons:7}};};
  assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_INVALID_PROFILE');e.db.prepare('UPDATE visual_queue SET retry_at=0').run();
  assert.equal((await visualRun({...e},{force:true,fetcher:picture})).error,'VISUAL_FORMAT_RETRY_EXHAUSTED');assert.equal(e.calls,2);e.db.prepare("UPDATE visual_queue SET state='pending',retry_at=0").run();
  assert.equal((await visualRun(e,{force:true,fetcher:picture})).error,'VISUAL_FORMAT_RETRY_EXHAUSTED');assert.equal(e.calls,2);e.db.close();
  const empty=await env();insert(empty);empty.AI.run=async()=>({response:{group:'apparel',view:'front',fields:{}},usage:{neurons:1}});assert.equal((await visualRun(empty,{force:true,fetcher:picture})).error,'VISUAL_EMPTY_PROFILE');assert.equal(empty.db.prepare('SELECT count(*) n FROM visual_profiles').get().n,0);empty.db.close();
});
test('daily Neuron reserve settles actual usage; unmetered calls remain charged and provider quota stops all products',async()=>{
  const e=await env();insert(e);await complete(e);const day=new Date().toISOString().slice(0,10);
  assert.equal(e.db.prepare('SELECT charged FROM visual_neuron_budget').get().charged,20);
  insert(e,124);e.db.prepare('UPDATE visual_neuron_budget SET charged=?').run(VISUAL_DAILY_NEURONS-VISUAL_REQUEST_RESERVE+1);
  assert.equal((await visualRun(e,{force:true,pid:124,fetcher:picture})).error,'VISUAL_FREE_QUOTA');assert.equal(e.calls,2);
  e.db.prepare('UPDATE visual_neuron_budget SET charged=0').run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{e.calls++;throw new Error('3036 daily allocation');};
  await visualRun(e,{force:true,pid:124,fetcher:picture});insert(e,125);await visualRun(e,{force:true,pid:125,fetcher:picture});assert.equal(e.calls,3);assert.equal(e.db.prepare('SELECT charged FROM visual_neuron_budget WHERE day=?').get(day).charged,VISUAL_DAILY_NEURONS);
  e.db.prepare('DELETE FROM visual_neuron_budget').run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();e.AI.run=async()=>{e.calls++;return{response:raw()};};await visualRun(e,{force:true,pid:125,fetcher:picture});assert.equal(e.db.prepare('SELECT charged FROM visual_neuron_budget').get().charged,VISUAL_REQUEST_RESERVE);e.db.close();
});
test('new image versions verify bytes; same bytes and duplicate panels reuse cache, changed bytes reinfer',async()=>{
  const e=await env(),p=insert(e);await complete(e);const prior=e.calls;
  p.image_version='new';e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify(p),p.id);assert.equal((await cachedProfiles(e,[p.id])).size,0);
  assert.equal((await visualRun({...e},{force:true,pid:p.id,fetcher:picture})).state,'complete');assert.equal(e.calls,prior);
  p.image_version='changed';e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify(p),p.id);
  const different=async()=>new Response(new Uint8Array([8,9,10]),{headers:{'Content-Type':'image/webp'}});let r=await visualRun(e,{force:true,pid:p.id,fetcher:different});if(r.state==='partial')r=await visualRun(e,{force:true,pid:p.id,fetcher:different});assert.equal(r.state,'complete');assert.equal(e.calls,prior+1);assert.equal(r.profile.back_print,'unknown');e.db.close();
});
test('native AI binding input contains image bytes and constrained format, no external API credential',()=>{
  const i=visualInputs(new Uint8Array([1,2,3]),'shoes');assert.equal(i.max_completion_tokens,900);assert.equal(i.temperature,0);assert.equal(i.response_format.type,'json_object');assert.match(i.messages[0].content[1].image_url.url,/^data:image\/webp;base64,/);assert.equal(i.store,false);assert.equal(i.Authorization,undefined);
});
test('old three-product receipts and unreviewed samples cannot activate version 2',async()=>{
  const e=await env();insert(e);await complete(e);const call=()=>visualRoute(new Request('https://internal/api/scheduler/learning/visual/activate',{method:'POST'}),e,{json:Response.json,fail(status,message){throw Object.assign(new Error(message),{status});}});
  e.db.prepare("INSERT INTO metadata VALUES('visual_free_verification',?)").run(JSON.stringify({ok:true}));await assert.rejects(call(),x=>x.status===409);
  const proof={ok:true,version:2,model:VISUAL_MODEL,products_reviewed:10,owner_reviewed:false,usage_source:'provider',neurons:20};e.db.prepare("UPDATE metadata SET value=? WHERE key='visual_free_verification'").run(JSON.stringify(proof));await assert.rejects(call(),x=>x.status===409);assert.equal(e.db.prepare('SELECT enabled FROM visual_state').get().enabled,0);e.db.close();
});
test('ten-product admission persists across restarts; eleventh product stops, second view and next UTC day remain bounded',async()=>{
  const e=await env();for(let i=0;i<11;i++)insert(e,300+i);
  for(let i=0;i<VISUAL_DAILY_PRODUCTS;i++){let r=await visualRun(e,{force:true,pid:300+i,fetcher:picture});assert.equal(r.state,'partial');r=await visualRun({...e},{force:true,pid:300+i,fetcher:picture});assert.equal(r.state,'complete');}
  const before=e.calls,r=await visualRun({...e},{force:true,pid:310,fetcher:picture});assert.equal(r.error,'VISUAL_DAILY_PRODUCTS');assert.equal(e.calls,before);
  const status=await visualStatus(e);assert.equal(status.products_today,10);assert.equal(status.daily_product_limit,10);
  // UTC turnover simulation retains old history, releases today's admission.
  e.db.prepare("UPDATE visual_daily_products SET day='2000-01-01'").run();e.db.prepare('UPDATE visual_queue SET retry_at=0').run();assert.equal((await visualRun(e,{force:true,pid:310,fetcher:picture})).state,'partial');assert.equal(e.calls,before+1);e.db.close();
});
test('identical bytes across different products reuse global model/version/hash cache without AI or new admission',async()=>{
  const e=await env();insert(e,400);insert(e,401);const same=async()=>new Response(new Uint8Array([8,9,10]),{headers:{'Content-Type':'image/webp'}});
  await visualRun(e,{force:true,pid:400,fetcher:same});assert.equal((await visualRun(e,{force:true,pid:400,fetcher:same})).state,'complete');const before=e.calls;
  assert.equal((await visualRun(e,{force:true,pid:401,fetcher:same})).state,'complete');assert.equal(e.calls,before);assert.equal((await visualStatus(e)).products_today,1);e.db.close();
});
test('staging refuses production D1, missing auth, posting and search; fixed real sample uses AI then persistent cache',async()=>{
  const e=await env();const request=(path,body)=>new Request('https://preview'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+e.MINIAPP_SYNC_KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await staging.fetch(request('/api/health'),e)).status,503);
  e.VISUAL_STAGING='isolated';e.VISUAL_STAGING_DB_ID='d73d252d-3948-425b-b7c3-b65d0f5c6e5f';assert.equal((await staging.fetch(request('/api/health'),e)).status,503);
  e.VISUAL_STAGING_DB_ID='11111111-1111-4111-8111-111111111111';assert.equal((await staging.fetch(request('/api/health'),e)).status,503);
  e.VISUAL_STAGING_DB_ID='5779987d-1100-45ad-8cd4-9df9c1436a20';e.MINIAPP_SYNC_KEY='test-only-'.repeat(5);
  assert.equal((await staging.fetch(new Request('https://preview/staging/status'),e)).status,403);
  for(const path of ['/api/scheduler/tick','/api/scheduler/action','/api/scheduler/search','/telegram/webhook'])assert.equal((await staging.fetch(request(path,{}),e)).status,404);
  await staging.fetch(request('/staging/seed',{}),e);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM scheduler_inventory').get().n,10);
  const charged=e.db.prepare('SELECT SUM(charged) n FROM visual_neuron_budget').get().n;
  await staging.fetch(request('/staging/seed',{}),e);
  assert.equal(e.db.prepare('SELECT SUM(charged) n FROM visual_neuron_budget').get().n,charged);
  assert.equal(staging.scheduled,undefined);
  const original=globalThis.fetch;globalThis.fetch=picture;
  try{const first=await (await staging.fetch(request('/staging/run',{pid:STAGING_PRODUCTS[0].id}),e)).json();assert.equal(first.state,'complete');assert.equal(e.calls,1);assert.ok(first.d1.queries>0);
    const repeat=await (await staging.fetch(request('/staging/run',{pid:STAGING_PRODUCTS[0].id}),e)).json();assert.equal(repeat.state,'cached');assert.deepEqual(repeat.profile,first.profile);assert.equal(e.calls,1);assert.equal((await staging.fetch(request('/staging/run',{pid:999}),e)).status,403);
  }finally{globalThis.fetch=original;e.db.close();}
});
test('explicit reviewed staging receipt seeds external daily usage once, activation stays SHADOW with fixed limits',async()=>{
  const e=await env();insert(e);await complete(e);const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const body={approval:'visual-v2-reviewed-10-free',report_sha256:'a'.repeat(64),products_reviewed:10,review_neurons:141.22,day:new Date().toISOString().slice(0,10),external_neurons_today:50,staging:{ok:true,model:VISUAL_MODEL,version:2,usage_source:'provider',neurons:20,cache_extra_calls:0,d1_reads:100,d1_writes:50,deployment_id:'test-deployment'}};
  const review=()=>visualRoute(new Request('https://internal/api/scheduler/learning/visual/review',{method:'POST',body:JSON.stringify(body)}),e,{json:Response.json,fail});
  await review();await review();assert.equal(e.db.prepare('SELECT charged FROM visual_neuron_budget').get().charged,70);
  const activate=()=>visualRoute(new Request('https://internal/api/scheduler/learning/visual/activate',{method:'POST'}),e,{json:Response.json,fail});
  e.db.prepare('UPDATE learning_state SET config=?').run(JSON.stringify({mode:'LEGACY'}));await assert.rejects(activate(),x=>x.status===409);
  e.db.prepare('UPDATE learning_state SET config=?').run(JSON.stringify({mode:'SHADOW'}));const result=await (await activate()).json();assert.equal(result.daily_product_limit,10);assert.equal(result.daily_neuron_limit,5000);assert.equal(result.river_mode,'SHADOW');e.db.close();
});
