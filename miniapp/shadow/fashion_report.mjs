// Bounded public CDN reads only; no AI, credentials or production requests.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalSnapshot,applyCardMetadata} from './build_report.mjs';
import {fashionCategory,selectFashionCalibration} from './calibration.mjs';
import {compareSameCandidates} from './comparison.mjs';
import {budgetDiscovery} from './value.mjs';
import {createTasteState} from './taste.mjs';
import {safeImage} from '../cloudflare/domain.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),run=promisify(execFile);
const out=path.join(root,'docs/shadow-20261011');
function likelyFashion(p){return /футбол|блуз|рубаш|джинс|брюк|плать|юбк|худи|свит|куртк|кроссов|кед|туфл|ботин|сумк|ремн|кепк|украшен|серьг|кольц|браслет|колгот|нос[ко]|шарф|платок|пальто|толстов|топ /iu.test(p.name+' '+p.historicalTopic)&&!/шеврон|нашивк|вкладыш|автодок|ремкомплект|фильтр|учебник|книг|игрушк|кукол|для куклы/iu.test(p.name);}
function uniqueBalanced(rows){const groups=new Map(),seen=new Set();for(const p of rows){if(seen.has(p.id)||!likelyFashion(p))continue;seen.add(p.id);const key=p.query||p.historicalTopic;const list=groups.get(key)||[];list.push(p);groups.set(key,list);}const result=[];while([...groups.values()].some(g=>g.length))for(const g of groups.values())if(g.length)result.push(g.shift());return result;}
export async function publicGet(url,{image=false}={}){
  let stdout;
  try{({stdout}=await run('curl.exe',[url,'--ipv4','--silent','--max-time','12','--write-out','\n__PUBLIC__%{http_code}|%{content_type}'],{encoding:'buffer',maxBuffer:2200000,timeout:15000,windowsHide:true}));}
  catch{throw Error('PUBLIC_NETWORK_UNAVAILABLE');} // Do not burn the request bound on a network/permission failure.
  const marker=Buffer.from('\n__PUBLIC__'),at=stdout.lastIndexOf(marker);if(at<0)throw Error('PUBLIC_RESPONSE_UNKNOWN');
  const [status,contentType]=stdout.subarray(at+marker.length).toString().split('|'),bytes=stdout.subarray(0,at);
  if(status==='000')throw Error('PUBLIC_NETWORK_UNAVAILABLE');
  if(status==='403'||status==='429')return {blocked:Number(status)};
  if(status!=='200')return {invalid:Number(status)};
  if(image){if(!contentType?.startsWith('image/')||bytes.length<100||bytes.length>1000000||bytes.subarray(0,4).toString()!=='RIFF'||bytes.subarray(8,12).toString()!=='WEBP')return {invalid:'IMAGE_FORMAT'};return {bytes,hash:createHash('sha256').update(bytes).digest('hex')};}
  try{return {card:JSON.parse(bytes.toString('utf8'))};}catch{throw Error('PUBLIC_JSON_INVALID');}
}
export async function buildFashionReport(){
  const prior=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));
  const state=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'));
  const queue=JSON.parse(await fs.readFile(path.join(root,'queue.json'),'utf8'));
  const pool=[];let metadataRequests=0,imageRequests=0,blocked=null;
  const deadline=Date.now()+180000;
  // Reuse exact previously verified CDN metadata/photos; do not change their
  // verification timestamp into a fresh price/stock observation.
  for(const p of prior.products){if(!fashionCategory(p).allowed)continue;try{const bytes=await fs.readFile(path.join(out,p.localPhoto));if(createHash('sha256').update(bytes).digest('hex')!==p.imageHash)continue;pool.push({...p,fashionGroup:fashionCategory(p).group});}catch{}}
  const sourceRows=uniqueBalanced([...queue.map(p=>canonicalSnapshot(p,state)),...state.recent.map(p=>({...canonicalSnapshot(p,state),alreadyPublished:true}))]);
  for(const p of sourceRows){
    if(Date.now()>deadline||metadataRequests>=100||imageRequests>=60||blocked||selectFashionCalibration(pool,{target:40,min:30}).selectedIds.length>=40)break;
    if(pool.some(x=>x.id===p.id))continue;
    const image=safeImage(p.image);if(!image)continue; // No host guessing/endpoint hopping.
    const metadataUrl=image.replace('/images/big/1.webp','/info/ru/card.json');if(!metadataUrl.endsWith('/info/ru/card.json'))continue;
    metadataRequests++;let response;try{response=await publicGet(metadataUrl);}catch(e){blocked={error:e.message,phase:'metadata'};break;}
    if(response.blocked){blocked={http:response.blocked,phase:'metadata'};break;}if(!response.card)continue;
    let verified;try{verified=applyCardMetadata({...p,image},response.card);}catch{continue;}
    const classification=fashionCategory(verified);if(!classification.allowed)continue;
    imageRequests++;let photo;try{photo=await publicGet(image,{image:true});}catch(e){blocked={error:e.message,phase:'photo'};break;}
    if(photo.blocked){blocked={http:photo.blocked,phase:'photo'};break;}if(!photo.bytes)continue;
    await fs.writeFile(path.join(out,'photos',`${p.id}.webp`),photo.bytes);
    pool.push({...verified,fashionGroup:classification.group,imageHash:photo.hash,localPhoto:`photos/${p.id}.webp`,photoVerifiedAt:Date.now()});
  }
  const calibration=selectFashionCalibration(pool,{target:40,min:30}),products=calibration.products;
  const now=Date.now(),comparison=compareSameCandidates(products,{now,legacyCounter:Number(state.meta.total_posts||0)});
  const report={...prior,version:2,generatedAt:now,mode:'SHADOW_FASHION_OFFLINE',products,photos:products.map(p=>({id:p.id,sha256:p.imageHash,source:p.image})),fashionIds:products.map(p=>p.id),calibrationIds:products.map(p=>p.id),calibrationSummary:{total:products.length,target:40,min:30,shortfall:calibration.shortfall,byGroup:calibration.breakdown.byGroup,byCategory:calibration.breakdown.byCategory},calibrationNote:calibration.note||'Только подтверждённые категории одежды, обуви, сумок и аксессуаров.',comparison,budgets:budgetDiscovery(products,{now}),initialTaste:createTasteState(),audienceSignals:products.filter(p=>state.feedback[String(p.id)]).map(p=>{const f=state.feedback[String(p.id)];return {id:p.id,likes:f.likes||0,dislikes:f.dislikes||0,bought:f.bought||0};}),imageRequestsThisRun:imageRequests,metadataRequestsThisRun:metadataRequests,verifiedCategories:products.length,photoCollection:{checkedAt:now,metadataRequests,imageRequests,reused:products.filter(p=>prior.products.some(x=>x.id===p.id)).length,blocked,maxSeconds:180,maxMetadataRequests:100,maxImageRequests:60},notes:['Только подтверждённые WB-категории одежды, обуви, сумок, аксессуаров; случайные предметы исключены.','Фотографии реальные, идентификатор и категория подтверждены WB CDN. Цены/рейтинг исторические, наличие сегодня неизвестно.','Оба алгоритма сравниваются на одинаковых кандидатах; публикационная допускаемость отдельно от вкуса.','Старые личные оценки сохраняются в локальном файле; непрофильные оценки не обучают профиль стиля. Vision не подключён.']};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({photos:products.length,groups:report.calibrationSummary.byGroup,categories:report.calibrationSummary.byCategory,metadataRequests,imageRequests,blocked,shortfall:calibration.shortfall,extraAI:0,productionD1:0}));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildFashionReport();
