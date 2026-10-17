// Offline counterfactual only. Both algorithms see precisely the same snapshot.
import {choose} from '../cloudflare/native_scheduler.mjs';
import {compareShadow} from './ranking.mjs';
import {trustedTraitsForProduct} from './taste_report.mjs';
export function compareSameCandidates(products,{now=Date.now(),profile=null,legacyCounter=0,traitsById={}}={}){
  const rows=products.map(p=>({pid:p.id,topic:p.query||p.category,title_key:String(p.name).toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),checked_at:Math.floor(p.observedAt/1000),data:JSON.stringify({id:p.id,title:p.name,image:p.image,category:p.category,query:p.query})}));
  const legacy=choose(rows,[],legacyCounter);
  const result=compareShadow(products,{now,profile,legacyPick:legacy,seenIds:[],recent:[],traitsForProduct:p=>trustedTraitsForProduct(p,traitsById)});
  // A photo-review order is NOT publication approval, a current bargain or AI
  // style inference. Eligibility is still separately visible on each item.
  const reviewOrder=[...result.assessments].filter(a=>!a.taste?.blocked&&!a.taste?.rejected).sort((a,b)=>b.reviewScore-a.reviewScore||a.id-b.id).map(a=>a.id);
  return {...result,candidateIds:products.map(p=>p.id),sameCandidateSet:true,legacyCounter,reviewOrder,reviewOnly:true,comparisonNote:'Одинаковые исторические кандидаты, одинаковое пустое окно recent. Это сравнение для оценки фото, не replay production и не A/B uplift. Порядок просмотра не разрешает публикацию без свежей цены/наличия.'};
}
