// Independent integration oracle. Every DB, image and network response is synthetic.
// This verifies behaviour, not Cloudflare CPU, billing rows or deployed source identity.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {randomUUID, createHash, createHmac} from 'node:crypto';
import {resolve, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildProjectionStaging} from './prepare_projection_staging.mjs';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const NOW=Date.UTC(2026,9,22,12), SEC=NOW/1000, SYNC='synthetic-isolated-sync-key-32-characters';
const CORE='aacdeded-216b-4f5a-af1a-081eef724d04';
const originalNow=Date.now, originalFetch=globalThis.fetch;
let build, baseline, candidate;
const normalize=x=>x instanceof Map?{$map:[...x].map(([k,v])=>[normalize(k),normalize(v)])}:x instanceof Set?{$set:[...x].map(normalize)}:Array.isArray(x)?x.map(normalize):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,normalize(v)])):x;
const digest=x=>createHash('sha256').update(JSON.stringify(normalize(x))).digest('hex');
const equivalent=(actual,expected,label)=>assert.equal(digest(actual),digest(expected),label);

// The existing LocalD1 batch adapter is write-only. This separate test adapter
// performs genuine SELECT batches in ONE SQLite snapshot and never fabricates
// Cloudflare rows_read/rows_written metadata.
class SQLiteD1 {
  constructor(file=':memory:') {this.file=file;this.sqlite=new DatabaseSync(file);this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');this.calls=[];this.afterStatement=null;}
  exec(sql){this.sqlite.exec(sql);}
  prepare(sql){
    const db=this;
    const make=args=>({sql,args,bind(...values){return make(values);},
      execute(kind){
        const stmt=db.sqlite.prepare(sql);let result;
        if(kind==='first'){const row=stmt.get(...args);result=row??null;}
        else if(kind==='all'||stmt.columns().length){const rows=stmt.all(...args);result={results:rows,success:true,meta:{}};}
        else {const r=stmt.run(...args);result={success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
        db.calls.push({sql,kind,args});db.afterStatement?.(sql,args,result);return result;
      },
      async first(){return this.execute('first');},async all(){return this.execute('all');},async run(){return this.execute('run');}});
    return make([]);
  }
  async batch(statements){
    this.sqlite.exec('BEGIN');
    try{const results=statements.map(s=>s.execute('batch'));this.sqlite.exec('COMMIT');return results;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
  close(){this.sqlite.close();}
}
const load=async dir=>Object.fromEntries(await Promise.all(['audience_quality','audience_feedback','native_scheduler','learning','visual_enrichment','visual_features','scheduler_api','feedback','worker'].map(async name=>[name,await import(pathToFileURL(join(dir,'miniapp/cloudflare',name+'.mjs')).href)])));
before(async()=>{
  Date.now=()=>NOW;
  globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN_IN_DIFFERENTIAL_TEST');};
  build=await buildProjectionStaging({outDir:'.test-temp/projection-differential-'+randomUUID()});
  [baseline,candidate]=await Promise.all([load(build.referenceDir),load(build.candidateDir)]);
  candidate.adapter=await import(pathToFileURL(join(build.candidateDir,'miniapp/prices/projection_adapter.mjs')).href);
});
after(()=>{Date.now=originalNow;globalThis.fetch=originalFetch;});

const categories=[['Футболка женская','Футболки','apparel'],['Худи мужское','Толстовки','apparel'],['Кроссовки женские','Кроссовки','shoes'],['Сумка для учебников','Сумки','bag'],['Ремень женский','Ремни','accessory'],['Платье женское','Платья','apparel'],['Учебник химии','Учебники','other'],['Ёлочная игрушка','Декор','home']];
function card(i){const [title,category]=categories[i%categories.length];return {id:1000+i,title,category,query:category,brand:'Fixture',product:249.99,price:249.99,rating:4.9,feedbacks:120,image:`https://basket-01.wbbasket.ru/vol1/part1/${1000+i}/images/big/1.webp`};}
function visual(m,p){return {version:m.visual_features.VISUAL_VERSION,model:m.visual_enrichment.VISUAL_MODEL,source_version:m.visual_enrichment.visualSourceVersion(p),group:categories[(p.id-1000)%categories.length][2],analyzed_at:SEC,fields:{color:{value:p.id%2?'black':'white',confidence:.95},pattern:{value:'graphic',confidence:.9},print_location:{value:'front',confidence:.9},fit:{value:'regular',confidence:.8},style:{value:'streetwear',confidence:.9,hypothesis:p.id%2!==0}}};}
const policy=()=>({chat_id:'-100123456789',queries:['fixture'],max_price:500,min_rating:4.3,min_feedbacks:20,audience_quality:{enabled:true,excluded:['textbooks','books','study_aids','notebooks','stationery'],feedback_enabled:true,fashion_priority:true}});
const voter=i=>createHmac('sha256',SYNC).update('reaction:channel:'+(10000+i)).digest('hex');
const model=()=>({version:1,cursor:0,weights:{'visual.color=black':1.75,'category=Футболки':-.3,hour:.01},intercept:-.2,trained_events:0,updated_at:0,comparison:{n:0,legacy_brier:0,river_brier:0,posts:[],first_ts:0}});

async function environment(t,m,{count=300,ready=count,file=':memory:',cache=true,votes=500}={}){
  const DB=new SQLiteD1(file);t.after(()=>DB.close());
  DB.exec(readFileSync(join(build.referenceDir,'miniapp/cloudflare/schema.sql'),'utf8'));
  const env={DB,TG_BOT_TOKEN:'synthetic-local-token',MINIAPP_SYNC_KEY:SYNC,MINIAPP_BOT_USERNAME:'offline_fixture_bot',SCHEDULER_DRIVER:'cloudflare-native',PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:CORE,PROJECTION_STATS:[]};
  await m.scheduler_api.ensureScheduler(env);await m.learning.ensureLearning(env);await m.feedback.ensureReactions(env);await m.visual_enrichment.ensureVisual(env);
  DB.exec(readFileSync(join(build.referenceDir,'miniapp/cloudflare/audience_quality.sql'),'utf8'));
  await m.native_scheduler.bootstrap(env,{queue:[],posts:[],policy:policy()});
  // Bootstrap deliberately limits intake to eight per topic. This catalogue is
  // a realistic accumulated DB snapshot, not one oversized intake response.
  const inventory=DB.sqlite.prepare("INSERT INTO scheduler_inventory(pid,state,topic,title_key,data,queued_at,expires,checked_at) VALUES(?,'ready',?,?,?,1,?,?)");
  for(let i=0;i<count;i++){const p=card(i);inventory.run(p.id,'fixture-topic-'+i%7,'fixture-title-'+i,JSON.stringify(p),SEC+72*3600,SEC);}
  DB.sqlite.prepare('UPDATE scheduler_config SET data=?,status=json_patch(status,?)').run(JSON.stringify({...m.scheduler_api.DEFAULT_SCHEDULE,post_interval_minutes:30,search_enabled:false}),JSON.stringify({last_scan_attempt:SEC,last_maintenance:SEC}));
  DB.sqlite.prepare('UPDATE scheduler_policy SET data=?').run(JSON.stringify(policy()));
  const put=DB.sqlite.prepare('INSERT INTO visual_profiles(pid,version,analyzed_at,profile) VALUES(?,?,?,?)');
  for(let i=0;i<count;i++){const p=card(i),v=visual(m,p);put.run(p.id,v.version,SEC,JSON.stringify(v));}
  // Keep all 300 products/profiles present when the publication pool contains 20.
  if(ready<count)DB.sqlite.prepare("UPDATE scheduler_inventory SET state='rejected' WHERE pid>=?").run(1000+ready);
  const total=DB.sqlite.prepare("INSERT INTO reaction_totals(scope,pid) VALUES('channel',?)");
  for(let n=0;n<count;n++)total.run(1000+n);
  const insert=DB.sqlite.prepare('INSERT INTO reaction_votes(scope,pid,voter,sentiment,last_event,last_changed_event) VALUES(?,?,?,?,?,?)');
  for(let n=0;n<votes;n++)insert.run('channel',1000+n%count,voter(n),n%3?'d':'l',n+1,n+1);
  insert.run('test:fixture',1000,'ignored-other-scope','d',999999,999999);
  DB.sqlite.prepare('UPDATE learning_state SET model=?').run(JSON.stringify(model()));
  if(m===candidate){env.store=m.adapter.projectionStore(env);if(cache){await env.store.init();for(let n=0;n<count;n+=20)await env.store.prepare({ids:Array.from({length:Math.min(20,count-n)},(_,k)=>1000+n+k),now:NOW});}}
  DB.calls.length=0;return env;
}
async function pair(t,options={}){const [a,b]=await Promise.all([environment(t,baseline,options),environment(t,candidate,options)]);return {a,b};}
const rows=e=>e.DB.sqlite.prepare("SELECT * FROM scheduler_inventory WHERE state='ready' ORDER BY pid").all();
function contextValue(c){const {projections,projectionUnsafe,...business}=c;return {...business,visual:new Map([...business.visual].sort((a,b)=>a[0]-b[0]))};}
async function contexts(ea,eb,listA=rows(ea),listB=rows(eb),label='current context'){
  const a=await baseline.audience_feedback.audienceContext(ea,listA.map(r=>r.pid));
  const b=await candidate.audience_feedback.audienceContext(eb,listB.map(r=>r.pid),listB);
  equivalent(contextValue(b),contextValue(a),label);
  equivalent(candidate.audience_feedback.feedbackSummary(b),baseline.audience_feedback.feedbackSummary(a),label+' serialized owner summary');
  return {a,b};
}
const both=(a,b,sql,...args)=>{for(const e of [a,b])e.DB.sqlite.prepare(sql).run(...args);};
const learningSnapshot=e=>Object.fromEntries(['learning_state','learning_events','learning_stats','learning_feedback','learning_shadow'].map(table=>[table,e.DB.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2').all()]));

test('oracle pins verified main plus minimal prices and excludes the previous CPU rewrites',()=>{
  assert.equal(build.base,'524fbe8931b911e4c3bc4e05de7caf5003b1decc');
  assert.equal(build.pricePatch,'cb0361b8b6c8523d983251045677a51a2448d3d8b47ff62afc046852adcfcf33');
  assert.equal(build.excludesAllPriorCpuPatches,true);assert.equal(build.productionChanged,false);assert.equal(build.realRequests,0);
  const source=readFileSync(join(build.referenceDir,'miniapp/cloudflare/audience_quality.mjs'),'utf8');
  assert.ok(!source.includes('function productTypeMatchers'),'baseline is the original eager classifier, not 33c13e80');
  assert.ok(!source.includes('const types=new Map()'),'baseline does not include the same-string per-call memo');
});

test('both prepared artifacts remain private, isolated, observer-OFF and guarded before touching D1',async()=>{
  for(const mode of ['reference','prepared']){
    const config=JSON.parse(readFileSync(join(resolve(build.bundles[mode].path,'..'),mode+'.wrangler.json'),'utf8'));
    assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);assert.deepEqual(config.routes,[]);assert.deepEqual(config.triggers.crons,[]);
    assert.equal(config.vars.PRICE_OBSERVATION_ENABLED,'0');assert.equal(config.vars.PROJECTION_DATABASE_ID,CORE);assert.equal(config.vars.TG_BOT_TOKEN,'123:fixture-passive-price');
    assert.equal(config.d1_databases.length,1);assert.equal(config.d1_databases[0].database_id,CORE);assert.equal(config.ai,undefined);assert.equal(config.services,undefined);
    const code=readFileSync(build.bundles[mode].path,'utf8');assert.ok(!code.includes('PRICE_OBSERVER'));assert.ok(!code.includes('passive_capture'));
  }
  const {createProjectionStagingDriver}=await import(pathToFileURL(join(build.candidateDir,'miniapp/prices/projection_staging_driver.mjs')).href);
  let calls=0;const driver=createProjectionStagingDriver({worker:{scheduled(){calls++;throw Error('UNEXPECTED_DRIVER_ENTRY');}},observeD1(){calls++;throw Error('UNEXPECTED_D1_ENTRY');}});
  const env={PRICE_LOCAL_STAGING:'1',TG_BOT_TOKEN:'123:fixture-passive-price',PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:CORE};
  for(const patch of [{PRICE_LOCAL_STAGING:'0'},{TG_BOT_TOKEN:'different'},{PROJECTION_ISOLATED:'false'},{PROJECTION_DATABASE_ID:'d73d252d-3948-425b-b7c3-b65d0f5c6e5f'},{AI:{run(){throw Error('AI_FORBIDDEN');}}}]){
    const response=await driver.fetch(new Request('https://isolated.test/replay',{method:'POST'}),{...env,...patch},{});assert.equal(response.status,404);
  }
  for(const [path,method] of [['/replay','GET'],['/unknown','POST']])assert.equal((await driver.fetch(new Request('https://isolated.test'+path,{method}),env,{})).status,404);
  assert.equal(calls,0,'bad guard requests cannot reach DB, worker, AI or external fetch');
});

test('warm 500-vote / 300-profile projections preserve exact owner feedback and ranked selection for 20 and 300 ready rows',async t=>{
  for(const ready of [20,300]){
    const {a,b}=await pair(t,{ready});const r=rows(a),s=rows(b),before=digest(s),c=await contexts(a,b,r,s,'warm'+ready);
    assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');assert.equal(b.PROJECTION_STATS.at(-1).miss,0);
    for(const p of [policy(),{...policy(),audience_quality:{enabled:false,excluded:[],feedback_enabled:false,fashion_priority:false}},{...policy(),audience_quality:{enabled:true,excluded:[],feedback_enabled:true,fashion_priority:false}}]){
      const recent=r.slice(-2);
      equivalent(candidate.audience_quality.qualityRank(s,recent,p,c.b),baseline.audience_quality.qualityRank(r,recent,p,c.a),'exact ranking/reasons');
      equivalent(candidate.native_scheduler.choose(s,recent,42,p,c.b),baseline.native_scheduler.choose(r,recent,42,p,c.a),'exact chosen original row');
    }
    assert.equal(digest(s),before,'private prepared decodes do not mutate caller rows');
    assert.equal(c.a.sampled_votes,500);assert.equal(c.a.truncated,true);
    assert.ok(!b.DB.calls.some(c=>c.sql.startsWith('CREATE ')),'hot context never initializes schema');
  }
});

test('no cache, partial cache, stale caller row and malformed original profile use whole current original feedback',async t=>{
  const {a,b}=await pair(t,{cache:false});await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
  await b.store.init();await b.store.prepare({ids:[1000],now:NOW});await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
  for(let n=0;n<300;n+=20)await b.store.prepare({ids:Array.from({length:20},(_,k)=>1000+n+k),now:NOW});
  const oldA=rows(a),oldB=rows(b),p={...card(0),title:'Учебник химии',category:'Учебники'};
  both(a,b,'UPDATE scheduler_inventory SET data=? WHERE pid=?',JSON.stringify(p),1000);await b.store.prepare({ids:[1000],now:NOW+1});
  await contexts(a,b,oldA,oldB,'old caller cannot acquire current projection');assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
  await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');
  both(a,b,'UPDATE visual_profiles SET profile=? WHERE pid=?','{',1000);
  await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
  assert.equal((await b.store.prepare({ids:[1000],now:NOW+2})).uncacheable,1);
});

test('actual vote changes, repeats, bought-only and out-of-order callbacks always use fresh top500 membership',async t=>{
  const {a,b}=await pair(t,{votes:501});const before=await contexts(a,b);
  const oldRevision=a.DB.sqlite.prepare("SELECT revision FROM reaction_totals WHERE scope='channel' AND pid=1000").get().revision;
  // Voter zero is just OUTSIDE the current 500-vote window. Repeating its like
  // changes membership without changing totals or aggregate revision.
  for(const [m,e] of [[baseline,a],[candidate,b]])await m.feedback.vote(e,{scope:'channel',pid:1000,voter:'10000',action:'l',event_id:900});
  const repeated=await contexts(a,b);
  assert.equal(a.DB.sqlite.prepare("SELECT revision FROM reaction_totals WHERE scope='channel' AND pid=1000").get().revision,oldRevision);
  assert.equal(repeated.a.likes,before.a.likes+1);assert.equal(repeated.a.dislikes,before.a.dislikes-1);
  let lastSummary;
  for(const [action,event] of [['d',1000],['l',1001],['l',1002],['b',1003],['d',999],['d',1003]]){
    const input={scope:'channel',pid:1000,voter:'10000',action,event_id:event};
    const va=await baseline.feedback.vote(a,input),vb=await candidate.feedback.vote(b,input);equivalent(vb,va,'actual vote accepted/totals');
    const c=await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');
    const revision=a.DB.sqlite.prepare("SELECT revision FROM reaction_totals WHERE scope='channel' AND pid=1000").get().revision;
    if(event===1002)assert.equal(revision,lastSummary.revision,'same like advances last_event without a totals revision');
    lastSummary={revision,summary:digest(contextValue(c.a))};
  }
  equivalent(b.DB.sqlite.prepare('SELECT * FROM reaction_votes ORDER BY scope,pid,voter').all(),a.DB.sqlite.prepare('SELECT * FROM reaction_votes ORDER BY scope,pid,voter').all(),'persisted current unique votes');
  equivalent(learningSnapshot(b),learningSnapshot(a),'reaction training remains identical and SHADOW');
});

test('owner bans, current settings, model weights, priors and time are never cached',async t=>{
  const {a,b}=await pair(t);const r=rows(a),s=rows(b),c=await contexts(a,b);
  for(const excluded of [[],['textbooks'],['textbooks','books','study_aids','notebooks','stationery']])for(const fashion_priority of [true,false]){
    const p={...policy(),audience_quality:{enabled:true,excluded,feedback_enabled:true,fashion_priority}};
    equivalent(candidate.native_scheduler.choose(s,r.slice(-2),99,p,c.b),baseline.native_scheduler.choose(r,r.slice(-2),99,p,c.a),'live owner policy');
  }
  for(const patch of [{weights:{'visual.color=black':-3},intercept:.7},{weights:{},intercept:0}]){
    both(a,b,'UPDATE learning_state SET model=?',JSON.stringify({...model(),...patch}));
    for(const zone of ['Europe/Moscow','America/New_York'])for(const ts of [SEC,SEC+3600]){
      await baseline.learning.shadowChoice(a,r,r[1],ts,zone);await candidate.learning.shadowChoice(b,s,s[1],ts,zone);
      equivalent(learningSnapshot(b),learningSnapshot(a),'current same-cursor model / time / SHADOW');
    }
    both(a,b,"INSERT OR REPLACE INTO learning_stats(scope,key,positive,negative,events,last) VALUES('category',?,2,19,21,?)",'Футболки',SEC);
    await baseline.learning.shadowChoice(a,r,r[1],SEC);await candidate.learning.shadowChoice(b,s,s[1],SEC);equivalent(learningSnapshot(b),learningSnapshot(a),'current category prior');
  }
  both(a,b,'UPDATE learning_state SET config=?',JSON.stringify({mode:'LEGACY',exploration_percent:10}));
  const before=learningSnapshot(a);await baseline.learning.shadowChoice(a,r,r[2],SEC);await candidate.learning.shadowChoice(b,s,s[2],SEC);
  equivalent(learningSnapshot(b),before,'disabled shadow writes nothing');
});

test('exact raw profile/image/model/version/order changes cannot reuse an old projection',async t=>{
  const {a,b}=await pair(t);const p=card(0),v=visual(baseline,p),raw=JSON.stringify(v);
  const variants=[
    {...v,fields:{...v.fields,color:{value:'red',confidence:.95}}},
    {...v,fields:{...v.fields,color:{value:'black',confidence:.79}}},
    {...v,fields:{...v.fields,style:{value:'streetwear',confidence:.95,hypothesis:false}}},
    {...v,fields:Object.fromEntries(Object.entries(v.fields).reverse())},
    {...v,version:0},{...v,model:'old-model'},{...v,source_version:'old-image'},
    {...v,analyzed_at:SEC-86400}
  ];
  for(const variant of variants){
    both(a,b,'UPDATE visual_profiles SET profile=? WHERE pid=?',JSON.stringify(variant),p.id);
    assert.equal((await b.store.read([p.id])).hits,0,'changed raw profile invalidates even the same derived fields');
    await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
    await b.store.prepare({ids:[p.id],now:NOW+1});await contexts(a,b);
    const valid=variant.version===v.version&&variant.model===v.model&&variant.source_version===v.source_version;
    assert.equal(b.PROJECTION_STATS.at(-1).kind,valid?'audience-hit':'audience-miss');
    both(a,b,'UPDATE visual_profiles SET profile=? WHERE pid=?',raw,p.id);await b.store.prepare({ids:[p.id],now:NOW+2});
  }
  // Profile order cutoff is part of original semantics, including unknown keys.
  const fields=Object.fromEntries(Array.from({length:18},(_,i)=>['padding'+i,{value:'x',confidence:0}]));fields.color={value:'red',confidence:1};
  both(a,b,'UPDATE visual_profiles SET profile=? WHERE pid=?',JSON.stringify({...v,fields}),p.id);await b.store.prepare({ids:[p.id],now:NOW+3});await contexts(a,b);
  for(const changed of [{...p,image_version:2},{...p,image_updated_at:'new'},{...p,image:p.image.replace('/1.webp','/3.webp')},{...p,images:[p.image,p.image.replace('/1.webp','/4.webp')]}]){
    both(a,b,'UPDATE scheduler_inventory SET data=? WHERE pid=?',JSON.stringify(changed),p.id);
    assert.equal((await b.store.read([p.id])).hits,0);await contexts(a,b);
  }
  both(a,b,'UPDATE scheduler_inventory SET data=? WHERE pid=?',JSON.stringify(p),p.id);
  both(a,b,'DELETE FROM visual_profiles WHERE pid=?',p.id);await b.store.prepare({ids:[p.id],now:NOW+4});await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');
  b.DB.sqlite.prepare('UPDATE cron_product_projections SET prepared_at=1').run();await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit','age alone is not a TTL for immutable exact source data');
});

test('inventory/products precedence and 300-profile pre-SQL bounds retain original semantics',async t=>{
  const {a,b}=await pair(t,{count:305,votes:500});await contexts(a,b);
  const p={...card(0),title:'Книга роман',category:'Книги'};
  both(a,b,'INSERT OR REPLACE INTO products(id,data) VALUES(?,?)',p.id,JSON.stringify(p));
  both(a,b,'DELETE FROM scheduler_inventory WHERE pid=?',p.id);assert.equal((await b.store.read([p.id])).hits,0);
  await b.store.prepare({ids:[p.id],now:NOW+1});const c=await contexts(a,b);
  assert.equal(c.b.visual.has(p.id),false,'orphan profile does not attach to products fallback');
  const allA=rows(a),allB=rows(b);await contexts(a,b,allA.slice().reverse(),allB.slice().reverse(),'candidate IDs have their own pre-SQL 300 bound');
  assert.equal(c.a.sampled_votes,500);assert.equal(c.b.projections.size,300);
});

test('stored output/version tampering is a cache miss and cannot weaken current owner exclusions',async t=>{
  const {a,b}=await pair(t);
  const saved=b.DB.sqlite.prepare('SELECT * FROM cron_product_projections WHERE pid=1000').get();
  for(const [column,value] of [['version_key','obsolete-algorithm'],['image_key','wrong-image'],['output',JSON.stringify({...JSON.parse(saved.output),versionKey:'wrong-version'})],['output','{}']]){
    b.DB.sqlite.prepare('UPDATE cron_product_projections SET '+column+'=? WHERE pid=1000').run(value);
    assert.equal((await b.store.read([1000])).hits,0);await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
    b.DB.sqlite.prepare('UPDATE cron_product_projections SET version_key=?,image_key=?,output=? WHERE pid=1000').run(saved.version_key,saved.image_key,saved.output);
  }
  const p={...card(0),title:'Учебник химии',category:'Учебники'};
  both(a,b,'UPDATE scheduler_inventory SET data=? WHERE pid=?',JSON.stringify(p),p.id);
  const c=await contexts(a,b),r=rows(a),s=rows(b);
  assert.equal(candidate.audience_quality.candidateQuality(p,policy(),c.b).allowed,false);
  assert.notEqual(candidate.native_scheduler.choose(s,[],0,policy(),c.b)?.pid,p.id);
  equivalent(candidate.native_scheduler.choose(s,[],0,policy(),c.b),baseline.native_scheduler.choose(r,[],0,policy(),c.a),'cache miss still enforces owner ban');
});

test('source compare-and-swap refuses work prepared across a concurrent source change',async t=>{
  const {b}=await pair(t);const p={...card(0),title:'Книга роман',category:'Книги'};let changed=false;
  b.DB.sqlite.prepare('DELETE FROM cron_product_projections WHERE pid=1000').run();
  b.DB.afterStatement=(sql)=>{if(!changed&&sql.includes('SELECT wanted.pid')&&sql.includes('raw_product')){changed=true;b.DB.sqlite.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=1000').run(JSON.stringify(p));}};
  const result=await b.store.prepare({ids:[1000],now:NOW+1});b.DB.afterStatement=null;
  assert.equal(changed,true);assert.equal(result.casSkipped,1);assert.equal(result.written,0);assert.equal((await b.store.read([1000])).hits,0);
});

test('atomic feedback plus candidate read sees one coherent snapshot when another SQLite connection commits',async t=>{
  const file=join(ROOT,'.test-temp','projection-race-'+randomUUID()+'.sqlite');
  const a=await environment(t,baseline),b=await environment(t,candidate,{file});
  const writer=new DatabaseSync(file);t.after(()=>writer.close());
  const expected=await baseline.audience_feedback.audienceContext(a,rows(a).map(r=>r.pid)),stale=rows(b);let fired=false;
  b.DB.afterStatement=sql=>{if(!fired&&sql.includes('projected_visualKeys')&&sql.includes('reaction_votes_quality_recent')){fired=true;writer.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=1000').run(JSON.stringify({...card(0),title:'Книга роман',category:'Книги'}));}};
  const observed=await candidate.audience_feedback.audienceContext(b,stale.map(r=>r.pid),stale);b.DB.afterStatement=null;
  assert.equal(fired,true);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');equivalent(contextValue(observed),contextValue(expected),'whole context linearizes at first statement');
  assert.equal((await b.store.read([1000])).hits,0,'subsequent request must reject the stale source');
});

test('projection survives a new SQLite adapter and a fresh Node process, without a warm JS cache',async t=>{
  const file=join(ROOT,'.test-temp','projection-durable-'+randomUUID()+'.sqlite');
  const a=await environment(t,baseline),b=await environment(t,candidate,{file});
  const expected=await baseline.audience_feedback.audienceContext(a,rows(a).map(r=>r.pid));
  const reopened=new SQLiteD1(file);t.after(()=>reopened.close());
  const env={...b,DB:reopened,PROJECTION_STATS:[]};await contexts(a,env);assert.equal(env.PROJECTION_STATS.at(-1).kind,'audience-hit');
  const script=`import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
    const db=new DatabaseSync(process.argv[1]);const make=(sql,args=[])=>({bind(...v){return make(sql,v)},async all(){return {results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null}});
    const DB={prepare:make,async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.all());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
    const m=await import(process.argv[2]),e={DB,PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:process.argv[3],PROJECTION_STATS:[]};
    const rows=db.prepare("SELECT * FROM scheduler_inventory WHERE state='ready' ORDER BY pid").all();let c=await m.audienceContext(e,rows.map(r=>r.pid),rows);const {projections,projectionUnsafe,...v}=c;v.visual=new Map([...v.visual].sort((a,b)=>a[0]-b[0]));
    const norm=x=>x instanceof Map?{$map:[...x].map(([k,v])=>[norm(k),norm(v)])}:x instanceof Set?{$set:[...x].map(norm)}:Array.isArray(x)?x.map(norm):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,norm(v)])):x;
    console.log(JSON.stringify({digest:createHash('sha256').update(JSON.stringify(norm(v))).digest('hex'),stats:e.PROJECTION_STATS}));db.close();`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,file,pathToFileURL(join(build.candidateDir,'miniapp/cloudflare/audience_feedback.mjs')).href,CORE],{encoding:'utf8',timeout:30000});
  assert.equal(child.status,0,'cold process must run locally');const result=JSON.parse(child.stdout.trim());assert.equal(result.digest,digest(contextValue(expected)));assert.equal(result.stats.at(-1).kind,'audience-hit');
});

async function quietLogs(operation){const old=console.log;console.log=()=>{};try{return await operation();}finally{console.log=old;}}
function fixtureFetcher(env,{invalidFirst=false,forbidden=false}={}){
  const calls=[];let validation=0;
  return {calls,fetcher:async(input,options={})=>{
    const u=new URL(input);
    if(u.hostname==='card.wb.ru'){
      const id=Number(u.searchParams.get('nm'));calls.push({kind:'details',id});const p=JSON.parse(env.DB.sqlite.prepare('SELECT data FROM scheduler_inventory WHERE pid=?').get(id).data);
      if(forbidden)return new Response('forbidden',{status:403});
      const product=invalidFirst&&validation++===0?90000:24999;
      return Response.json({products:[{id,name:p.title,subjectName:p.category,brand:p.brand,reviewRating:p.rating,feedbacks:p.feedbacks,sizes:[{chrtId:id*10+1,name:'S',qty:0,price:{product:10000,basic:100000}},{chrtId:id*10+2,name:'M',qty:3,price:{product,basic:100000}}]}]});
    }
    if(/^basket-\d+\.wbbasket\.ru$/.test(u.hostname)){calls.push({kind:'photo',url:u.href});return new Response('synthetic-photo',{headers:{'content-type':'image/webp'}});}
    if(u.hostname==='api.telegram.org'&&u.pathname.endsWith('/sendPhoto')){calls.push({kind:'telegram',body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:12345}});}
    if(u.hostname==='api.telegram.org'&&u.pathname.endsWith('/editMessageReplyMarkup')){const body=JSON.parse(options.body);calls.push({kind:'markup',body});return Response.json({ok:true,result:{reply_markup:body.reply_markup}});}
    throw Error('UNEXPECTED_SYNTHETIC_REQUEST');
  }};
}
function publicationSnapshot(e,result,calls){return {result,calls,delivery:e.DB.sqlite.prepare('SELECT * FROM scheduler_deliveries ORDER BY pid,ts').all(),posts:e.DB.sqlite.prepare('SELECT * FROM scheduler_posts ORDER BY pid,ts').all(),inventory:e.DB.sqlite.prepare('SELECT pid,state,data FROM scheduler_inventory ORDER BY pid').all(),shadow:e.DB.sqlite.prepare('SELECT * FROM learning_shadow ORDER BY pid').all(),schedule:e.DB.sqlite.prepare('SELECT data FROM scheduler_config').get().data};}

test('full ORIGINAL scheduled boundary keeps exact WB calls, price fallback, Telegram payload, delivery and SHADOW',async t=>{
  for(const [ready,variant] of [[20,'normal'],[300,'normal'],[20,'invalid-first'],[20,'403']]){
    const {a,b}=await pair(t,{ready});const fa=fixtureFetcher(a,{invalidFirst:variant==='invalid-first',forbidden:variant==='403'}),fb=fixtureFetcher(b,{invalidFirst:variant==='invalid-first',forbidden:variant==='403'});
    a.PROJECTION_FIXTURE_FETCH=fa.fetcher;b.PROJECTION_FIXTURE_FETCH=fb.fetcher;
    const ra=await quietLogs(()=>baseline.worker.createWorker().scheduled({scheduledTime:NOW},a,{waitUntil(){throw Error('AI_FORBIDDEN')}}));
    const rb=await quietLogs(()=>candidate.worker.createWorker().scheduled({scheduledTime:NOW},b,{waitUntil(){throw Error('AI_FORBIDDEN')}}));
    equivalent(publicationSnapshot(b,rb,fb.calls),publicationSnapshot(a,ra,fa.calls),'full scheduled exactness '+ready+'/'+variant);
    assert.equal(JSON.parse(a.DB.sqlite.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
    assert.equal(JSON.parse(b.DB.sqlite.prepare('SELECT config FROM learning_state').get().config).mode,'SHADOW');
    assert.equal(b.PROJECTION_STATS[0].kind,'audience-hit');
    if(variant==='403')assert.equal(fb.calls.filter(c=>c.kind==='telegram').length,0,'unconfirmed price never publishes');
    else {assert.equal(fb.calls.filter(c=>c.kind==='telegram').length,1);assert.ok(b.PROJECTION_STATS.some(c=>c.kind==='shadow'&&c.miss>=1),'fresh selected price invalidates at least its original profile projection');}
    if(variant==='invalid-first')assert.ok(fb.calls.filter(c=>c.kind==='details').length>=2);
  }
});

test('actual staging drivers simulate exactly matching captions, markup and photos with zero external requests',async t=>{
  const {seedProjectionFixture}=await import('./projection_fixture_seed.mjs');const results=[];
  for(const [tree,m] of [[build.referenceDir,baseline],[build.candidateDir,candidate]]){
    const DB=new SQLiteD1();t.after(()=>DB.close());await seedProjectionFixture(DB,{referenceDir:build.referenceDir,now:NOW});
    const e={DB,PRICE_LOCAL_STAGING:'1',TG_BOT_TOKEN:'123:fixture-passive-price',MINIAPP_BOT_USERNAME:'fixture_bot',SCHEDULER_DRIVER:'cloudflare-native',PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:CORE};
    assert.equal(JSON.parse(DB.sqlite.prepare('SELECT data FROM scheduler_policy').get().data).audience_quality?.feedback_enabled,true,'performance fixture must actually enable current audience feedback');
    if(m===candidate){const store=m.adapter.projectionStore(e);await store.init();for(let n=0;n<300;n+=20)await store.prepare({ids:Array.from({length:20},(_,k)=>900000+n+k),now:NOW});}
    const {createProjectionStagingDriver}=await import(pathToFileURL(join(tree,'miniapp/prices/projection_staging_driver.mjs')).href);
    const {observeD1}=await import(pathToFileURL(join(tree,'miniapp/cloudflare/d1_budget.mjs')).href);
    const driver=createProjectionStagingDriver({worker:m.worker.createWorker(),observeD1,storeFactory:m===candidate?candidate.adapter.projectionStore:null});
    const response=await quietLogs(()=>driver.fetch(new Request('https://isolated.test/replay',{method:'POST'}),{...e,PRICE_LOCAL_STAGING:'1',TG_BOT_TOKEN:'123:fixture-passive-price'},{}));
    assert.equal(response.status,200);const result=await response.json();results.push(result);
    assert.equal(result.counts.actualExternalRequests,0);assert.equal(result.counts.wbSearch,0);assert.equal(result.counts.simulatedTelegram,1);assert.equal(result.livePricesValidated,0);
    assert.equal(result.metadataComplete,false,'local SQLite metadata is not Cloudflare billing evidence');
    assert.equal(result.simulatedMessages.length,1);assert.ok(result.simulatedMessages[0].caption);assert.ok(result.simulatedMessages[0].photo);assert.ok(result.simulatedMessages[0].reply_markup);
  }
  equivalent(results[1].counts,results[0].counts,'driver no duplicate WB calls');equivalent(results[1].simulatedMessages,results[0].simulatedMessages,'driver full Telegram captions/markup/photos');
});

test('not-due and quiet scheduled ticks do not read projections or contact WB/Telegram',async t=>{
  for(const mode of ['not-due','quiet']){
    const {a,b}=await pair(t,{ready:20});
    for(const e of [a,b]){
      if(mode==='not-due')e.DB.sqlite.prepare('INSERT INTO scheduler_posts(pid,ts) VALUES(?,?)').run(999999,SEC);
      else {const schedule=JSON.parse(e.DB.sqlite.prepare('SELECT data FROM scheduler_config').get().data);schedule.quiet_enabled=true;schedule.quiet_start='00:00';schedule.quiet_end='23:59';e.DB.sqlite.prepare('UPDATE scheduler_config SET data=?').run(JSON.stringify(schedule));}
      e.PROJECTION_FIXTURE_FETCH=()=>{throw Error('NO_NETWORK_ON_IDLE_TICK');};
    }
    const ra=await quietLogs(()=>baseline.worker.createWorker().scheduled({scheduledTime:NOW},a,{})),rb=await quietLogs(()=>candidate.worker.createWorker().scheduled({scheduledTime:NOW},b,{}));
    equivalent(rb,ra,'idle result');assert.equal(b.PROJECTION_STATS.length,0,'no projection reads on an idle Cron');
  }
});

test('actual channel callbacks preserve totals, exact markup receipts and training while projections stay current',async t=>{
  const {a,b}=await pair(t,{ready:20}),fa=fixtureFetcher(a),fb=fixtureFetcher(b);
  const markup={inline_keyboard:[[{text:'👍',callback_data:'l1000'},{text:'👎',callback_data:'d1000'},{text:'Купил',callback_data:'b1000'}]]};
  for(const [action,event] of [['d',2000],['l',2001],['l',2002],['b',2003],['d',1999],['b',2003]]){
    const callback={data:action+'1000',update_id:event,from:{id:10000},message:{message_id:12345,chat:{id:-100123456789},reply_markup:markup}};
    const va=await quietLogs(()=>baseline.feedback.processCallback(a,callback,fa.fetcher)),vb=await quietLogs(()=>candidate.feedback.processCallback(b,callback,fb.fetcher));
    equivalent(vb,va,'callback current vote and Telegram receipt');await contexts(a,b);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-hit');
  }
  equivalent(fb.calls,fa.calls,'exact callback edits');equivalent(learningSnapshot(b),learningSnapshot(a),'callback training and dedup');
  for(const table of ['reaction_totals','reaction_votes','reaction_messages','reaction_admin_updates'])equivalent(b.DB.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2,3').all(),a.DB.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1,2,3').all(),'callback persisted '+table);
});

test('unavailable fresh original feedback deliberately defers candidate publication instead of using a stale cache',async t=>{
  const {b}=await pair(t,{ready:20});b.DB.exec('DROP INDEX reaction_votes_quality_recent');
  const fake=fixtureFetcher(b);b.PROJECTION_FIXTURE_FETCH=fake.fetcher;
  const result=await quietLogs(()=>candidate.worker.createWorker().scheduled({scheduledTime:NOW},b,{}));
  assert.equal(result.results.post.result,'projection_feedback_unavailable');assert.equal(fake.calls.length,0);assert.equal(b.PROJECTION_STATS.at(-1).kind,'audience-miss');
});
