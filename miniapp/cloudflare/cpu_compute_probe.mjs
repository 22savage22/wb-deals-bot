// Node-only, synthetic, network-free CPU attribution. Never imported by runtime.
import {cpuUsage,version as nodeVersion} from 'node:process';
import {Session} from 'node:inspector';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sourceDirectory=fileURLToPath(new URL('./',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
export async function loadComputeModules(directory=sourceDirectory){
 const root=path.resolve(directory),load=name=>import(pathToFileURL(path.join(root,name+'.mjs')).href);
 const [quality,feedback,learning,visual,visualFeatures,native,reactions]=await Promise.all(['audience_quality','audience_feedback','learning','visual_enrichment','visual_features','native_scheduler','feedback'].map(load));
 return {root,quality,feedback,learning,visual,visualFeatures,native,reactions};
}
export function syntheticComputeFixture(modules,{size=300,voteCount=500}={}){
 if(size!==300||voteCount!==500)throw Error('FIXTURE_CARDINALITY_REQUIRED');
 const ts=Date.UTC(2026,9,22,12)/1000,rows=[],profiles=[];
 for(let n=0;n<size;n++){
  const id=900000+n,image=`https://basket-01.wbbasket.ru/vol0/part1/${id}/images/big/1.webp`;
  const product={id,title:'Fixture товар '+id,category:'Футболки',query:'футболка группа'+n%3,product:250,basic:250,rating:4.9,feedbacks:120,brand:'Fixture',image};
  const analysis=modules.visualFeatures.normalizeAnalysis({group:'apparel',view:'front',fields:{
   color:{value:['black','white','blue'][n%3],confidence:.95,evidence:'Synthetic fixture garment body colour'},
   fit:{value:'regular',confidence:.9,evidence:'Synthetic fixture regular straight outline'},
   pattern:{value:'solid',confidence:.95,evidence:'Synthetic fixture single consistent colour'}
  }},{url:image,hash:digest('SYNTHETIC_FIXTURE_ONLY:'+id),image_index:0});
  const profile=modules.visualFeatures.mergeAnalyses([analysis],ts,modules.visual.VISUAL_MODEL);
  Object.assign(profile,{synthetic:true,source_version:modules.visual.visualSourceVersion(product)});
  const data=JSON.stringify(product);
  rows.push({pid:id,data,topic:product.query,title_key:'fixture'+id,checked_at:ts,queued_at:ts-n});
  profiles.push({pid:id,profile:JSON.stringify(profile),data});
 }
 const votes=Array.from({length:voteCount},(_,n)=>({pid:rows[n%size].pid,voter:'synthetic-voter-'+n,sentiment:(n+Math.floor(n/size))%2?'d':'l',data:rows[n%size].data,
  visual_keys:['visual.color='+['black','white','blue'][n%size%3],'visual.fit=regular','visual.pattern=solid']}));
 const policy={audience_quality:{enabled:true,feedback_enabled:true,fashion_priority:true,excluded:['textbooks','study_aids','notebooks','stationery','books']}};
 const recent=rows.slice(0,20).map((r,n)=>({...r,pid:r.pid+10000,title_key:'recent'+n,topic:'recent'+n}));
 const model={version:1,intercept:-.2,weights:{price:.1,reviews:.2,'visual.color=black':.3,hour:.01},cursor:0,trained_events:0};
 const state={config:JSON.stringify({mode:'SHADOW',exploration_percent:10}),model:JSON.stringify(model)};
 const stats=[{key:'Футболки',positive:250,negative:250,events:500}];
 const profileIndex=new Map(profiles.map(r=>[r.pid,r])),requestedProfiles=new Map();
 const statements=[];
 function prepare(sql,args=[]){
  return {bind(...values){return prepare(sql,values);},async first(){statements.push({sql,args,method:'first'});if(sql==='SELECT * FROM learning_state WHERE id=1')return state;throw Error('UNEXPECTED_SYNTHETIC_FIRST');},
   async all(){statements.push({sql,args,method:'all'});if(sql===modules.feedback.FEEDBACK_SQL)return {results:votes};
    if(sql.startsWith('SELECT key,positive,negative FROM learning_stats'))return {results:stats};
    if(sql.startsWith('SELECT v.pid,v.profile,i.data FROM visual_profiles')){
     if(!requestedProfiles.has(args[0]))requestedProfiles.set(args[0],JSON.parse(args[0]).map(id=>profileIndex.get(id)).filter(Boolean));
     return {results:requestedProfiles.get(args[0])};
    }throw Error('UNEXPECTED_SYNTHETIC_ALL');},async run(){statements.push({sql,args,method:'run'});if(!sql.startsWith('INSERT OR REPLACE INTO learning_shadow'))throw Error('UNEXPECTED_SYNTHETIC_WRITE');return {meta:{changes:1}};}};
 }
 const environment={DB:{prepare}},products=rows.map(r=>JSON.parse(r.data)),parsedProfiles=profiles.map(r=>JSON.parse(r.profile));
 return {ts,rows,profiles,votes,policy,recent,model,state,stats,products,parsedProfiles,environment,statements,
  fingerprint:digest(JSON.stringify({rows,profiles,votes,policy,recent,model,ts})),resetStatements(){statements.length=0;}};
}
function cpuMilliseconds(start){const used=cpuUsage(start);return (used.user+used.system)/1000;}
function median(values){const a=[...values].sort((x,y)=>x-y);return a[Math.floor(a.length/2)];}
async function timedStage(task,{blocks=5,iterations=30}={}){
 for(let n=0;n<5;n++)await task();
 const times=[];for(let block=0;block<blocks;block++){const start=cpuUsage();for(let n=0;n<iterations;n++)await task();times.push(cpuMilliseconds(start)/iterations);}
 return {unit:'local_process_cpu_ms_per_call',iterationsPerBlock:iterations,blocks,median:median(times),min:Math.min(...times),max:Math.max(...times),samples:times};
}
export function computeStages(modules,fixture){
 const {quality,feedback,learning,visual,visualFeatures,native}=modules,f=fixture;
 const context=quality.summariseVotes(f.votes);context.visual=new Map(f.parsedProfiles.map((p,n)=>[f.rows[n].pid,Object.keys(visualFeatures.profileFeatures(p))]));
 const measured=task=>async()=>{f.resetStatements();return task();};
 const stages={
  productType300:()=>f.products.map(p=>quality.productType(p)),
  currentReactionVotes500:()=>quality.summariseVotes(f.votes),
  profileJSONParse300:()=>f.profiles.map(p=>JSON.parse(p.profile)),
  profileJSONStringify300:()=>f.parsedProfiles.map(p=>JSON.stringify(p)),
  cachedProfiles300:measured(()=>visual.cachedProfiles(f.environment,f.rows.map(r=>r.pid))),
  audienceContext20:measured(()=>feedback.audienceContext(f.environment,f.rows.slice(0,20).map(r=>r.pid))),
  audienceContext300:measured(()=>feedback.audienceContext(f.environment,f.rows.map(r=>r.pid))),
  riverFeaturePredict300:()=>f.products.map(p=>learning.predict(f.model,{...learning.features(p,f.ts,.5),...visualFeatures.profileFeatures(f.parsedProfiles[p.id-900000])})),
  shadowChoice20:measured(()=>learning.shadowChoice(f.environment,f.rows.slice(0,20),f.rows[0],f.ts)),
  shadowChoice300:measured(()=>learning.shadowChoice(f.environment,f.rows,f.rows[0],f.ts)),
  choose20:()=>native.choose(f.rows.slice(0,20),f.recent,20,f.policy,context),
  choose300:()=>native.choose(f.rows,f.recent,20,f.policy,context),
 };
 for(const size of [20,300])stages['fullCompute'+size]=measured(async()=>{
  const rows=f.rows.slice(0,size),audience=await feedback.audienceContext(f.environment,rows.map(r=>r.pid));
  const selected=native.choose(rows,f.recent,20,f.policy,audience);
  await learning.shadowChoice(f.environment,rows,selected,f.ts);
  // Mirrors the synchronous persisted SHADOW JSON; no Telegram request.
  return JSON.stringify({selected:selected.pid,writes:f.statements.filter(s=>s.method==='run')});
 });
 return stages;
}
export async function countComputeOperations(modules,fixture){
 const result={},parse=JSON.parse,RegExpOriginal=globalThis.RegExp,format=Intl.DateTimeFormat.prototype.formatToParts;
 for(const [name,task] of Object.entries(computeStages(modules,fixture)).filter(([name])=>['productType300','currentReactionVotes500','shadowChoice20','shadowChoice300','choose20','choose300','fullCompute20','fullCompute300'].includes(name))){
  const count={jsonParse:0,regexpConstruction:0,formatToParts:0};
  JSON.parse=function(...args){count.jsonParse++;return Reflect.apply(parse,this,args);};
  globalThis.RegExp=new Proxy(RegExpOriginal,{construct(target,args,newTarget){count.regexpConstruction++;return Reflect.construct(target,args,newTarget);},apply(target,thisArg,args){count.regexpConstruction++;return Reflect.apply(target,thisArg,args);}});
  Intl.DateTimeFormat.prototype.formatToParts=function(...args){count.formatToParts++;return Reflect.apply(format,this,args);};
  try{await task();}finally{JSON.parse=parse;globalThis.RegExp=RegExpOriginal;Intl.DateTimeFormat.prototype.formatToParts=format;}
  result[name]=count;
 }
 return result;
}
// These are isolated, repeated estimates for one small outgoing body/markup,
// not assertions that reaction repair runs in each post. No DB/fetch is called.
export async function probeMessageSerialization(modules,fixture){
 const p=fixture.products[0],pid=p.id,url=`https://www.wildberries.ru/catalog/${pid}/detail.aspx`,miniapp='https://t.me/Fixture_bot?start=';
 const markup={inline_keyboard:[[{text:'Открыть на WB',url}],[{text:'👍 0',callback_data:'l'+pid},{text:'👎 0',callback_data:'d'+pid},{text:'🛒 Купил 0',callback_data:'b'+pid}],[{text:'🔖 Сохранить',url:miniapp+'save_'+pid},{text:'✨ Собрать образ',url:miniapp+'look_'+pid}]]};
 const caption=`✨ <b>${p.title}</b>\n\n💰 Цена из ответа WB: <b>${p.product} ₽</b>\n📐 Вариант: SKU ${pid}\n⭐ ${p.rating} · ${p.feedbacks} отзывов\n${p.brand}\n\nИтоговая цена и наличие на WB могут зависеть от размера, региона и условий оплаты.`;
 const body={chat_id:'synthetic-fixture-channel',photo:p.image,caption,parse_mode:'HTML',reply_markup:markup},totals={likes:250,dislikes:250,bought:3},repeats=4096;
 const stages={reactionMarkup:()=>modules.reactions.reactionMarkup(markup,pid,totals),sendPhotoJSONStringify:()=>JSON.stringify(body),reactionReceiptJSONStringify:()=>JSON.stringify({message_id:1,totals,reply_markup:markup,ts:fixture.ts})},timings={};
 for(const [key,task] of Object.entries(stages)){
  const grouped=await timedStage(()=>{for(let n=0;n<repeats;n++)task();},{blocks:5,iterations:5});
  timings[key]={...grouped,repeatsPerMeasuredCall:repeats,estimatedCpuMsPerMessage:grouped.median/repeats};
 }
 return {scope:'ISOLATED_SYNTHETIC_MESSAGE_ESTIMATES',networkCalls:0,databaseStatementsExecuted:0,bodyBytes:Buffer.byteLength(JSON.stringify(body)),timings,
  limitations:['No reaction callback, HMAC, vote SQL, repair leases or Telegram I/O is included.','Repeated small-operation estimates; not the CPU attribution of an actual Worker request.']};
}
// Representation-only experiment on an already computed immutable corpus.
// This is NOT a runtime cache: no invalidation, persistence or DB is added.
export async function probeImmutableAggregate(modules,fixture){
 const context=await modules.feedback.audienceContext(fixture.environment,fixture.rows.slice(0,20).map(r=>r.pid));
 const encode=c=>JSON.stringify({...c,items:[...c.items],traits:[...c.traits],visual:[...c.visual]});
 const payload=encode(context),hydrate=()=>{const c=JSON.parse(payload);return {...c,items:new Map(c.items),traits:new Map(c.traits),visual:new Map(c.visual)};};
 const restored=hydrate(),sameAggregate=isDeepStrictEqual(context,restored),sameChoice=modules.native.choose(fixture.rows,fixture.recent,20,fixture.policy,context)===modules.native.choose(fixture.rows,fixture.recent,20,fixture.policy,restored);
 if(!sameAggregate||!sameChoice)throw Error('IMMUTABLE_AGGREGATE_DIFFERENTIAL_FAILED');
 return {scope:'FROZEN_INPUT_REPRESENTATION_EXPERIMENT_ONLY',sameAggregate,sameChoice,bytes:Buffer.byteLength(payload),currentVotes:fixture.votes.length,profiles:fixture.profiles.length,
  hydration:await timedStage(hydrate,{blocks:5,iterations:200}),serialization:await timedStage(()=>encode(context),{blocks:5,iterations:200}),
  limitations:['Not a runtime cache or freshness proof.','Requires transactional mutation epochs on all contributing vote/card/profile/code changes; TTL is insufficient.','Future misses must recompute existing logic, never use a stale snapshot.','No Cloudflare CPU, extra Worker CPU, DB cost or daily account totals measured.']};
}
async function sampledFrames(task,iterations){
 const session=new Session();session.connect();const post=(name,params={})=>new Promise((resolve,reject)=>session.post(name,params,(error,result)=>error?reject(error):resolve(result)));
 try{await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');for(let n=0;n<iterations;n++)await task();
  const {profile}=await post('Profiler.stop'),nodes=new Map(profile.nodes.map(n=>[n.id,n])),totals=new Map();
  for(let n=0;n<(profile.samples||[]).length;n++){const frame=nodes.get(profile.samples[n])?.callFrame;if(!frame)continue;
   const file=frame.url.startsWith('file:')?fileURLToPath(frame.url):frame.url;
   const key=[frame.functionName||'(anonymous)',path.basename(file),frame.lineNumber+1].join(':');totals.set(key,(totals.get(key)||0)+(profile.timeDeltas[n]||0)/1000);}
  return {unit:'V8_sampled_self_ms_local_process',iterations,samples:profile.samples?.length||0,top:[...totals].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([frame,ms])=>({frame,ms}))};
 }finally{session.disconnect();}
}
export async function runComputeProbe({directory=sourceDirectory,blocks=5,iterations=30,profileIterations=60}={}){
 const modules=await loadComputeModules(directory),fixture=syntheticComputeFixture(modules),stages=computeStages(modules,fixture),timings={};
 const operations=await countComputeOperations(modules,fixture);
 for(const [name,task] of Object.entries(stages))timings[name]=await timedStage(task,{blocks,iterations});
 const fullOutputs={};for(const size of [20,300])fullOutputs[size]=digest(await stages['fullCompute'+size]());
 const sourceHashes={};for(const file of ['audience_quality.mjs','audience_feedback.mjs','learning.mjs','visual_enrichment.mjs','native_scheduler.mjs'])sourceHashes[file]=digest(await readFile(path.join(modules.root,file)));
 return {scope:'SYNTHETIC_LOCAL_COMPUTE_ONLY',node:nodeVersion,moduleRoot:modules.root,sourceHashes,fixture:{products:300,currentVotes:500,profiles:300,fingerprint:fixture.fingerprint},networkCalls:0,databaseStatementsExecuted:0,
  limitations:['Process CPU has OS accounting quantization and JIT/GC noise.','Stages overlap; their timings must not be added.','No D1, network latency, Cloudflare CPU, quotas or billing measured.','Reaction mutation/repair I/O is excluded; current-vote projection is explicitly measured.'],operations,timings,fullOutputHashes:fullOutputs,
  sampling:profileIterations?await sampledFrames(stages.fullCompute20,profileIterations):null,messageEstimates:await probeMessageSerialization(modules,fixture),immutableAggregateExperiment:await probeImmutableAggregate(modules,fixture)};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),opts={};let out;
 for(let n=0;n<args.length;n++){const key=args[n],value=args[++n];if(key==='--directory')opts.directory=path.resolve(value);else if(key==='--out')out=path.resolve(value);else if(key==='--iterations')opts.iterations=Number(value);else if(key==='--profile-iterations')opts.profileIterations=Number(value);else throw Error('INVALID_PROBE_ARGUMENT');}
 if(!Number.isSafeInteger(opts.iterations??30)||(opts.iterations??30)<5||(opts.iterations??30)>500||!Number.isSafeInteger(opts.profileIterations??60)||(opts.profileIterations??60)<0||(opts.profileIterations??60)>500)throw Error('BOUNDED_PROBE_REQUIRED');
 const report=await runComputeProbe(opts);if(out){const temp=path.resolve(sourceDirectory,'../../.test-temp')+path.sep;if(!out.startsWith(temp)||path.extname(out)!=='.json')throw Error('IGNORED_LOCAL_REPORT_REQUIRED');await writeFile(out,JSON.stringify(report,null,2)+'\n');}
 console.log(JSON.stringify(report,null,2));
}
