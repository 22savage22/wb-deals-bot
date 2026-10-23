// Editorial fashion baseline, not learned taste. No title-derived positive style.
import {FASHION_CATEGORIES} from '../shadow/calibration.mjs';
import {selectionReason,similarity} from './selection_policy.mjs';
import {ownerReason,productType} from './audience_quality.mjs';
import {safeImage} from './domain.mjs';
import {VISUAL_VERSION,COMMON,SPECIFIC} from './visual_features.mjs';
export const FASHION_VERSION=1;
export const FASHION_TARGETS=Object.freeze({men:14,women:14,shoes:8,accessories:4});
const fold=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').trim();
const excluded=new Set(['Гольфы','Носки','Колготки','Трусы','Бюстгальтеры','Комплекты белья','Пижамы','Халаты','Ночные сорочки','Купальники','Плавки','Тапочки','Сланцы','Шлепанцы'].map(fold));
const categories=new Map(Object.entries(FASHION_CATEGORIES).flatMap(([group,list])=>list.filter(c=>!excluded.has(fold(c))).map(c=>[fold(c),group])));
for(const c of ['Бомберы','Комплекты украшений','Подвески бижутерные'])categories.set(fold(c),c==='Бомберы'?'clothing':'accessories');
const parse=s=>{try{return typeof s==='string'?JSON.parse(s):s;}catch{return null;}};
const childOrUtility=/(?:детск|девоч|мальчик|малыш|новорожден|для кукол|для куклы|спецодеж|медицинск|карнавальн|костюмирован|униформа)/u;
const token=s=>fold(s).split(/[;,/]/u).map(fold);
export function fashionMetadata(card,p,ts){
 if(Number(card?.nm_id)!==Number(p.id))return null;
 const wanted=new Set(['пол','покрой','модель джинсов','назначение','назначение обуви','возрастная группа']);
 const options={};for(const o of (Array.isArray(card.options)?card.options:[]).slice(0,120))if(o&&wanted.has(fold(o.name))&&typeof o.value==='string')options[fold(o.name)]=o.value.slice(0,200);
 const genders=token(options['пол']||'');
 const men=genders.includes('мужской'),women=genders.includes('женский'),unisex=genders.includes('унисекс')||men&&women;
 return {version:1,source:'wb-cdn',pid:p.id,image:p.image,checked_at:ts,audience:unisex?'unisex':men?'men':women?'women':'unknown',options};
}
function metadata(p){const m=p.fashion_metadata;return m?.version===1&&m.source==='wb-cdn'&&m.pid===p.id&&m.image===p.image?m:null;}
function visualFields(p,profile,group){
 // The caller supplies ONLY cachedProfiles(), which already checks image/model.
 const expected={clothing:'apparel',shoes:'shoes',bags:'bag',accessories:'accessory'}[group];
 if(!profile||profile.version!==VISUAL_VERSION||profile.group!==expected)return {};
 const allowed={...COMMON,...SPECIFIC[expected]},fields={};
 for(const [k,v] of Object.entries(profile.fields||{}))if(allowed[k]?.includes(v?.value)&&v.confidence>=.8&&typeof v.evidence==='string'&&v.evidence.length>=5&&(k!=='style'||v.hypothesis===false))fields[k]=v.value;
 return fields;
}
export function assessFashion(p,policy={},profile=null){
 const blocked=ownerReason(p,policy)||selectionReason(p,policy);if(blocked)return {allowed:false,reason:blocked};
 if(p.category_source!=='wb-cdn')return {allowed:false,reason:'CATEGORY_UNCONFIRMED'};
 const group=categories.get(fold(p.category));if(!group)return {allowed:false,reason:'OUTSIDE_FASHION'};
 const m=metadata(p),text=[p.category,p.category_root,p.title,...Object.values(m?.options||{})].join(' ');
 if(childOrUtility.test(fold(text)))return {allowed:false,reason:'CHILD_OR_UTILITY'};
 if(!safeImage(p.image))return {allowed:false,reason:'PHOTO_UNAVAILABLE'};
 let bucket=group==='shoes'?'shoes':group==='clothing'?m?.audience:'accessories';
 if(group==='clothing'&&!['men','women','unisex'].includes(bucket))return {allowed:false,reason:'APPAREL_AUDIENCE_UNCONFIRMED'};
 const v=visualFields(p,profile,group),reasons=[],unknown=[];
 const declaredCut=fold(m?.options['покрой']||'');
 // Conflicting checked evidence is a hold, never a positive keyword vote.
 if(/оверсайз|oversiz/u.test(declaredCut)&&v.fit&&v.fit!=='oversize')return {allowed:false,reason:'CUT_PHOTO_CONFLICT'};
 let score=1;
 const add=(match,points,why)=>{if(match){score+=points;reasons.push(why);}};
 add(group==='clothing'&&v.fit==='oversize',.14,'PHOTO_OVERSIZE');
 add(group==='clothing'&&['loose','straight'].includes(v.silhouette),.08,'PHOTO_LOOSE_OR_STRAIGHT');
 add(['streetwear','casual'].includes(v.style),.08,'REVIEWED_PHOTO_STYLE');
 add(v.pattern==='graphic',.06,'PHOTO_GRAPHIC_PRINT');
 add(group==='clothing'&&bucket==='women'&&v.silhouette==='fitted',.06,'PHOTO_FITTED_SILHOUETTE');
 add(group==='shoes'&&v.shape==='chunky',.06,'PHOTO_CHUNKY_SHAPE');
 add(group==='bags'&&['structured','soft'].includes(v.shape),.04,'PHOTO_BAG_SHAPE');
 // Explicit editorial directions use official categories, not marketing titles.
 add(['худи','толстовки','бомберы'].includes(fold(p.category)),.04,'EDITORIAL_HOODIE_OR_BOMBER_CATEGORY');
 const jeans=fold(m?.options['модель джинсов']||'');
 add(fold(p.category)==='джинсы'&&/широк|прям|wide|straight/u.test(jeans),.04,'WB_DECLARED_WIDE_OR_STRAIGHT_JEANS');
 if(!Object.keys(v).length)unknown.push('NO_VERIFIED_VISUAL_FEATURES');
 // Seller specs are shown as claims; they do not prove visible modern styling.
 return {allowed:true,reason:reasons.length?'VERIFIED_FASHION_FEATURES':'CONFIRMED_FASHION_BASE_STYLE_UNKNOWN',group,bucket,type:productType(p),score,reasons,unknown,declaredCut:declaredCut||null,visual:v,priceClaim:'SNAPSHOT_NOT_A_VERIFIED_DISCOUNT'};
}
export function chooseFashion(rows,recent,policy={},context={},pilotHistory=[]){
 const history=pilotHistory.slice(0,40).map(r=>({row:r,p:parse(r.data)})).filter(x=>x.p);
 const counts=Object.fromEntries(Object.keys(FASHION_TARGETS).map(k=>[k,0]));let unassigned=0;
 for(const {row,p} of history){const a=assessFashion(p,{},null);let bucket=row.fashion_bucket||a.bucket;
  if(bucket==='unisex')bucket=['men','women'].sort((x,y)=>(FASHION_TARGETS[y]-counts[y])-(FASHION_TARGETS[x]-counts[x]))[0];
  if(Object.hasOwn(counts,bucket))counts[bucket]++;else unassigned++;}
 const result={version:FASHION_VERSION,selected_pid:null,proposed_pid:null,counts,targets:FASHION_TARGETS,historyCount:history.length,unassigned,reason:'NO_SUITABLE_FASHION',candidates:[]};
 if(history.length>=40)return {...result,reason:'PILOT_COMPLETE_REVIEW_REQUIRED'};
 // The pilot starts at an explicit approved timestamp, never from all Legacy posts.
 const types=recent.slice(-2).map(r=>productType(parse(r.data)||{})),last=types.length===2&&types[0]===types[1]?types[0]:null;
 const topicCounts=new Map();for(const r of recent)topicCounts.set(r.topic,(topicCounts.get(r.topic)||0)+1);
 for(const row of rows.slice(0,300)){
  const p=parse(row.data);if(!p)continue;
  const a=assessFashion(p,policy,context.profiles?.get(row.pid));let reason=a.reason;
  if(a.allowed&&((topicCounts.get(row.topic)||0)>=8||recent.some(r=>r.title_key===row.title_key)))reason='EXISTING_TOPIC_OR_TITLE_CAP';
  else if(a.allowed&&a.type===last)reason='TYPE_STREAK_LIMIT';
  else if(a.allowed&&recent.slice(-6).some(r=>similarity(parse(r.data)||{},p).score>=.8))reason='SIMILAR_RECENT_ITEM';
  else if(a.allowed){
   let bucket=a.bucket;if(bucket==='unisex')bucket=['men','women'].filter(k=>counts[k]<FASHION_TARGETS[k]).sort((x,y)=>(FASHION_TARGETS[y]/40*(history.length+1)-counts[y])-(FASHION_TARGETS[x]/40*(history.length+1)-counts[x]))[0];
   if(!bucket||counts[bucket]>=FASHION_TARGETS[bucket])reason='PILOT_BUCKET_FULL';
   else{const votes=context.items?.get(Number(p.id)),n=(votes?.likes||0)+(votes?.dislikes||0),itemAdjustment=n?Math.max(-.025,Math.min(.025,((votes.likes||0)-(votes.dislikes||0))/(n+4)*.05)):0;
    result.candidates.push({row,pid:row.pid,bucket,assessment:a,score:a.score+itemAdjustment,itemAdjustment,deficit:FASHION_TARGETS[bucket]/40*(history.length+1)-counts[bucket]});continue;}
  }
  result.candidates.push({pid:row.pid,rejected:true,reason,assessment:a});
 }
 const eligible=result.candidates.filter(x=>!x.rejected).sort((a,b)=>b.deficit-a.deficit||b.score-a.score||a.row.queued_at-b.row.queued_at||a.pid-b.pid);
 const best=eligible[0];return {...result,proposed_pid:best?.pid||null,bucket:best?.bucket||null,reason:best?'FASHION_BASELINE_WITH_PILOT_DEFICIT':result.reason,assessment:best?.assessment||null};
}
export async function fashionShadow(e,rows,recent,policy,context,ts){
 const start=Number(e.FASHION_PILOT_START||0);
 if(e.FASHION_SHADOW_ENABLED!=='1'||!Number.isSafeInteger(start)||start<=0||start>ts)return null;
 const history=(await e.DB.prepare('SELECT pid,ts,data FROM scheduler_deliveries WHERE ts>=? ORDER BY ts ASC LIMIT 40').bind(start).all()).results;
 const r=chooseFashion(rows,recent,policy,context,history);
 return {version:r.version,frozen_at:ts,pilot_start:start,legacy_pid:null,proposed_pid:r.proposed_pid,bucket:r.bucket||null,counts:r.counts,unassigned:r.unassigned,reason:r.reason,assessment:r.assessment,targets:FASHION_TARGETS,unknown_visual:r.candidates.filter(x=>x.assessment?.unknown?.length).length,eligible:r.candidates.filter(x=>!x.rejected).length,rejected:r.candidates.filter(x=>x.rejected).map(x=>({pid:x.pid,reason:x.reason})),price_claim:'NO_VERIFIED_DISCOUNT',actual_selection:'LEGACY'};
}
