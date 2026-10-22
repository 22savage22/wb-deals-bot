// Node-only local seeder. Runtime/schema/normalizers are loaded exclusively
// from the pinned ORIGINAL price-only reference tree.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
import {fixtureIdentity,projectionFixtureVisualFields as visualFields,FIXTURE_TYPE_COUNT} from './projection_fixture.mjs';
export async function loadOriginalProjectionFixtureModules(referenceDir){
 const root=path.resolve(referenceDir),rel=path.relative(path.join(ROOT,'.test-temp'),root);
 if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('ORIGINAL_FIXTURE_TREE_REQUIRED');
 const load=name=>import(pathToFileURL(path.join(root,'miniapp/cloudflare',name+'.mjs')).href);
 const [native,reactions,learning,visual,features,readGuard]=await Promise.all(['native_scheduler','feedback','learning','visual_enrichment','visual_features','read_guard'].map(load));
 return {root,native,reactions,learning,visual,features,readGuard};
}
export async function seedProjectionFixture(DB,{referenceDir,now=Date.now()}={}){
 if(!DB||typeof DB.prepare!=='function'||typeof DB.batch!=='function'||!Number.isSafeInteger(now)||now<=0)throw Error('LOCAL_FIXTURE_DB_REQUIRED');
 const modules=await loadOriginalProjectionFixtureModules(referenceDir),seconds=Math.floor(now/1000),products=[],profileRows=[];
 for(let n=0;n<300;n++){
  const identity=fixtureIdentity(900000+n),{visualGroup,...metadata}=identity,image=`https://basket-01.wbbasket.ru/vol0/part1/${identity.id}/images/big/1.webp`;
  const product={...metadata,product:250,basic:250,rating:4.9,feedbacks:120,image};products.push(product);
  const analysis=modules.features.normalizeAnalysis({group:visualGroup,view:'front',fields:visualFields(identity,n)},{url:image,hash:sha('SYNTHETIC_PROJECTION_ONLY:'+identity.id),image_index:0});
  const profile=modules.features.mergeAnalyses([analysis],seconds,modules.visual.VISUAL_MODEL);
  Object.assign(profile,{synthetic:true,fixture_scope:'LOCAL_PROJECTION_ORIGINAL_AB',source_version:modules.visual.visualSourceVersion(product),image_verified_at:seconds});
  profileRows.push([identity.id,modules.features.VISUAL_VERSION,seconds,JSON.stringify(profile),0,0]);
 }
 const schema=await readFile(path.join(modules.root,'miniapp/cloudflare/schema.sql'),'utf8');
 await DB.batch(schema.split(';').map(s=>s.trim()).filter(Boolean).map(sql=>DB.prepare(sql)));
 const env={DB,SCHEDULER_DRIVER:'cloudflare-native'};
 await modules.native.bootstrap(env,{queue:products.slice(0,20),posts:[],policy:{chat_id:'-100123456789',queries:Array.from({length:6},(_,n)=>'fixture группа'+n),max_price:1000,min_rating:4.3,min_feedbacks:20,
  audience_quality:{enabled:true,feedback_enabled:true,fashion_priority:true,excluded:['textbooks','study_aids','notebooks','stationery','books']}}});
 // ORIGINAL bootstrap deliberately preserves only an already-saved quality
 // policy. On this new synthetic DB, enable it explicitly after bootstrap.
 const quality={enabled:true,feedback_enabled:true,fashion_priority:true,excluded:['textbooks','study_aids','notebooks','stationery','books']};
 await DB.prepare("UPDATE scheduler_policy SET data=json_set(data,'$.audience_quality',json(?)) WHERE id=1").bind(JSON.stringify(quality)).run();
 const confirmedPolicy=JSON.parse((await DB.prepare('SELECT data FROM scheduler_policy WHERE id=1').first()).data);
 if(JSON.stringify(confirmedPolicy.audience_quality)!==JSON.stringify(quality))throw Error('SYNTHETIC_FEEDBACK_POLICY_NOT_ENABLED');
 await modules.reactions.ensureReactions(env);await modules.learning.ensureLearning(env);await modules.visual.ensureVisual(env);
 // Prepare the original quota ledger outside measured requests. Its expected
 // missing-table migration would otherwise make first-call metadata unknown.
 await modules.readGuard.withReadBudget(env,'core',1,async()=>null,{writes:2});
 const qualityMigration=await readFile(path.join(modules.root,'miniapp/cloudflare/audience_quality.sql'),'utf8');
 await DB.batch(qualityMigration.replace(/^--[^\n]*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean).map(sql=>DB.prepare(sql)));
 const schedule=JSON.parse((await DB.prepare('SELECT data FROM scheduler_config WHERE id=1').first()).data);
 Object.assign(schedule,{post_interval_minutes:30,search_enabled:false,paused:false,enabled:true,quiet_enabled:false,weekdays:[0,1,2,3,4,5,6]});
 await DB.prepare('UPDATE scheduler_config SET data=?,status=json_patch(status,?) WHERE id=1').bind(JSON.stringify(schedule),JSON.stringify({learning_initialized:1,reactions_initialized:1,last_maintenance:seconds,last_preflight:seconds,last_scan_attempt:seconds})).run();
 // Historical records are not ready and cannot be published by this fixture.
 for(let offset=20;offset<300;offset+=20)await DB.batch(products.slice(offset,offset+20).map(product=>DB.prepare('INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,state,retry_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .bind(product.id,JSON.stringify(product),product.query,'synthetic-historical-'+product.id,seconds-86400,0,seconds-1,'expired',0)));
 for(let offset=0;offset<300;offset+=20)await DB.batch(profileRows.slice(offset,offset+20).map(values=>DB.prepare('INSERT INTO visual_profiles(pid,version,analyzed_at,profile,feedback_cursor,backfill_pending) VALUES(?,?,?,?,?,?)').bind(...values)));
 for(let offset=0;offset<300;offset+=20)await DB.batch(products.slice(offset,offset+20).map(p=>DB.prepare("INSERT INTO reaction_totals(scope,pid) VALUES('channel',?)").bind(p.id)));
 const votes=Array.from({length:500},(_,n)=>({pid:products[n%300].id,voter:'synthetic-projection-voter-'+String(n).padStart(6,'0'),sentiment:(n+Math.floor(n/300))%2?'d':'l',ts:seconds-n}));
 for(let offset=0;offset<500;offset+=20)await DB.batch(votes.slice(offset,offset+20).map(v=>DB.prepare("INSERT INTO reaction_votes(scope,pid,voter,sentiment,bought,revision,last_event,last_changed_event) VALUES('channel',?,?,?,0,1,?,?)").bind(v.pid,v.voter,v.sentiment,v.ts,v.ts)));
 const stats=new Map();for(const vote of votes){const category=products[vote.pid-900000].category,s=stats.get(category)||{positive:0,negative:0,events:0};s[vote.sentiment==='l'?'positive':'negative']++;s.events++;stats.set(category,s);}
 await DB.batch([...stats].map(([category,s])=>DB.prepare("INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('category',?,?,?,?,?)").bind(category,s.positive,s.negative,s.events,seconds)));
 const state=await DB.prepare('SELECT model FROM learning_state WHERE id=1').first(),model={...JSON.parse(state.model),intercept:-.2,weights:{price:.1,reviews:.2,'visual.color=black':.3,'visual.shape=chunky':.1,'category=Сумки':-.05},synthetic_fixture:true};
 await DB.prepare("UPDATE learning_state SET config=json_set(config,'$.mode','SHADOW'),model=? WHERE id=1").bind(JSON.stringify(model)).run();
 const corpusSha256=sha(JSON.stringify({products,profileRows,votes,model,schedule}));
 return {scope:'SYNTHETIC_ORIGINAL_MODULE_FIXTURE',products:300,ready:20,historical:280,currentVotes:500,validatedProfiles:300,categories:FIXTURE_TYPE_COUNT,topics:6,corpusSha256,
  sourceRoot:modules.root,model:modules.visual.VISUAL_MODEL,profileVersion:modules.features.VISUAL_VERSION,postIntervalMinutes:30,searchEnabled:false,learningMode:'SHADOW',quality,originalReadGuardInitialized:true,realTelegramPosts:0,AIModelCalls:0,networkCalls:0};
}
