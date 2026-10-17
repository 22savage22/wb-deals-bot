// Opt-in bounded operator probe. No root Worker import, no production DB writes,
// no Telegram/AI. Public WB calls require an explicit --live CLI switch.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createWBPriceSource} from './source.mjs';
import {openLocalPrices} from './local_db.mjs';
import {openPriceStore} from './store.mjs';
import {analysePricePool,planBudgetSearch,pricePolicy} from './analysis.mjs';
import {ownerReason,productType} from '../cloudflare/audience_quality.mjs';
import {cardDeal} from '../cloudflare/native_scheduler.mjs';
export const LOCAL_PRICE_DB='local-prices-20261018';
export function selectRealSample(products){
  const pool=products.filter(p=>Number.isSafeInteger(p.id)&&p.id>0&&p.image&&!ownerReason({...p,title:p.title||p.name},pricePolicy()));
  const types=['tshirt','hoodie','jeans','trousers','shoes','bag','accessory','dress','blouse','longsleeve','knitwear','outerwear','skirt'],groups=new Map(types.map(t=>[t,pool.filter(p=>productType(p)===t).sort((a,b)=>(a.price||a.product||Infinity)-(b.price||b.product||Infinity))]));
  const chosen=[],seen=new Set();for(let round=0;round<20&&chosen.length<20;round++)for(const t of types){const p=groups.get(t)[round];if(p&&!seen.has(p.id)){seen.add(p.id);chosen.push(p);if(chosen.length===20)break;}}return chosen;
}
export async function runRealPriceProbe({store,sample,source=createWBPriceSource(),now=Date.now}={}){
  if(!Array.isArray(sample)||sample.length!==20||new Set(sample.map(p=>p.id)).size!==20)throw Error('TWENTY_DISTINCT_REAL_PRODUCTS_REQUIRED');
  const started=now(),receipts=[],metadata=[],skipped=[],network={attempted:0,reserved:0},snapshots=new Map(sample.map(p=>[p.id,p.product||p.price||null]));
  await store.track(sample.map(p=>({...p,source:'wb-card',name:p.name||p.title})),{now:started});
  let oldSearch=null,newSearch=null,searchError=null;
  const searchLease=await store.acquire('wb-search',{now:now(),requestCost:1});
  if(searchLease.admitted){network.reserved++;try{network.attempted++;const result=await source.search(planBudgetSearch(0));receipts.push({kind:'search',...result.receipt});const raw=result.products;
      oldSearch={tested:true,requirements:{query:planBudgetSearch(0).query,maxPrice:100,minRating:4.3,minReviews:20},raw:raw.length,legacyPassed:raw.filter(c=>cardDeal(c,{max_price:100,min_rating:4.3,min_feedbacks:20})).length};newSearch={tested:true,discovered:raw.length,priceVerified:0,note:'Поисковая выдача требует отдельной проверки вариантов/наличия/условий.'};
      await store.finish('wb-search',searchLease.owner,{now:now(),ok:true,status:200});
    }catch(e){searchError={code:e.code||'SOURCE_UNAVAILABLE',status:e.status||0};receipts.push({kind:'search',...e.receipt,...searchError});await store.finish('wb-search',searchLease.owner,{now:now(),status:e.status||0,retryAfterMs:e.retryAfterMs||0});}}
  else skipped.push({source:'wb-search',...searchLease});
  const cardLease=await store.acquire('wb-card',{now:now(),requestCost:1});let detailResult=null;
  if(cardLease.admitted){network.reserved++;try{network.attempted++;detailResult=await source.details(sample.map(p=>p.id));receipts.push({kind:'details',...detailResult.receipt});
      const quotes=detailResult.products.map(p=>({...sample.find(x=>x.id===p.id),...p,image:sample.find(x=>x.id===p.id).image}));await store.ingest([...quotes,...detailResult.missing.map(m=>({...sample.find(p=>p.id===m.id),name:sample.find(p=>p.id===m.id).name||sample.find(p=>p.id===m.id).title,source:'wb-card',price:null,available:null,priceContextConfirmed:false}))],{now:now()});
      await store.finish('wb-card',cardLease.owner,{now:now(),ok:true,status:200});
    }catch(e){receipts.push({kind:'details',...e.receipt,code:e.code||'SOURCE_UNAVAILABLE',status:e.status||0});await store.finish('wb-card',cardLease.owner,{now:now(),status:e.status||0,retryAfterMs:e.retryAfterMs||0});}}
  else skipped.push({source:'wb-card',...cardLease});
  const metaLease=await store.acquire('wb-metadata',{now:now(),requestCost:20});
  if(metaLease.admitted){network.reserved+=20;let failed=null;
    for(const p of sample){try{network.attempted++;const r=await source.metadata({...p,name:p.name||p.title});receipts.push({kind:'metadata',id:p.id,...r.receipt});metadata.push({...r.product,source:'wb-card'});}catch(e){receipts.push({kind:'metadata',id:p.id,...e.receipt,status:e.status||0,code:e.code||'SOURCE_UNAVAILABLE'});failed=e;if(e.status!==404)break;}}
    if(metadata.length)await store.track(metadata,{now:now()});
    await store.finish('wb-metadata',metaLease.owner,{now:now(),ok:!failed,status:failed?failed.status||0:200,retryAfterMs:failed?.retryAfterMs||0});
  }else skipped.push({source:'wb-metadata',...metaLease});
  if(detailResult?.products.length&&metadata.length){const fields=['name','category','category_root','category_source','categoryVerified','categoryObservedAt','audience','audienceVerified','audienceSource','audienceObservedAt'];const quotes=detailResult.products.map(p=>{const m=metadata.find(x=>x.id===p.id);return {...p,image:sample.find(x=>x.id===p.id).image,...(m?Object.fromEntries(fields.map(k=>[k,m[k]])):{} )};});await store.ingest(quotes,{now:now()});}
  const sampleIds=new Set(sample.map(p=>p.id)),records=(await store.list({now:now()})).filter(r=>sampleIds.has(r.id));for(const r of records){r.metadata={...r.metadata,snapshotPrice:snapshots.get(r.id)||null};const quote=detailResult?.products.find(p=>p.id===r.id);if(quote)r.product={...r.product,observedQuote:quote.observedQuote};if(r.confirmed){r.product.history=await store.history(r.product,{now:now()});}}
  const result=analysePricePool(records,{now:now()}),ended=now();
  return {version:1,test:'TWENTY_REAL_IDS_ISOLATED',startedAt:new Date(started).toISOString(),finishedAt:new Date(ended).toISOString(),sourceContext:source.context,
    ...result,metadataConfirmed:metadata.length,network,receipts,skipped,comparison:{sameRequirements:true,sharedSourceReceipt:true,payloadAvailable:!searchError&&oldSearch!==null,oldSearch,newSearch,error:searchError,conclusion:searchError?'Живое сравнение поиска не выполнено: источник отказал обоим алгоритмам. Результаты старого снимка не считаются свежими.':'Сравнивались одни требования и один ответ; число найденных не доказывает выгодность.'},
    productionChanged:false,aiCalls:0,telegramPosts:0,realPriceHistoryDays:new Set(records.flatMap(r=>(r.product?.history||[]).map(h=>new Date(h.at).toISOString().slice(0,10)))).size,priceHistoryNote:'История начнётся только после настоящих подтверждённых наблюдений. Fixture-история сюда не импортируется.'};
}
export async function main(){
  if(!process.argv.includes('--live'))throw Error('Explicit --live required; no automatic network probe');
  await mkdir('.test-temp',{recursive:true});const snapshot=JSON.parse(await readFile('.test-temp/production-catalog.json','utf8')),sample=selectRealSample(snapshot.data.products);
  const local=openLocalPrices('.test-temp/price-staging.sqlite');try{const store=openPriceStore({PRICE_ISOLATED:'true',PRICE_DATABASE_ID:LOCAL_PRICE_DB,PRICE_DB:local.DB},{approvedDatabaseId:LOCAL_PRICE_DB});await store.init();
    const report=await runRealPriceProbe({store,sample});await writeFile('.test-temp/real-price-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({report:'.test-temp/real-price-report.json',sample:sample.length,confirmed:report.confirmed,unconfirmed:report.unconfirmed,metadataConfirmed:report.metadataConfirmed,requests:report.network,superfind:report.superfindState,sqlStatements:local.queries,d1Rows:'NOT_MEASURED_BY_LOCAL_ADAPTER',productionChanged:false}));
  }finally{local.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
