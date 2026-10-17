import {ownerReason} from './audience_quality.mjs';
// Reversible quarantine, never DELETE history or an entire queue. Called only
// by the existing 5-minute maintenance, and only after explicit policy saving.
export async function reconcileOwnerInventory(e,policy,now){
 if(!policy.audience_quality)return;
 const records=[];
 try{for(const state of ['ready','cooldown','owner_excluded']){
  const rows=(await e.DB.prepare('SELECT pid,data,state,expires FROM scheduler_inventory INDEXED BY scheduler_inventory_quality WHERE state=? ORDER BY queued_at,pid LIMIT 300').bind(state).all()).results;
  for(const row of rows){let p;try{p=JSON.parse(row.data);}catch{continue;}
   const reason=ownerReason(p,policy);
   if(reason&&state!=='owner_excluded')records.push({pid:row.pid,old:state,state:'owner_excluded',before:row.data,data:JSON.stringify({...p,owner_exclusion:reason,owner_previous_state:state})});
   if(!reason&&state==='owner_excluded'&&row.expires>now){const next=['ready','cooldown'].includes(p.owner_previous_state)?p.owner_previous_state:'ready';delete p.owner_exclusion;delete p.owner_previous_state;records.push({pid:row.pid,old:state,state:next,before:row.data,data:JSON.stringify(p)});}
  }
 }}catch(error){if(/no such index/i.test(String(error.message))){console.log('OWNER_QUARANTINE index missing; hard publication gates retained');return {available:false};}throw error;}
 if(records.length)await e.DB.prepare(`UPDATE scheduler_inventory SET
  state=json_extract(patch.value,'$.state'),data=json_extract(patch.value,'$.data')
  FROM json_each(?) AS patch WHERE scheduler_inventory.pid=json_extract(patch.value,'$.pid')
  AND scheduler_inventory.state=json_extract(patch.value,'$.old') AND scheduler_inventory.data=json_extract(patch.value,'$.before')`)
  .bind(JSON.stringify(records)).run();
 return {changed:records.length};
}
