// Cloudflare owns the clock; established Python jobs still own catalogue/posting.
// This is a dispatch adapter, not another queue or an alternative posting engine.
import {ensureScheduler,validateSchedule} from './scheduler_api.mjs';
const active=new Set(['queued','in_progress','waiting','requested','pending']);
const workflows={post:'post-once.yml',search:'scanner.yml'};
const formatters=new Map();
function local(now,zone){
  if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
  const p=Object.fromEntries(formatters.get(zone).formatToParts(new Date(now*1000)).map(x=>[x.type,x.value]));
  return {weekday:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday),clock:p.hour+':'+p.minute};
}
export function dueJobs(row,now){
  const s=validateSchedule(JSON.parse(row.data)),status=JSON.parse(row.status||'{}');
  const result=[],manualPost=Boolean(row.post_request),manualSearch=Boolean(row.search_request);
  const lastScan=Number(status.last_scan_attempt||status.last_scan_success||0);
  const searchInterval=Number(status.queue_size||0)<s.min_queue?300:s.search_interval_minutes*60;
  if((manualSearch||s.search_enabled&&now>=lastScan+searchInterval)&&!status.scan_running)result.push('search');
  const lastPost=Number(status.last_post||0),wall=local(now,s.timezone);
  const quiet=s.quiet_enabled&&(s.quiet_start<s.quiet_end?s.quiet_start<=wall.clock&&wall.clock<s.quiet_end:wall.clock>=s.quiet_start||wall.clock<s.quiet_end);
  const allowed=s.enabled&&!s.paused&&s.weekdays.includes(wall.weekday)&&!quiet;
  const fresh=now-Number(status.heartbeat||0)<180;
  const caps=fresh&&(Number(status.posts_hour||0)>=s.max_posts_hour||Number(status.posted_today||0)>=s.max_posts_day);
  const gap=now>=lastPost+s.min_post_gap_minutes*60;
  // Python's verified, timezone/DST-aware engine provides the exact next slot.
  // After a settings edit or first boot, dispatch conservatively; the job rereads
  // D1 and enforces the full engine, claims, caps and quiet hours before sending.
  const sameRevision=Number(status.revision)===Number(row.revision)&&!status.next_slot_stale;
  const next=Number(status.next_post||0);
  const automatic=sameRevision&&next>0?now>=next:s.mode==='times'?s.post_times.includes(wall.clock):now>=lastPost+Math.max(s.min_post_gap_minutes*60,(s.post_interval_minutes-(s.natural_interval_enabled?s.jitter_minutes:0))*60);
  if(gap&&!caps&&!status.post_running&&(manualPost||allowed&&automatic)&&(manualPost||Number(status.queue_size||0)>0))result.push('post');
  return result;
}
async function github(env,path,body,fetcher){
  const response=await fetcher('https://api.github.com/repos/22savage22/wb-deals-bot'+path,{
    method:body?'POST':'GET',headers:{Authorization:'Bearer '+env.GITHUB_DISPATCH_TOKEN,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'WB-Cloudflare-clock','X-GitHub-Api-Version':'2022-11-28'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new Error('GitHub HTTP '+response.status);
  return body?{}:response.json();
}
export async function scheduledTick(env,scheduledTime=Date.now(),fetcher=fetch){
  // No Cloudflare deployment credential is read or needed at runtime.
  if(env.SCHEDULER_DRIVER!=='cloudflare')return {enabled:false};
  await ensureScheduler(env);
  const q=(sql,...args)=>env.DB.prepare(sql).bind(...args),now=Math.floor(scheduledTime/1000);
  await q("UPDATE scheduler_config SET status=json_set(status,'$.clock_heartbeat',?,'$.clock_driver','cloudflare') WHERE id=1",now).run();
  if(!env.GITHUB_DISPATCH_TOKEN){
    await q("UPDATE scheduler_config SET status=json_set(status,'$.clock_error','Missing GitHub dispatch secret') WHERE id=1").run();
    return {enabled:true,error:'missing_dispatch_secret'};
  }
  const row=await q('SELECT * FROM scheduler_config WHERE id=1').first(),results={};
  // Completed searches update runtime even while publishing is paused. Never
  // mistake an old UI status flag for a currently held execution lease.
  const [runtimeRow,lastPostRow,leases]=await Promise.all([
    q('SELECT data FROM scheduler_runtime WHERE id=1').first(),
    q('SELECT MAX(ts) AS last_post FROM scheduler_posts').first(),
    q("SELECT kind FROM scheduler_leases WHERE kind IN ('post','search') AND expires>?",now).all()
  ]);
  const status=JSON.parse(row.status),runtime=JSON.parse(runtimeRow.data);
  const lastPost=Math.max(Number(status.last_post||0),Number(lastPostRow.last_post||0));
  row.status=JSON.stringify({...status,
    ...(Number(runtime.last_scan_attempt||0)>Number(status.last_scan_attempt||0)?runtime:{}),
    last_post:lastPost,next_slot_stale:lastPost!==Number(status.last_post||0),
    scan_running:leases.results.some(x=>x.kind==='search'),post_running:leases.results.some(x=>x.kind==='post')
  });
  for(const kind of dueJobs(row,now)){
    const owner=crypto.randomUUID(),key='clock_'+kind;
    // Atomic D1 lease closes races between overlapping Cron invocations and
    // retains a dispatch cooldown after a lost/ambiguous GitHub response.
    const lock=await q('INSERT INTO scheduler_leases(kind,owner,expires) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE scheduler_leases.expires<=?',key,owner,now+300,now).run();
    if(!lock.meta.changes){results[kind]='cooldown';continue;}
    try{
      const file=workflows[kind];
      const runs=await github(env,'/actions/workflows/'+file+'/runs?per_page=100',null,fetcher);
      if(!Array.isArray(runs.workflow_runs))throw new Error('Invalid GitHub run response');
      if(runs.workflow_runs.some(r=>active.has(r.status))){results[kind]='already_running';continue;}
      await github(env,'/actions/workflows/'+file+'/dispatches',{ref:'main'},fetcher);
      results[kind]='accepted';
      await q("UPDATE scheduler_config SET status=json_set(status,'$.clock_error','','$.last_"+kind+"_dispatch',?) WHERE id=1",now).run();
      console.log('CLOUDFLARE_DISPATCH',kind,'ACCEPTED');
    }catch(error){
      const safe=/^GitHub HTTP \d{3}$/.test(error.message)?error.message:'Dispatch temporarily unavailable';
      results[kind]='error';
      await q("UPDATE scheduler_config SET status=json_set(status,'$.clock_error',?) WHERE id=1",safe).run();
      // Authentication failures need credential repair, not minute-by-minute retries.
      if(/HTTP (401|403)/.test(safe))await q('UPDATE scheduler_leases SET expires=? WHERE kind=? AND owner=?',now+21600,key,owner).run();
      console.log('CLOUDFLARE_DISPATCH',kind,safe);
    }
  }
  return {enabled:true,results};
}
