// Reproducible two-Worker LOCAL staging. All goods, source responses and Telegram
// receipts are synthetic. Actual external access is denied at workerd boundary.
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {bootstrap} from '../cloudflare/native_scheduler.mjs';
import {openPassivePriceStore} from './passive_store.mjs';
import {LOCAL_PASSIVE_DB} from './passive_worker.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),RUN='passive_stage_20_responses';
const sum=rows=>rows.reduce((a,m)=>({queries:a.queries+m.queries,rows_read:a.rows_read+m.rows_read,rows_written:a.rows_written+m.rows_written}),{queries:0,rows_read:0,rows_written:0});
async function bundle(file){const r=await build({entryPoints:[path.join(ROOT,file)],bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'});return r.outputFiles[0].text;}
export async function runPassiveStaging({reportPath=path.join(ROOT,'.test-temp/passive-staging-report.json')}={}){
 const started=Date.now(),[mainScript,collectorScript]=await Promise.all([bundle('miniapp/prices/passive_staging_runtime.mjs'),bundle('miniapp/prices/passive_worker_entry.mjs')]);
 let externalRequests=0;const deny=async()=>{externalRequests++;return new Response('EXTERNAL_ACCESS_FORBIDDEN',{status:403});};
 const common={compatibilityDate:'2026-09-01',modules:true,outboundService:deny};
 const flags={PRICE_OBSERVATION_RUN_ID:RUN,PRICE_OBSERVATION_STARTED_AT:String(started),PRICE_OBSERVATION_EXPIRES_AT:String(started+3600000)};
 const fixtureBindings={PRICE_LOCAL_STAGING:'1',SCHEDULER_DRIVER:'cloudflare-native',TG_BOT_TOKEN:'123:fixture-passive-price',MINIAPP_BOT_USERNAME:'fixture_bot',...flags};
 const mf=new Miniflare(convertV4MiniflareOptions({cf:false,log:new Log(LogLevel.NONE),workers:[
  {...common,name:'price-stage-off',script:mainScript,d1Databases:{DB:'local-native-price-off'},bindings:{...fixtureBindings,PRICE_OBSERVATION_ENABLED:'0'}},
  {...common,name:'price-stage-on',script:mainScript,d1Databases:{DB:'local-native-price-on'},bindings:{...fixtureBindings,PRICE_OBSERVATION_ENABLED:'1'},serviceBindings:{PRICE_OBSERVER:'price-private-collector'}},
  {...common,name:'price-private-collector',script:collectorScript,d1Databases:{PRICE_DB:LOCAL_PASSIVE_DB},bindings:{PRICE_CAPTURE_ENABLED:'1',PRICE_PASSIVE_ENABLED:'true',PRICE_ISOLATED:'true',PRICE_DATABASE_ID:LOCAL_PASSIVE_DB,PRICE_OBSERVATION_RUN_ID:RUN}}
 ]}));
 try{
  const binding=await mf.getD1Database('PRICE_DB','price-private-collector');
  const env={PRICE_ISOLATED:'true',PRICE_DATABASE_ID:LOCAL_PASSIVE_DB,PRICE_DB:binding,PRICE_PASSIVE_ENABLED:'true'};
  const meter=observeD1(binding),store=openPassivePriceStore({...env,PRICE_DB:meter.DB},{approvedDatabaseId:LOCAL_PASSIVE_DB});
  await store.init();const initialized={...meter.metrics};
  const runStart=await store.start({runId:RUN,now:Date.now(),expiresAt:started+3600000,reviewed:true});
  if(!runStart.started)throw Error('PASSIVE_STAGE_START_FAILED');
  const queue=Array.from({length:20},(_,i)=>({id:900000+i,title:'Fixture товар '+(900000+i),product:250,basic:250,rating:4.9,feedbacks:120,category:'Футболки',query:'футболка группа'+i%3,image:`https://basket-01.wbbasket.ru/vol0/part1/${900000+i}/images/big/1.webp`}));
  const runs={};
  for(const name of ['price-stage-off','price-stage-on']){
   const DB=await mf.getD1Database('DB',name);
   await DB.prepare("CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT,overrides TEXT DEFAULT '{}',checked_at INTEGER)").run();
   await bootstrap({DB,SCHEDULER_DRIVER:'cloudflare-native'},{queue,posts:[],policy:{chat_id:'-100123456789',queries:['футболка группа0','футболка группа1','футболка группа2'],max_price:1000,min_rating:4.3,min_feedbacks:20}});
   const schedule=JSON.parse((await DB.prepare('SELECT data FROM scheduler_config WHERE id=1').first()).data);
   Object.assign(schedule,{post_interval_minutes:30,search_enabled:false,paused:false,enabled:true,quiet_enabled:false,weekdays:[0,1,2,3,4,5,6]});
   await DB.prepare('UPDATE scheduler_config SET data=? WHERE id=1').bind(JSON.stringify(schedule)).run();
   const worker=await mf.getWorker(name),receipts=[];
   for(let n=0;n<20;n++){
    // Fixture-only advance of prior post ages, without changing the30min policy.
    await DB.prepare('UPDATE scheduler_posts SET ts=ts-3600').run();
    await DB.prepare('UPDATE scheduler_claims SET ts=ts-3600').run();
    const response=await worker.fetch('https://local-stage.invalid/replay',{method:'POST'}),r=await response.json();
    if(!response.ok||r.result?.results?.post?.result!=='success')throw Error('PASSIVE_STAGE_NATIVE_REPLAY_FAILED_'+n+'_'+JSON.stringify(r.result?.results));
    receipts.push(r);
   }
   const deliveries=(await DB.prepare("SELECT pid,json_extract(data,'$.product') price,json_extract(data,'$.variantKey') variantKey,json_extract(data,'$.priceObservedAt') priceObservedAt,json_extract(data,'$.priceStatus') priceStatus,json_extract(data,'$.fallback') fallback,json_extract(data,'$.retailConfirmed') retailConfirmed FROM scheduler_deliveries ORDER BY pid").all()).results;
   const unchanged=JSON.parse((await DB.prepare('SELECT data FROM scheduler_config WHERE id=1').first()).data).post_interval_minutes===30;
   runs[name]={receipts,deliveries,schedule30Unchanged:unchanged,mainD1:sum(receipts.map(r=>r.mainD1)),maxMainSQL:Math.max(...receipts.map(r=>r.mainD1.queries)),sourceCounts:receipts.reduce((a,r)=>{for(const[k,v]of Object.entries(r.counts))a[k]=(a[k]||0)+v;return a;},{})};
  }
  const exported=await store.exportSafe({runId:RUN,now:Date.now()});
  const collectorCosts=runs['price-stage-on'].receipts.flatMap(r=>r.collector).map(r=>r.d1).filter(Boolean);
  const on=runs['price-stage-on'],off=runs['price-stage-off'];
  const comparisons=on.deliveries.map(d=>{const offer=exported.events.flatMap(e=>e.offers).find(p=>p.id===d.pid);return {id:d.pid,publishedQuote:d.price,observedQuote:offer?.price??null,skuMatches:offer?.variantKey===d.variantKey,kopecksMatch:offer?.price===d.price,available:offer?.available===true,retailConfirmed:false};});
  const report={scope:'LOCAL_TWO_WORKER_MINIFLARE_STAGING',syntheticData:true,productionChanged:false,externalRequests,realTelegramPosts:0,workersAiCalls:0,realProductsValidated:0,
   initD1:initialized,start:runStart,off:{...off,receipts:undefined,deliveries:undefined},on:{...on,receipts:undefined,deliveries:undefined},
   sameSourceCounts:JSON.stringify(on.sourceCounts)===JSON.stringify(off.sourceCounts),sameMainSQL:on.mainD1.queries===off.mainD1.queries,collectorD1:sum(collectorCosts),maxCollectorSQL:Math.max(0,...collectorCosts.map(c=>c.queries)),
   maxCombinedSQL:Math.max(...on.receipts.map(r=>r.mainD1.queries+r.collector.reduce((n,c)=>n+(c.d1?.queries||0),0))),
   observed:exported,comparisons,workerRequests:40,serviceCalls:collectorCosts.length,freeAccountUsageVerified:false,remoteLimitsEnforced:false,wallMs:Date.now()-started};
  if(reportPath){await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2));}
  return report;
 }finally{await mf.dispose();}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){const r=await runPassiveStaging();console.log(JSON.stringify({scope:r.scope,sameSourceCounts:r.sameSourceCounts,sameMainSQL:r.sameMainSQL,responses:r.observed.responseCount,distinctIds:r.observed.distinctIds,collectorD1:r.collectorD1,maxMainSQL:r.on.maxMainSQL,maxCombinedSQL:r.maxCombinedSQL,externalRequests:r.externalRequests}));}
