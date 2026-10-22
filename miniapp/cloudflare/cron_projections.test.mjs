import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCronProjectionTools,PROJECTION_CORE_ID,PROJECTION_LIMITS,PROJECTION_SCHEMA,PROJECTION_READ_SQL,PROJECTION_READ_KNOWN_SQL,PROJECTION_FEEDBACK_SQL} from './cron_projections.mjs';
import {productType,ownerCategory,candidateQuality} from './audience_quality.mjs';
import {productGroup,audience} from './selection_policy.mjs';
import {profileFeatures,VISUAL_VERSION,NORMALIZATION_REVISION,normalizeAnalysis,mergeAnalyses} from './visual_features.mjs';
import {visualSourceVersion,VISUAL_MODEL} from './visual_enrichment.mjs';

// Exact legacy private function only as a test oracle. Parent injects the export
// of its ORIGINAL prototype copy; production/native source is not modified here.
const women=/женск|плать|юбк|блуз|сумк|космет|макияж|серьг|кольц|туфл|колгот|леггин|бюстг|купальник/;
const accessories={bags:/сумк|рюкзак|клатч|кошел/,belts:/ремн|реме|пояс/,caps:/кепк|бейсбол|панам|шляп/,jewelry:/украшен|серьг|кольц|брасл|цепоч|ожерел|кулон|брош/};
const nativeGroups=p=>{const text=[p.title,p.query,p.category].join(' ').toLowerCase(),audience=text.includes('женск')?'women':text.includes('мужск')?'men':women.test(text)?'women':'neutral',accessory=Object.keys(accessories).find(k=>accessories[k].test(text));return {audience,accessory};};
const dependencies={productType,ownerCategory,productGroup,audience,nativeGroups,profileFeatures,visualSourceVersion,visualModel:VISUAL_MODEL,visualVersion:VISUAL_VERSION,normalizationRevision:NORMALIZATION_REVISION,algorithmVersion:'ORIGINAL-524fbe89-projection-v1'};
const tools=createCronProjectionTools(dependencies),now=Date.UTC(2026,9,22,12);
function fixture(id=900001,title='Футболка женская',category='Футболки'){
 const product={id,title,category,query:'футболка женская',product:250,rating:4.9,feedbacks:120,image:`https://basket-01.wbbasket.ru/vol0/part1/${id}/images/big/1.webp`};
 const profile=mergeAnalyses([normalizeAnalysis({group:'apparel',view:'front',fields:{color:{value:'black',confidence:.95,evidence:'Visible black garment body'},fit:{value:'regular',confidence:.9,evidence:'Visible regular shoulder outline'},pattern:{value:'graphic',confidence:.9,evidence:'Visible graphic on chest panel'},print_location:{value:'front',confidence:.9,evidence:'Visible print on front panel'},style:{value:'streetwear',confidence:.9,evidence:'Visible casual graphic outline'}}},{url:product.image,hash:'synthetic-only-'+id})],Math.floor(now/1000),VISUAL_MODEL);
 profile.source_version=visualSourceVersion(product);
 return {pid:id,rawProduct:JSON.stringify(product),rawProfile:JSON.stringify(profile),sourceKind:'inventory',now,product,profile};
}
async function environment(t,{initialize=true,dbPath=':memory:',closeOnFinish=true}={}){
 const db=new DatabaseSync(dbPath);if(closeOnFinish)t.after(()=>db.close());
 db.exec('CREATE TABLE scheduler_inventory(pid INTEGER PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE visual_profiles(pid INTEGER PRIMARY KEY,profile TEXT NOT NULL);');
 const calls=[];let beforeAll=null,afterAll=null;
 const prepare=(sql,args=[])=>({bind(...values){return prepare(sql,values);},async all(){calls.push({sql,args,method:'all'});if(beforeAll)beforeAll(sql,args);const result={results:db.prepare(sql).all(...args)};if(afterAll)afterAll(sql,args);return result;},async run(){calls.push({sql,args,method:'run'});return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}});
 const env={DB:{prepare,async batch(statements){calls.push({method:'batch',size:statements.length});db.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.all());db.exec('COMMIT');return results;}catch(error){db.exec('ROLLBACK');throw error;}}},PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:PROJECTION_CORE_ID};
 const store=tools.openStore(env,{approvedDatabaseId:PROJECTION_CORE_ID});if(initialize)await store.init();calls.length=0;
 return {db,env,store,calls,setBeforeAll(fn){beforeAll=fn;},setAfterAll(fn){afterAll=fn;},insert(f,{inventory=true,profile=true,products=false}={}){
  if(inventory)db.prepare('INSERT OR REPLACE INTO scheduler_inventory VALUES(?,?)').run(f.pid,f.rawProduct);
  if(profile&&f.rawProfile!==null)db.prepare('INSERT OR REPLACE INTO visual_profiles VALUES(?,?)').run(f.pid,f.rawProfile);
  if(products)db.prepare('INSERT OR REPLACE INTO products VALUES(?,?)').run(f.pid,f.rawProduct);
 }};
}
test('factory pins dependency versions and isolated CORE before any D1 operation',()=>{
 assert.throws(()=>createCronProjectionTools({}),/DEPENDENCIES_INVALID/);
 const copy={...dependencies},isolated=createCronProjectionTools(copy);copy.algorithmVersion='changed';assert.equal(isolated.versionKey,tools.versionKey);
 let calls=0;const DB={prepare(){calls++;throw Error('private marker must not escape');},batch(){calls++;throw Error('private marker must not escape');}};
 for(const id of ['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','653d8f5c-a0f5-43b0-9118-fbaaa4bef69f','other'])assert.throws(()=>tools.openStore({DB,PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:id},{approvedDatabaseId:id}),/APPROVED_CORE_REQUIRED/);
 assert.throws(()=>tools.openStore({DB,PROJECTION_DATABASE_ID:PROJECTION_CORE_ID},{approvedDatabaseId:PROJECTION_CORE_ID}),/ISOLATED_CORE_REQUIRED/);assert.equal(calls,0);
});
test('pure prepared values reuse original metadata and distinct quality/River visual semantics',()=>{
 for(const [title,category] of [['Футболка женская','Футболки'],['Сумка для учебников','Сумки'],['Книга приключений','Книги'],['Учебник химии','Учебники'],['Ремень женский','Ремни']]){
  const f=fixture(900001,title,category),record=tools.prepareProductProjection(f),p=tools.validateProductProjection(record,f);
  assert.ok(p);assert.equal(p.productType,productType(f.product));assert.equal(p.ownerCategory,ownerCategory(f.product));assert.equal(p.productGroup,productGroup(f.product));assert.equal(p.audience,audience(f.product));assert.deepEqual(p.nativeGroups,nativeGroups(f.product));assert.deepEqual(p.riverFeatures,profileFeatures(f.profile));
  assert.ok(p.riverFeatures['visual.style=streetwear']);assert.ok(!p.qualityVisualKeys.includes('visual.style=streetwear'));assert.ok(!p.qualityVisualKeys.some(k=>/visual\.(group|combo)=/.test(k)));assert.ok(p.qualityVisualKeys.includes('visual.print_location=front'));
 }
 const f=fixture(),record=tools.prepareProductProjection({...f,rawProfile:null}),p=tools.validateProductProjection(record,{...f,rawProfile:null});assert.ok(p);assert.equal(p.visualPresent,false);assert.deepEqual(p.riverFeatures,{});
});
test('exact product/profile/source/algorithm/model/normalization keys invalidate without a time TTL',()=>{
 const f=fixture(),record=tools.prepareProductProjection(f);assert.ok(record);
 for(const changed of [{rawProduct:f.rawProduct+' '},{rawProduct:JSON.stringify({...f.product,product:251})},{rawProduct:JSON.stringify({...f.product,image_version:2})},{rawProduct:JSON.stringify({...f.product,title:'Книга'})},{rawProfile:f.rawProfile+' '},{rawProfile:null},{sourceKind:'products'},{pid:900002}])assert.equal(tools.validateProductProjection(record,{...f,...changed}),null);
 for(const patch of [{algorithmVersion:'new'}, {visualVersion:VISUAL_VERSION+1},{normalizationRevision:NORMALIZATION_REVISION+1},{visualModel:'other-model'}])assert.equal(createCronProjectionTools({...dependencies,...patch}).validateProductProjection(record,f),null);
 assert.ok(tools.validateProductProjection({...record,prepared_at:1},f),'immutable original cache has no age cutoff; exact source/version is the validity rule');
 assert.equal(tools.validateProductProjection({...record,image_key:'tampered'},f),null);
});
test('malformed and stale profiles are misses, never negative cached successes or new error fallbacks',()=>{
 const f=fixture();
 for(const rawProduct of ['', '{','null','false','[]'])assert.equal(tools.prepareProductProjection({...f,rawProduct}),null);
 for(const rawProfile of ['', '{','null','false','[]',JSON.stringify({...f.profile,model:'old-model'}),JSON.stringify({...f.profile,version:0}),JSON.stringify({...f.profile,source_version:'old-image'}),JSON.stringify({...f.profile,fields:{color:null}})])assert.equal(tools.prepareProductProjection({...f,rawProfile}),null);
 assert.equal(tools.prepareProductProjection({...f,sourceKind:'products'}),null);
 assert.equal(tools.prepareProductProjection({...f,rawProduct:'x'.repeat(PROJECTION_LIMITS.rawChars+1)}),null);
});
test('20-item preparation uses indexed bounded source/CAS queries; hot reads return only small outputs',async t=>{
 const e=await environment(t),fixtures=Array.from({length:20},(_,n)=>fixture(900000+n));fixtures.forEach(f=>e.insert(f));
 const ids=fixtures.map(f=>f.pid),result=await e.store.prepare({ids,now});assert.equal(result.written,20);assert.equal(result.queries,2);assert.equal(e.db.prepare('SELECT records FROM cron_projection_counts').get().records,20);
 e.calls.length=0;const hit=await e.store.read(ids);assert.equal(hit.available,true);assert.equal(hit.hits,20);assert.equal(e.calls.length,1);assert.equal(e.calls[0].sql,PROJECTION_READ_SQL);
 const rawReply=e.db.prepare(PROJECTION_READ_SQL).all(JSON.stringify(ids),tools.versionKey);assert.deepEqual(Object.keys(rawReply[0]),['pid','output']);assert.ok(rawReply.every(r=>!r.output.includes('Visible black garment body')),'no raw profile evidence in hit output');
 for(const f of fixtures)assert.deepEqual(hit.projections.get(f.pid),tools.validateProductProjection(tools.prepareProductProjection(f),f));
 const again=await e.store.prepare({ids,now:now+1000});assert.equal(again.alreadyCurrent,20);assert.equal(again.written,0);assert.equal(again.queries,1);
 const explain=e.db.prepare('EXPLAIN QUERY PLAN '+PROJECTION_READ_SQL).all(JSON.stringify(ids),tools.versionKey).map(r=>r.detail).join('\n');assert.match(explain,/SEARCH c USING INTEGER PRIMARY KEY/);assert.match(explain,/SEARCH i USING INTEGER PRIMARY KEY/);assert.match(explain,/SEARCH v USING INTEGER PRIMARY KEY/);
 await assert.rejects(e.store.prepare({ids:[...ids,999999],now}),/IDS_INVALID/);await assert.rejects(e.store.read(Array.from({length:301},(_,n)=>n+1)),/IDS_INVALID/);await assert.rejects(e.store.read([1,1]),/IDS_INVALID/);
});
test('SQL exact invalidation wins for title/price/image/profile edits; owner ban and miss fallback remain mandatory',async t=>{
 const e=await environment(t),f=fixture();e.insert(f);await e.store.prepare({ids:[f.pid],now});
 for(const patch of [{title:'Учебник химии',category:'Учебники'},{product:251},{image_version:2},{image:f.product.image.replace('/1.webp','/3.webp')}]){
  const changed={...f.product,...patch};e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify(changed),f.pid);assert.equal((await e.store.read([f.pid])).hits,0);
  if(patch.title)assert.equal(candidateQuality(changed,{audience_quality:{enabled:true,excluded:['textbooks']}}).allowed,false);
  e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(f.rawProduct,f.pid);assert.equal((await e.store.read([f.pid])).hits,1);
 }
 e.db.prepare('UPDATE visual_profiles SET profile=profile||? WHERE pid=?').run(' ',f.pid);assert.equal((await e.store.read([f.pid])).hits,0);
 e.db.prepare('UPDATE visual_profiles SET profile=? WHERE pid=?').run('{',f.pid);assert.equal((await e.store.read([f.pid])).hits,0);assert.equal((await e.store.prepare({ids:[f.pid],now})).uncacheable,1);assert.equal((await e.store.read([f.pid])).hits,0);
});
test('COALESCE products fallback never acquires an orphan visual profile; source precedence changes invalidate',async t=>{
 const e=await environment(t),f=fixture();e.insert(f,{inventory:false,products:true,profile:true});
 assert.equal((await e.store.prepare({ids:[f.pid],now})).written,1);let read=await e.store.read([f.pid]);assert.equal(read.hits,1);assert.equal(read.projections.get(f.pid).visualPresent,false);
 e.insert(f,{inventory:true,profile:false});assert.equal((await e.store.read([f.pid])).hits,0);assert.equal((await e.store.prepare({ids:[f.pid],now})).written,1);read=await e.store.read([f.pid]);assert.equal(read.projections.get(f.pid).visualPresent,true);
 e.db.prepare('UPDATE products SET data=? WHERE id=?').run(JSON.stringify({...f.product,title:'Unused fallback changed'}),f.pid);assert.equal((await e.store.read([f.pid])).hits,1,'unused fallback data cannot change current COALESCE source');
 e.db.prepare('DELETE FROM scheduler_inventory WHERE pid=?').run(f.pid);assert.equal((await e.store.read([f.pid])).hits,0);
});
test('atomic CAS refuses changed source data/profile or a new higher-priority inventory source',async t=>{
 for(const mode of ['product','profile','source']){
  const e=await environment(t),f=fixture();e.insert(f,{inventory:mode!=='source',products:mode==='source'});
  e.setBeforeAll(sql=>{if(!sql.startsWith('INSERT INTO cron_product_projections'))return;
   if(mode==='product')e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify({...f.product,title:'Книга'}),f.pid);
   if(mode==='profile')e.db.prepare('UPDATE visual_profiles SET profile=? WHERE pid=?').run(JSON.stringify({...f.profile,source_version:'changed'}),f.pid);
   if(mode==='source')e.insert(f,{inventory:true,profile:false});
  });
  const result=await e.store.prepare({ids:[f.pid],now});assert.equal(result.written,0);assert.equal(result.casSkipped,1);assert.equal((await e.store.read([f.pid])).hits,0);
 }
});
test('durable capacity counts logical rows despite triggers and permits exact refresh at full capacity',async t=>{
 const e=await environment(t),f=fixture(),record=tools.prepareProductProjection(f);
 const insert=e.db.prepare('INSERT INTO cron_product_projections VALUES(?,?,?,?,?,?,?,?)');
 for(let pid=1;pid<PROJECTION_LIMITS.records;pid++)insert.run(pid,record.source_kind,record.raw_product,record.raw_profile,record.version_key,record.image_key,record.output,record.prepared_at);
 const fixtures=Array.from({length:20},(_,n)=>fixture(900000+n));fixtures.forEach(row=>e.insert(row));
 const result=await e.store.prepare({ids:fixtures.map(row=>row.pid),now});assert.equal(result.written,1);assert.equal(e.db.prepare('SELECT COUNT(*) n FROM cron_product_projections').get().n,1000);assert.equal(e.db.prepare('SELECT records FROM cron_projection_counts').get().records,1000);
 const accepted=fixtures[0],next=JSON.stringify({...accepted.product,product:300});e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(next,accepted.pid);
 assert.equal((await e.store.prepare({ids:[accepted.pid],now:now+1})).written,1);assert.equal((await e.store.read([accepted.pid])).hits,1);assert.equal(e.db.prepare('SELECT records FROM cron_projection_counts').get().records,1000);
});
test('read never initializes DDL, missing/failed DB is explicit unavailable, errors reveal no raw message',async t=>{
 const e=await environment(t,{initialize:false}),read=await e.store.read([1]);assert.equal(read.available,false);assert.equal(read.reason,'PROJECTION_READ_UNAVAILABLE');assert.equal(e.calls.length,1);assert.equal(e.db.prepare("SELECT name FROM sqlite_master WHERE name='cron_product_projections'").get(),undefined);
 const marker='private-upstream-error-marker',env={PROJECTION_ISOLATED:'true',PROJECTION_DATABASE_ID:PROJECTION_CORE_ID,DB:{prepare(){throw Error(marker);},async batch(){throw Error(marker);}}},store=tools.openStore(env,{approvedDatabaseId:PROJECTION_CORE_ID});
 assert.ok(!JSON.stringify(await store.read([1])).includes(marker));await assert.rejects(store.init(),error=>error.message==='PROJECTION_INITIALIZATION_UNAVAILABLE');await assert.rejects(store.prepare({ids:[1],now}),error=>error.message==='PROJECTION_PREPARE_UNAVAILABLE');
 assert.deepEqual(await store.read([]),{available:true,projections:new Map(),requested:0,hits:0,queries:0});assert.equal(PROJECTION_SCHEMA.length,7);
});
test('readKnown proves the caller row snapshot as well as the current D1 source, without returning raw D1 JSON',async t=>{
 const e=await environment(t),f=fixture();e.insert(f);await e.store.prepare({ids:[f.pid],now});
 const input={pid:f.pid,data:f.rawProduct},read=await e.store.readKnown([input]);assert.equal(read.available,true);assert.equal(read.hits,1);assert.equal(read.projections.get(f.pid).sourceData,input.data);assert.equal(read.queries,1);
 const reply=e.db.prepare(PROJECTION_READ_KNOWN_SQL).all(JSON.stringify([input]),tools.versionKey);assert.deepEqual(Object.keys(reply[0]),['pid','output']);
 const next=JSON.stringify({...f.product,title:'Учебник химии',category:'Учебники'});e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(next,f.pid);await e.store.prepare({ids:[f.pid],now:now+1});
 assert.equal((await e.store.read([f.pid])).hits,1);assert.equal((await e.store.readKnown([input])).hits,0,'fresh D1 projection cannot classify the caller old row snapshot');
 const current=await e.store.readKnown([{pid:f.pid,data:next}]);assert.equal(current.hits,1);assert.equal(current.projections.get(f.pid).ownerCategory,'textbooks');
 await assert.rejects(e.store.readKnown([input,input]),/ROWS_INVALID/);
 const large=Array.from({length:300},(_,n)=>({pid:n+1,data:'x'.repeat(32768)}));e.calls.length=0;const unavailable=await e.store.readKnown(large);assert.equal(unavailable.available,false);assert.equal(unavailable.reason,'PROJECTION_INPUT_TOO_LARGE');assert.equal(e.calls.length,0);
});
test('300 indexed positive hits and large prepare20 batches stay within explicit query/payload bounds',async t=>{
 const e=await environment(t),fixtures=Array.from({length:300},(_,n)=>fixture(900000+n));fixtures.forEach(f=>e.insert(f));
 for(let n=0;n<300;n+=20)assert.equal((await e.store.prepare({ids:fixtures.slice(n,n+20).map(f=>f.pid),now})).written,20);
 const read=await e.store.readKnown(fixtures.map(f=>({pid:f.pid,data:f.rawProduct})));assert.equal(read.hits,300);assert.ok(read.queries<=4);
 const large=Array.from({length:20},(_,n)=>{const f=fixture(901000+n);return {...f,rawProduct:JSON.stringify({...f.product,padding:'x'.repeat(30000)}),rawProfile:JSON.stringify({...f.profile,padding:'x'.repeat(30000)})};});large.forEach(f=>e.insert(f));
 e.calls.length=0;const prepared=await e.store.prepare({ids:large.map(f=>f.pid),now});assert.equal(prepared.written,20);assert.ok(prepared.queries>2);assert.ok(prepared.queries<=21);
 const writes=e.calls.filter(call=>call.sql?.startsWith('INSERT INTO cron_product_projections'));assert.ok(writes.every(call=>call.args[0].length<=PROJECTION_LIMITS.batchChars));
 const hit=await e.store.readKnown(large.map(f=>({pid:f.pid,data:f.rawProduct})));assert.equal(hit.hits,20);assert.ok(hit.queries<=4);
});
test('readFeedback computes the fresh original top500 order including empty sentiments and never returns profile/data',async t=>{
 const e=await environment(t),fixtures=Array.from({length:300},(_,n)=>fixture(900000+n));fixtures.forEach(f=>e.insert(f));
 for(let n=0;n<300;n+=20)await e.store.prepare({ids:fixtures.slice(n,n+20).map(f=>f.pid),now});
 e.db.exec('CREATE TABLE reaction_votes(scope TEXT NOT NULL,pid INTEGER NOT NULL,voter TEXT NOT NULL,sentiment TEXT NOT NULL,last_event INTEGER NOT NULL);CREATE INDEX reaction_votes_quality_recent ON reaction_votes(scope,last_event DESC);');
 const insert=e.db.prepare('INSERT INTO reaction_votes VALUES(?,?,?,?,?)');
 for(let n=0;n<501;n++)insert.run('channel',fixtures[n%300].pid,'synthetic-voter-'+n,n===500?'':n%2?'d':'l',n);
 insert.run('test:fixture',fixtures[0].pid,'ignored-other-scope','d',99999);
 let feedback=await e.store.readFeedback();assert.equal(feedback.available,true);assert.equal(feedback.rows.length,500);assert.equal(feedback.rows[0].voter,'synthetic-voter-500');assert.equal(feedback.rows[0].sentiment,'');assert.equal(feedback.rows.at(-1).voter,'synthetic-voter-1');
 const first=feedback.rows[0];assert.equal(typeof first.projected_visualKeys,'string');assert.ok(Array.isArray(JSON.parse(first.projected_visualKeys)));assert.equal(first.projected_type,'tshirt');assert.equal(first.visualPresent,true);assert.deepEqual(Object.keys(first),['pid','voter','sentiment','projected_type','projected_visualKeys','visualPresent']);
 e.db.prepare('UPDATE reaction_votes SET sentiment=?,last_event=? WHERE voter=?').run('d',100000,'synthetic-voter-0');feedback=await e.store.readFeedback();assert.equal(feedback.rows[0].voter,'synthetic-voter-0');assert.equal(feedback.rows[0].sentiment,'d');assert.equal(feedback.rows.at(-1).voter,'synthetic-voter-2');
 const plan=e.db.prepare('EXPLAIN QUERY PLAN '+PROJECTION_FEEDBACK_SQL).all(tools.versionKey).map(row=>row.detail).join('\n');assert.match(plan,/reaction_votes_quality_recent/);
});
test('any missing or invalid feedback projection requires whole original fallback, without omitting a dislike',async t=>{
 const e=await environment(t),a=fixture(900001),b=fixture(900002);e.insert(a);e.insert(b);
 e.db.exec('CREATE TABLE reaction_votes(scope TEXT NOT NULL,pid INTEGER NOT NULL,voter TEXT NOT NULL,sentiment TEXT NOT NULL,last_event INTEGER NOT NULL);CREATE INDEX reaction_votes_quality_recent ON reaction_votes(scope,last_event DESC);');
 const vote=e.db.prepare('INSERT INTO reaction_votes VALUES(?,?,?,?,?)');vote.run('channel',a.pid,'synthetic-positive','l',2);vote.run('channel',b.pid,'synthetic-negative','d',1);
 await e.store.prepare({ids:[a.pid],now});let read=await e.store.readFeedback();assert.equal(read.available,false);assert.deepEqual(read.rows,[]);
 await e.store.prepare({ids:[b.pid],now});assert.equal((await e.store.readFeedback()).rows.length,2);
 const original=e.db.prepare('SELECT output FROM cron_product_projections WHERE pid=?').get(b.pid).output;
 for(const patch of [{productType:{}},{qualityVisualKeys:{}},{qualityVisualKeys:['visual.group=apparel']},{visualPresent:0},{visualPresent:false},{versionKey:'old'}]){
  e.db.prepare('UPDATE cron_product_projections SET output=? WHERE pid=?').run(JSON.stringify({...JSON.parse(original),...patch}),b.pid);read=await e.store.readFeedback();assert.equal(read.available,false,JSON.stringify(patch));assert.deepEqual(read.rows,[]);
 }
 e.db.prepare('UPDATE cron_product_projections SET output=? WHERE pid=?').run(original,b.pid);
 e.db.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify({...b.product,image_version:2}),b.pid);assert.equal((await e.store.readFeedback()).available,false);
});
test('readContext uses one real local transaction snapshot despite a concurrent committed source/profile edit',async t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'wb-projection-snapshot-')),dbPath=path.join(directory,'fixture.sqlite');let e,writer;
 try{
  e=await environment(t,{dbPath,closeOnFinish:false});e.db.exec('PRAGMA journal_mode=WAL');writer=new DatabaseSync(dbPath);
  const f=fixture();e.insert(f);await e.store.prepare({ids:[f.pid],now});
  e.db.exec("CREATE TABLE reaction_votes(scope TEXT NOT NULL,pid INTEGER NOT NULL,voter TEXT NOT NULL,sentiment TEXT NOT NULL,last_event INTEGER NOT NULL);CREATE INDEX reaction_votes_quality_recent ON reaction_votes(scope,last_event DESC);");
  e.db.prepare('INSERT INTO reaction_votes VALUES(?,?,?,?,?)').run('channel',f.pid,'synthetic-voter','d',1);
  let updates=0;e.setAfterAll(sql=>{if(sql!==PROJECTION_FEEDBACK_SQL||updates)return;updates++;
   writer.prepare('UPDATE scheduler_inventory SET data=? WHERE pid=?').run(JSON.stringify({...f.product,title:'Учебник химии',category:'Учебники'}),f.pid);
   writer.prepare('UPDATE visual_profiles SET profile=? WHERE pid=?').run(JSON.stringify({...f.profile,source_version:'new-photo'}),f.pid);
  });
  e.calls.length=0;const context=await e.store.readContext([{pid:f.pid,data:f.rawProduct}]);
  assert.equal(updates,1);assert.equal(context.available,true);assert.equal(context.queries,2);assert.equal(context.feedback.rows[0].sentiment,'d');assert.equal(context.feedback.rows[0].projected_type,'tshirt');assert.equal(context.known.hits,1);assert.equal(context.known.projections.get(f.pid).productType,'tshirt');
  assert.equal(e.calls.filter(c=>c.method==='batch').length,1);assert.equal(e.calls.filter(c=>c.method==='all').length,2);
  assert.equal((await e.store.readKnown([{pid:f.pid,data:f.rawProduct}])).hits,0,'a later transaction sees the committed invalidation');
  assert.equal((await e.store.readFeedback()).available,false);
 }finally{
  writer?.close();e?.db.close();for(const file of [dbPath,dbPath+'-wal',dbPath+'-shm'])if(existsSync(file))unlinkSync(file);rmdirSync(directory);
 }
});
test('readContext missing data, oversized input or failed batch never yields a partial feedback context',async t=>{
 const e=await environment(t),f=fixture();e.insert(f);
 e.db.exec('CREATE TABLE reaction_votes(scope TEXT NOT NULL,pid INTEGER NOT NULL,voter TEXT NOT NULL,sentiment TEXT NOT NULL,last_event INTEGER NOT NULL);CREATE INDEX reaction_votes_quality_recent ON reaction_votes(scope,last_event DESC);');
 e.db.prepare('INSERT INTO reaction_votes VALUES(?,?,?,?,?)').run('channel',f.pid,'synthetic-voter','d',1);
 let context=await e.store.readContext([{pid:f.pid,data:f.rawProduct}]);assert.equal(context.available,false);assert.equal(context.feedback.available,false);assert.deepEqual(context.feedback.rows,[]);assert.equal(context.known.hits,0);
 await e.store.prepare({ids:[f.pid],now});context=await e.store.readContext([]);assert.equal(context.available,true);assert.equal(context.queries,1);assert.equal(context.known.queries,0);
 e.calls.length=0;context=await e.store.readContext(Array.from({length:300},(_,n)=>({pid:n+1,data:'x'.repeat(32768)})));assert.equal(context.available,false);assert.equal(context.queries,0);assert.equal(e.calls.length,0);
 const marker='private-batch-marker',broken=tools.openStore({...e.env,DB:{...e.env.DB,async batch(){throw Error(marker);}}},{approvedDatabaseId:PROJECTION_CORE_ID});context=await broken.readContext([{pid:f.pid,data:f.rawProduct}]);assert.equal(context.available,false);assert.equal(context.feedback.available,false);assert.equal(context.known.available,false);assert.ok(!JSON.stringify(context).includes(marker));
});
