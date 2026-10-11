// Offline evidence builder: public product fields only. Optional bounded image
// GETs do NOT fetch prices, call AI, or touch production D1/Telegram/settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {choose} from '../cloudflare/native_scheduler.mjs';
import {safeImage} from '../cloudflare/domain.mjs';
import {compareShadow} from './ranking.mjs';
import {createTasteState,selectCalibrationProducts} from './taste.mjs';
import {budgetDiscovery} from './value.mjs';
const run=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
export function canonicalSnapshot(p,state){
  const id=Number(p.id||p.pid),saved=state.prices?.[String(id)]||{};
  return {id,name:String(p.title||''),price:Number(p.product||p.price),oldPrice:Number(p.seller_basic||p.basic||0),rating:Number(p.rating||0),reviews:Number.isSafeInteger(p.feedbacks)?p.feedbacks:null,brand:String(p.brand||''),category:'unknown',categoryVerified:false,historicalTopic:String(p.category||p.cat||p.query||'unknown'),type:'unknown',query:String(p.query||''),available:null,
    observedAt:Math.floor(Number(p.checked_at||p.queued_ts||p.ts||0)*1000),priceSource:'legacy_snapshot',currency:'RUB',variantKey:'unknown',context:null,image:safeImage(p.image),url:`https://www.wildberries.ru/catalog/${id}/detail.aspx`,
    history:(saved.samples||[]).slice(-28).reverse().map(([at,price])=>({at:at*1000,price,source:'legacy_observation',variantKey:'unknown',context:null})),
    queuedAt:Number(p.queued_ts||p.ts||0),metadataSource:'main/state.json (historical)',evidenceNote:'Цена/рейтинг из сохранённого снимка, не подтверждены сегодня; наличие, размер и условия оплаты неизвестны.'};
}
export function balancedSnapshot(rows,limit=50){
  const byCategory=new Map();
  for(const p of rows){if(!Number.isSafeInteger(p.id)||!p.name||p.price<=0)continue;const key=p.historicalTopic||p.category,list=byCategory.get(key)||[];list.push(p);byCategory.set(key,list);}
  for(const list of byCategory.values())list.sort((a,b)=>a.price-b.price||a.id-b.id);
  const result=[],seen=new Set();
  while(result.length<limit&&[...byCategory.values()].some(x=>x.length))for(const list of byCategory.values()){
    const p=list.shift();if(p&&!seen.has(p.id)){seen.add(p.id);result.push(p);}if(result.length===limit)break;
  }return result;
}
function photoHints(p,recent){
  const own=safeImage(p.image);if(own)return [own];
  const nearby=recent.filter(r=>safeImage(r.image)).sort((a,b)=>Math.abs(a.pid-p.id)-Math.abs(b.pid-p.id));
  const hosts=[...new Set(nearby.slice(0,12).map(r=>new URL(r.image).hostname))].slice(0,2);
  return hosts.map(host=>`https://${host}/vol${Math.floor(p.id/100000)}/part${Math.floor(p.id/1000)}/${p.id}/images/big/1.webp`);
}
async function getPhoto(url){
  // Only public exact WB CDN image URLs. No auth, no insecure TLS or retries.
  const {stdout}=await run('curl.exe',[url,'--ipv4','--silent','--fail','--max-time','12','--write-out','\n__PHOTO__%{http_code}|%{content_type}'],{encoding:'buffer',maxBuffer:1100000,timeout:15000,windowsHide:true});
  const marker=Buffer.from('\n__PHOTO__'),index=stdout.lastIndexOf(marker),tail=stdout.subarray(index+marker.length).toString();
  if(index<0||!/^200\|image\//.test(tail)||index<100||index>1000000)throw Error('PHOTO_NOT_VERIFIED');
  const image=stdout.subarray(0,index),riff=image.subarray(0,4).toString();
  if(riff!=='RIFF'||image.subarray(8,12).toString()!=='WEBP')throw Error('PHOTO_BAD_FORMAT');
  return {bytes:image,hash:createHash('sha256').update(image).digest('hex')};
}
export function applyCardMetadata(p,card,at=Date.now()){
  if(Number(card?.nm_id)!==p.id||typeof card.subj_name!=='string'||!card.subj_name.trim())throw Error('METADATA_IDENTITY_MISMATCH');
  return {...p,category:card.subj_name.trim().slice(0,100),categoryVerified:true,type:card.subj_name.trim().slice(0,100),name:typeof card.imt_name==='string'&&card.imt_name.trim()?card.imt_name.trim().slice(0,200):p.name,brand:typeof card.selling?.brand_name==='string'?card.selling.brand_name.slice(0,100):p.brand,metadataSource:new URL(p.image).origin+new URL(p.image).pathname.replace('/images/big/1.webp','/info/ru/card.json'),metadataVerifiedAt:at};
}
export async function buildReport({download=false,refreshMetadata=false,out=path.join(root,'docs/shadow-20261011')}={}){
  const state=JSON.parse(await fs.readFile(path.join(root,'state.json'),'utf8'));
  const queue=JSON.parse(await fs.readFile(path.join(root,'queue.json'),'utf8'));
  await fs.mkdir(path.join(out,'photos'),{recursive:true});
  let prior={};try{prior=JSON.parse(await fs.readFile(path.join(out,'report.json'),'utf8'));}catch{}
  const priorPhotos=new Map((prior.products||[]).map(p=>[p.id,p]));
  const candidates=balancedSnapshot(queue.map(p=>canonicalSnapshot(p,state)),50);
  const deadline=Date.now()+180000,products=[],photos=[];let requests=0;
  // Use recent real photographed products only if queue photo probes fail;
  // these remain labelled published/historical, not novel inventory.
  const reserve=balancedSnapshot(state.recent.map(p=>({...canonicalSnapshot(p,state),alreadyPublished:true})),50);
  for(const p of [...candidates,...reserve]){
    if(products.length>=48||Date.now()>deadline)break;
    if(products.some(x=>x.id===p.id))continue;
    const imagePath=path.join(out,'photos',`${p.id}.webp`);
    let verified=null;
    try{const bytes=await fs.readFile(imagePath),hash=createHash('sha256').update(bytes).digest('hex'),old=priorPhotos.get(p.id);if(old?.imageHash===hash&&safeImage(old.image)){verified={bytes,hash};p.image=old.image;p.photoVerifiedAt=old.photoVerifiedAt;}}catch{}
    if(!verified&&download)for(const url of photoHints(p,state.recent)){
      if(Date.now()>deadline||requests>=100)break;requests++;
      try{verified=await getPhoto(url);p.image=url;await fs.writeFile(imagePath,verified.bytes);break;}catch{}
    }
    if(!verified)continue;
    products.push({...p,imageHash:verified.hash,localPhoto:`photos/${p.id}.webp`,photoVerifiedAt:p.photoVerifiedAt||Date.now()});
    photos.push({id:p.id,sha256:verified.hash,source:p.image});
  }
  let metadataRequests=0;const metadataDeadline=Date.now()+180000;
  for(let start=0;start<products.length;start+=2){
    await Promise.all(products.slice(start,start+2).map(async(p,offset)=>{
      const old=priorPhotos.get(p.id);if(old?.categoryVerified&&old.imageHash===p.imageHash){products[start+offset]={...p,name:old.name,brand:old.brand,category:old.category,categoryVerified:true,type:old.type,metadataSource:old.metadataSource,metadataVerifiedAt:old.metadataVerifiedAt};return;}
      if(!refreshMetadata||Date.now()>metadataDeadline)return;
      const url=p.image.replace('/images/big/1.webp','/info/ru/card.json');if(!url.endsWith('/info/ru/card.json'))return;
      metadataRequests++;try{const {stdout}=await run('curl.exe',[url,'--ipv4','--silent','--fail','--max-time','10'],{encoding:'utf8',maxBuffer:2000000,timeout:12000,windowsHide:true});products[start+offset]=applyCardMetadata(p,JSON.parse(stdout));}catch{}
    }));
  }
  const now=Date.now(),rows=products.map(p=>({pid:p.id,topic:p.query||p.category,title_key:p.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),checked_at:Math.floor(p.observedAt/1000),data:JSON.stringify({id:p.id,title:p.name,image:p.image,category:p.category,query:p.query})}));
  const legacyPick=choose(rows,[],Number(state.meta.total_posts||0));
  const comparison=compareShadow(products,{now,legacyPick,seenIds:products.filter(p=>p.alreadyPublished).map(p=>p.id)});
  const calibration=selectCalibrationProducts(products,{size:24});
  const report={version:1,generatedAt:now,sourceCommit:'f28dd980f111a46bd973874038ad985e6602c8d8',mode:'SHADOW_OFFLINE',productionChanged:false,aiCalls:0,d1Calls:0,priceProbe:{date:'2026-10-11',at:null,source:'card.wb.ru/cards/v4/detail',http:403,attempts:1,note:'Точное время из текущего аудита не сохранялось. Без retries.'},imageRequestsThisRun:requests,metadataRequestsThisRun:metadataRequests,verifiedCategories:products.filter(p=>p.categoryVerified).length,
    latestHistoricalPriceAt:Math.max(...Object.values(state.prices).map(p=>p.ts||0))*1000,
    notes:['Реальные артикулы и HTTP-проверенные фотографии. Цены — исторический снимок, не сегодняшнее предложение.','Наличие и цена конкретного размера неизвестны; SHADOW не допускает эти карточки к публикации.','Legacy — воспроизводимый выбор на этом ограниченном снимке с пустым recent; не полный replay production D1.','Стиль не угадан, Visual AI не подключён. Личные оценки пока отсутствуют.'],
    products,photos,calibrationIds:calibration.products.map(p=>p.id),calibrationNote:calibration.note,comparison,budgets:budgetDiscovery(products,{now}),initialTaste:createTasteState(),audienceSignals:products.filter(p=>state.feedback[String(p.id)]).map(p=>{const f=state.feedback[String(p.id)];return {id:p.id,likes:f.likes||0,dislikes:f.dislikes||0,bought:f.bought||0};})};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({realPhotos:products.length,categories:new Set(products.map(p=>p.category)).size,calibration:report.calibrationIds.length,legacyPick:comparison.legacyPick,newEligible:comparison.selected.length,priceProbe:403,aiCalls:0,d1Calls:0,imageRequests:requests}));return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildReport({download:process.argv.includes('--download-photos'),refreshMetadata:process.argv.includes('--refresh-metadata')});
