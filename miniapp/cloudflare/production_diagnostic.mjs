// Owner-authenticated, read-only production evidence, bounded independently of
// posting/search guards. No secrets, personal data, SQL or full history output.
import {observeD1} from './d1_budget.mjs';
import {postingWindow} from './native_scheduler.mjs';
export async function productionDiagnostic(env){
  const meter=observeD1(env.DB),q=(sql,...args)=>meter.DB.prepare(sql).bind(...args);
  const now=Math.floor(Date.now()/1000),day=new Date().toISOString().slice(0,10);
  const row=await q('SELECT data,revision,status,post_request,search_request FROM scheduler_config WHERE id=1').first();
  const schedule=JSON.parse(row.data),status=JSON.parse(row.status),window=postingWindow(schedule,now);
  const budget=(await q('SELECT day,lane,reads,writes FROM worker_read_budget WHERE day IN (?,?) LIMIT 6',day,new Date(Date.now()-86400000).toISOString().slice(0,10)).all()).results;
  const deliveries=(await q('SELECT pid,ts,message_id,topic FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time ORDER BY ts DESC LIMIT 5').all()).results;
  const leases=(await q('SELECT kind,expires FROM scheduler_leases LIMIT 2').all()).results;
  const claims=(await q("SELECT pid,ts,status,request_id FROM scheduler_claims INDEXED BY scheduler_claims_time ORDER BY ts DESC LIMIT 5").all()).results;
  const count=await q('SELECT ready FROM scheduler_counts WHERE id=1').first();
  const ready=(await q("SELECT pid,topic,retry_at,checked_at FROM scheduler_inventory WHERE state='ready' AND retry_at<=? AND expires>? ORDER BY queued_at,pid LIMIT 5",now,now).all()).results;
  const selected=Number(status.selected_product||0);
  const selected_state=await q('SELECT pid,state,retry_at,checked_at FROM scheduler_inventory WHERE pid=?',selected).first();
  return {now,day,runtime_version:env.CF_VERSION?.id||null,driver:env.SCHEDULER_DRIVER,
    schedule,revision:row.revision,status,posting_window:window,post_request:row.post_request,search_request:row.search_request,
    queue_size:count?.ready||0,ready_sample:ready,selected_state,deliveries,leases,
    active_leases:leases.filter(r=>r.expires>now),recent_claims:claims,budget,
    measured_d1:{...meter.metrics,top_queries:meter.topQueries()}};
}
