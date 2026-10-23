// Channel-only, bounded evidence. No personal profiles, AI or database calls.
import {productType,qualitySettings} from './audience_quality.mjs';
export const AUDIENCE_VERSION=1;
export const AUDIENCE_LIMITS=Object.freeze({window:500,maxTraits:64,minPeople:5,minProducts:4,minReferenceProducts:4,minVotes:12,minEachSide:2,minDifference:.1,maxAdjustment:.15,alpha:.05});
const parse=x=>{try{return typeof x==='string'?JSON.parse(x):x;}catch{return null;}};
const groups=new Set(['apparel','shoes','bag','accessory','home','beauty','electronics','other']);
export function audienceKeys(product,visualKeys=[],group=null,verified=false){
 const category=String(product.category||'').trim().toLowerCase(),known=(product.category_source==='wb-cdn'||product.categoryVerified===true)&&!['','другое','other','unknown'].includes(category);
 const keys=known?['type:'+productType(product)]:[];
 if(verified&&groups.has(group))for(const key of visualKeys.slice(0,18))if(/^visual\.[a-z_]+=[^\x00-\x1f]{1,80}$/.test(key)&&!/^visual\.(?:group|combo)=/.test(key))keys.push(group+'|'+key);
 return [...new Set(keys)];
}
export function signTest(wins,losses){
 const n=wins+losses;if(!n)return 1;let term=2**(-n),tail=term;
 for(let k=1;k<=Math.min(wins,losses);k++){term*=((n-k+1)/k);tail+=term;}
 return Math.min(1,2*tail);
}
export function wilson(wins,n){if(!n)return [0,1];const z=1.96,p=wins/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
export function buildAudienceEvidence(input){
 const unique=new Map(),ambiguous=new Set();let rejected=0;
 for(const r of input.slice(0,AUDIENCE_LIMITS.window)){
  if(r.scope!=='channel'||!Number.isSafeInteger(r.pid)||r.pid<=0||typeof r.voter!=='string'||!r.voter||!['l','d'].includes(r.sentiment)){rejected++;continue;}
  const p=parse(r.data);if(!p){rejected++;continue;}const key=r.voter+':'+r.pid,old=unique.get(key);
  if(old&&old.sentiment!==r.sentiment){ambiguous.add(key);continue;}
  unique.set(key,{...r,p,keys:audienceKeys(p,r.visual_keys||[],r.visual_group,r.visual_verified===true)});
 }
 for(const key of ambiguous)unique.delete(key);
 const rows=[...unique.values()],people=new Map(),keys=new Set();
 for(const r of rows){if(!people.has(r.voter))people.set(r.voter,[]);people.get(r.voter).push(r);for(const key of r.keys)keys.add(key);}
 const traits=[],frequency=new Map();for(const r of rows)for(const key of r.keys)frequency.set(key,(frequency.get(key)||0)+1);
 const tested=[...keys].sort((a,b)=>frequency.get(b)-frequency.get(a)||a.localeCompare(b)).slice(0,AUDIENCE_LIMITS.maxTraits);
 for(const key of tested){const affected=rows.filter(r=>r.keys.includes(key)),products=new Set(affected.map(r=>r.pid)),referenceProducts=new Set();let wins=0,losses=0,ties=0;const deltas=[];
  for(const votes of people.values()){
   const family=key.includes('|visual.')?key.split('=')[0]+'=':'type:';
   // Missing visual fields/unknown subjects are UNKNOWN, never evidence that
   // the subscriber dislikes an absent attribute or a different garment type.
   const comparable=r=>r.keys.some(k=>k.startsWith(family));
   const inside=votes.filter(r=>r.keys.includes(key)),outside=votes.filter(r=>comparable(r)&&!r.keys.includes(key));
   if(inside.length<AUDIENCE_LIMITS.minEachSide||outside.length<AUDIENCE_LIMITS.minEachSide)continue;
   for(const r of outside)referenceProducts.add(r.pid);
   const rate=xs=>xs.filter(r=>r.sentiment==='l').length/xs.length,delta=rate(inside)-rate(outside);deltas.push(delta);
   if(delta>=AUDIENCE_LIMITS.minDifference)wins++;else if(delta<=-AUDIENCE_LIMITS.minDifference)losses++;else ties++;
  }
  const n=wins+losses,majority=Math.max(wins,losses),interval=wilson(majority,n),adjustedP=Math.min(1,signTest(wins,losses)*keys.size);
  const supported=people.size>=AUDIENCE_LIMITS.minPeople&&n>=AUDIENCE_LIMITS.minPeople&&products.size>=AUDIENCE_LIMITS.minProducts&&referenceProducts.size>=AUDIENCE_LIMITS.minReferenceProducts&&affected.length>=AUDIENCE_LIMITS.minVotes&&adjustedP<=AUDIENCE_LIMITS.alpha&&interval[0]>.5;
  const delta=deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:0,direction=wins>losses?1:wins<losses?-1:0;
  const adjustment=supported?direction*Math.min(AUDIENCE_LIMITS.maxAdjustment,Math.abs(delta)*Math.max(0,2*interval[0]-1)):0;
  traits.push({key,products:products.size,votes:affected.length,pairedPeople:deltas.length,directionalPeople:n,wins,losses,ties,referenceProducts:referenceProducts.size,meanWithinPersonDifference:delta,adjustedP,interval,supported,adjustment,reason:!supported?'INSUFFICIENT_INDEPENDENT_CHANNEL_EVIDENCE':'WITHIN_PERSON_CONSENSUS_VS_OWN_BASELINE'});
 }
 return {version:AUDIENCE_VERSION,source:'channel_current_unique_votes',votes:rows.length,likes:rows.filter(r=>r.sentiment==='l').length,dislikes:rows.filter(r=>r.sentiment==='d').length,people:people.size,products:new Set(rows.map(r=>r.pid)).size,trainIds:[...new Set(rows.map(r=>r.pid))].sort((a,b)=>a-b),rejected,ambiguous:ambiguous.size,testedTraits:keys.size,traitsEvaluated:tested.length,traits,available:true};
}
export function audienceFactor(product,model,visualKeys=[],group=null,verified=false){
 const keys=new Set(audienceKeys(product,visualKeys,group,verified)),matched=(model?.traits||[]).filter(t=>t.supported&&keys.has(t.key));
 // Correlated visual fields share ONE bounded adjustment; never multiply them.
 const adjustment=matched.length?matched.reduce((n,x)=>n+x.adjustment,0)/matched.length:0;
 return {factor:1+Math.max(-AUDIENCE_LIMITS.maxAdjustment,Math.min(AUDIENCE_LIMITS.maxAdjustment,adjustment)),matched:matched.map(t=>({key:t.key,pairedPeople:t.pairedPeople,products:t.products,adjustedP:t.adjustedP,adjustment:t.adjustment}))};
}
export function audienceProposal(selector,rows,recent,total,policy,feedback){
 const legacy=selector(rows,recent,total,policy,feedback),model=feedback?.audience,settings=qualitySettings(policy);
 const unchanged=reason=>({version:AUDIENCE_VERSION,legacy_pid:legacy?.pid||null,proposed_pid:legacy?.pid||null,selected_pid:legacy?.pid||null,changed:false,reason,trainingVotes:model?.votes||0,trainingPeople:model?.people||0,matched:[],novel:legacy?!model?.trainIds?.includes(legacy.pid):false});
 if(!legacy||!settings.enabled||!settings.feedback_enabled||!model?.available)return unchanged('AUDIENCE_UNAVAILABLE_OR_DISABLED');
 const factors=new Map(rows.map(row=>{const p=JSON.parse(row.data),g=feedback.visualGroups?.get(row.pid);return [row.pid,audienceFactor(p,model,feedback.visual?.get(row.pid)||[],g,Boolean(g))];}));
 if(![...factors.values()].some(x=>Math.abs(x.factor-1)>1e-12))return unchanged('INSUFFICIENT_EVIDENCE_KEEP_LEGACY');
 // Preserve existing safety gates and avoid >configured consecutive types when
 // an alternative is genuinely eligible. This path runs only with evidence.
 const max=Math.max(2,Number(policy.selection?.max_consecutive||2)),last=recent.slice(-max).map(r=>productType(JSON.parse(r.data||'{}'))),same=last.length===max&&new Set(last).size===1;
 let pool=rows;if(same){const alternative=rows.filter(r=>productType(JSON.parse(r.data))!==last[0]);if(selector(alternative,recent,total,policy,feedback))pool=alternative;}
 const proposed=selector(pool,recent,total,policy,{...feedback,traits:new Map()},p=>factors.get(Number(p.id))?.factor||1)||legacy;
 return {...unchanged('CONSERVATIVE_CHANNEL_EVIDENCE'),proposed_pid:proposed.pid,changed:proposed.pid!==legacy.pid,novel:!model.trainIds.includes(proposed.pid),matched:factors.get(proposed.pid)?.matched||[],factor:factors.get(proposed.pid)?.factor||1};
}
export function audienceReceipt(proposal,model,rows,ts){
 const unseen=rows.filter(r=>!model.trainIds.includes(r.pid));
 return {version:AUDIENCE_VERSION,frozen_at:ts,source:model.source,training_votes:model.votes,training_people:model.people,training_products:model.products,legacy_pid:proposal.legacy_pid,proposed_pid:proposal.proposed_pid,selected_pid:proposal.legacy_pid,changed:proposal.changed,reason:proposal.reason,novel:proposal.novel,
  cohort_ids:[...new Set([proposal.legacy_pid,proposal.proposed_pid,...unseen.map(r=>r.pid)])].filter(id=>id&&!model.trainIds.includes(id)).slice(0,20),test_votes_used_for_training:0,matched:proposal.matched};
}
