// One-shot proposal from an actual read-only production snapshot. Never applies it.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {queryRules,validateQueries} from '../cloudflare/query_control.mjs';
import {selectionSettings,validateSelection} from '../cloudflare/selection_policy.mjs';
import {FASHION_BUDGETS,VERIFIED_VALUE_EXCEPTIONS} from '../cloudflare/fashion_policy.mjs';
export const PROPOSED_FASHION_QUERIES=Object.freeze([
 ['футболка мужская свободная',800],['топ женский',800],['футболка женская',800],
 ['лонгслив мужской',1500],['лонгслив женский',1500],['свитер женский свободный',1500],['свитер мужской',1500],
 ['джинсы мужские широкие',2500],['джинсы мужские прямые',2500],['джинсы женские широкие',2500],['джинсы женские прямые',2500],['брюки женские прямые',2500],
 ['худи мужское',2500],['худи женское свободное',2500],['бомбер мужской',4500],['бомбер женский',4500],['куртка мужская короткая',4500],['куртка женская',4500],
 ['кроссовки мужские',3500],['кроссовки женские',3500],['кеды женские',3500],['ботинки мужские',3500],['ботинки женские',3500],
 ['платье женское повседневное',2500],['юбка женская',1500],['рубашка мужская свободная',1500],['рубашка женская',1500],['кардиган женский',2500],
 ['сумка через плечо',1500],['ремень',1500],['серьги',1500]
]);
export function prepareFashionPolicy(snapshot){
 const policy=JSON.parse(snapshot.policy.data),old=queryRules(policy),keys=new Set(PROPOSED_FASHION_QUERIES.map(([s])=>s.toLowerCase()));
 const rules=validateQueries(PROPOSED_FASHION_QUERIES.map(([text,max_price])=>({text,max_price,priority:1,enabled:true,archived:false,origin:'manual'})),old);
 const archived=old.filter(r=>!keys.has(r.text.toLowerCase())).map(r=>({...r,archived:true,enabled:false}));
 const settings=validateSelection({...selectionSettings(policy),max_price:4500});
 return {generatedAt:new Date().toISOString(),sourceSnapshot:snapshot.at,sourcePolicyHash:snapshot.policyHash,applied:false,requiresOwnerReleaseApproval:true,
  preconditions:['Strict fashion publication gate and PR16 quote evidence must be ready first.','Do not apply the 4500 outer ceiling to the live Legacy sender.','Refresh the actual policy revision after each admin save.','Cron/schedule and marketplace integrations are separate releases.'],
  queries:{endpoint:'/api/admin/search/queries',method:'PUT',body:{revision:snapshot.policyHash,queries:[...rules,...archived]}},
  selection:{endpoint:'/api/admin/selection',method:'PUT',body:{revision:snapshot.policyHash,request_id:'fashion-policy-20261027-draft',confirmed:false,active:true,settings}},
  ordinaryCategoryBudgets:FASHION_BUDGETS,budgetFinds:{max_price:300,requiresSamePhotoQuality:true,forcedQuota:false},verifiedValueExceptions:VERIFIED_VALUE_EXCEPTIONS,
  counts:{beforeActive:old.filter(r=>!r.archived&&r.enabled).length,proposedActive:rules.length,archived:archived.length},productionWrites:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Use: node prepare_fashion_policy.mjs snapshot.json output.json');
 const proposal=prepareFashionPolicy(JSON.parse(await fs.readFile(input,'utf8')));await fs.writeFile(output,JSON.stringify(proposal,null,2));console.log(JSON.stringify({applied:false,...proposal.counts,productionWrites:0}));
}
