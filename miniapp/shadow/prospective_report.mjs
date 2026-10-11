// A separate, bounded photo-taste dataset. Never refreshes production or prices.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonicalSnapshot,applyCardMetadata} from './build_report.mjs';
import {publicGet} from './fashion_report.mjs';
import {fashionCategory,selectFashionCalibration} from './calibration.mjs';
import {similarity} from './ranking.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'docs/shadow-prospective-20261011');
const pause=()=>new Promise(resolve=>setTimeout(resolve,500));
export function previouslyRatedIds(input){
  if(!input||!Array.isArray(input.ratings))throw Error('PROSPECTIVE_TRAINING_INVALID');
  return new Set([...input.ratings,...(Array.isArray(input.archive)?input.archive:[])].map(v=>v.nmId).filter(id=>Number.isSafeInteger(id)&&id>0));
}
function balanced(rows){
  const buckets=new Map();
  for(const p of rows){const key=p.historicalTopic||p.query||'unknown',items=buckets.get(key)||[];items.push(p);buckets.set(key,items);}
  const result=[];while([...buckets.values()].some(x=>x.length))for(const list of buckets.values())if(list.length)result.push(list.shift());return result;
}
export async function buildProspectiveReport({download=false}={}){
  const training=JSON.parse(await fs.readFile(path.join(root,'.test-temp/value-taste/ratings.json'),'utf8'));
  const old=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-20261011/report.json'),'utf8'));
  const state=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'));
  const excluded=previouslyRatedIds(training),oldPhotos=new Set(old.products.map(p=>p.imageHash));
  let prior={};try{prior=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const pool=[];let metadataRequests=0,imageRequests=0,stop=null;
  for(const p of prior.products||[]){
    if(excluded.has(p.id)||oldPhotos.has(p.imageHash)||!fashionCategory(p).allowed)continue;
    try{const bytes=await fs.readFile(path.join(out,'photos',`${p.id}.webp`));if(createHash('sha256').update(bytes).digest('hex')===p.imageHash)pool.push(p);}catch{/* Never invent a replacement. */}
  }
  const seen=new Set(),rows=balanced(state.recent.map(p=>({...canonicalSnapshot(p,state),alreadyPublished:true})).filter(p=>{
    if(excluded.has(p.id)||seen.has(p.id)||!p.image)return false;seen.add(p.id);
    // A negative/prefilter only. Positive fashion identity still requires CDN category.
    return /футбол|блуз|рубаш|джинс|брюк|плать|юбк|худи|свит|куртк|кроссов|кед|туфл|ботин|сумк|ремн|кепк|серьг|кольц|браслет|колгот|носк|шарф|платок|пальто|толстов|топ /iu.test(p.name+' '+p.historicalTopic)&&!/шеврон|нашивк|вкладыш|автодок|ремкомплект|фильтр|учебник|книг|игрушк|кукол/iu.test(p.name);
  }));
  const deadline=Date.now()+180000;
  if(download)await fs.mkdir(path.join(out,'photos'),{recursive:true});
  for(const p of download?rows:[]){
    if(Date.now()>deadline||metadataRequests>=70||imageRequests>=40||pool.length>=40||stop)break;
    if(pool.some(x=>x.id===p.id))continue;
    const metadataUrl=p.image.replace('/images/big/1.webp','/info/ru/card.json');
    if(!metadataUrl.endsWith('/info/ru/card.json'))continue;
    metadataRequests++;await pause();let response;
    try{response=await publicGet(metadataUrl);}catch(e){stop={phase:'metadata',error:e.message};break;}
    if(response.blocked){stop={phase:'metadata',http:response.blocked};break;}if(!response.card)continue;
    let verified;try{verified=applyCardMetadata(p,response.card);}catch{continue;}
    const category=fashionCategory(verified);if(!category.allowed)continue;
    if(old.products.some(o=>similarity(o,verified)>=.8)||pool.some(o=>similarity(o,verified)>=.8))continue;
    imageRequests++;await pause();let photo;
    try{photo=await publicGet(p.image,{image:true});}catch(e){stop={phase:'photo',error:e.message};break;}
    if(photo.blocked){stop={phase:'photo',http:photo.blocked};break;}if(!photo.bytes)continue;
    if(oldPhotos.has(photo.hash)||pool.some(x=>x.imageHash===photo.hash))continue;
    await fs.writeFile(path.join(out,'photos',`${p.id}.webp`),photo.bytes);
    pool.push({...verified,fashionGroup:category.group,imageHash:photo.hash,localPhoto:`photos/${p.id}.webp`,photoVerifiedAt:Date.now()});
    console.log(JSON.stringify({SOURCE:'saved_real_channel_snapshot_and_public_CDN',PHOTO_VERIFIED:p.id,CATEGORY:verified.category,COUNT:pool.length}));
  }
  const selected=selectFashionCalibration(pool,{target:40,min:30,maxPerCategory:8});
  const products=selected.products;
  const report={version:1,mode:'SHADOW_PROSPECTIVE_PHOTO_ONLY',generatedAt:Date.now(),products,
    collection:{metadataRequests,imageRequests,stop,maxSeconds:180,maxMetadataRequests:70,maxImageRequests:40,parallelism:1,minimumPauseMs:500,reused:products.filter(p=>(prior.products||[]).some(x=>x.id===p.id)).length},
    selection:{target:40,total:products.length,shortfall:40-products.length,byGroup:selected.breakdown.byGroup,byCategory:selected.breakdown.byCategory},
    allPreviouslyRatedExcluded:true,excludedRatedCount:excluded.size,
    sourceNote:'Реальные товары из исторического снимка канала, но не из ваших оценок. Категория и фотографии проверены публичным WB CDN. Это не новый live-search и не подтверждение сегодняшней цены/наличия.',
    priceNote:'Цены и рейтинг исторические; число отзывов, сегодняшняя цена, наличие и размеры неизвестны. Фото-тест НЕ разрешает публикацию.',additionalAiCalls:0,productionWrites:0};
  await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({PROSPECTIVE_REAL_PHOTOS:products.length,SHORTFALL:report.selection.shortfall,GROUPS:report.selection.byGroup,METADATA_REQUESTS:metadataRequests,IMAGE_REQUESTS:imageRequests,STOP:stop,AI_CALLS:0,PRODUCTION_WRITES:0}));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildProspectiveReport({download:process.argv.includes('--download')});
