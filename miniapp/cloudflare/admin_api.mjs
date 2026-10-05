import {schedulerRoute,ensureScheduler,validateSchedule,DEFAULT_SCHEDULE} from './scheduler_api.mjs';
import {postingWindow,postDue,checkAutopost} from './native_scheduler.mjs';
import {withReadBudget} from './read_guard.mjs';
import {learningRoute} from './learning.mjs';
export function nextPost(s,last,now=Math.floor(Date.now()/1000)){
  if(!s.enabled||s.paused)return null;
  const jitter=s.natural_interval_enabled?((last%Math.max(1,2*s.jitter_minutes+1))-s.jitter_minutes)*60:0;
  let t=Math.max(now,last+s.min_post_gap_minutes*60,s.mode==='interval'?last+s.post_interval_minutes*60+jitter:now);
  // Skip closed hours as blocks; at most 8*24 wall-hour checks, not history scans.
  const end=now+8*86400;
  while(t<=end){const wall=postingWindow(s,t);
    if(wall.allowed){if(postDue(s,last,t))return t;
      if(s.mode==='times'){const target=s.post_times.find(x=>x>wall.clock);if(target){const [h,m]=target.split(':').map(Number),[a,b]=wall.clock.split(':').map(Number);t+=(h*60+m-a*60-b)*60;continue;}}
    }
    // Advance to the next local hour, including half/quarter-hour zones.
    // Quiet-hour boundaries may lie inside that hour. Re-check DST on each jump.
    const minute=Number(wall.clock.slice(3)),step=60-minute;
    if(wall.quiet){const [h,m]=wall.clock.split(':').map(Number),[eh,em]=s.quiet_end.split(':').map(Number);t+=Math.min(step,Math.max(1,((eh*60+em-h*60-m+1440)%1440)))*60;}
    else t+=step*60;
  }return null;
}
export async function adminRoute(request,e,helpers){
  const {json,fail,payload,ctx}=helpers,path=new URL(request.url).pathname;
  if(path.startsWith('/api/admin/learning')){await ensureScheduler(e);return learningRoute(request,e,helpers);}
  if(path==='/api/admin/check'&&request.method==='POST'){
    const data=await payload(request),id=data.request_id;
    if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(id))fail(400,'Некорректная заявка');
    await ensureScheduler(e);
    // CAS coalesces double-clicks even when they arrive from two devices.
    const acquired=await e.DB.prepare(`UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1 AND
      COALESCE(json_extract(status,'$.admin_check_id'),'')<>? AND COALESCE(json_extract(status,'$.admin_check_until'),0)<?`).bind(JSON.stringify({admin_check_id:id,admin_check_until:Math.floor(Date.now()/1000)+120,admin_check_state:'running'}),id,Math.floor(Date.now()/1000)).run();
    if(acquired.meta.changes)ctx.waitUntil(withReadBudget(e,'core',25000,async env=>{
      let result;try{result=await checkAutopost(env);}catch{result={ok:false,error:'Проверка временно недоступна'};}
      await env.DB.prepare('UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1 AND json_extract(status,\'$.admin_check_id\')=?').bind(JSON.stringify({admin_check_until:0,admin_check_state:'complete',admin_check_result:result}),id).run();
    }).catch(()=>{}));
    return json({accepted:true,request_id:id},202);
  }
  if(path==='/api/admin/diagnostics'){
    const config=await schedulerRoute(new Request('https://internal/api/admin/schedule'),e,{...helpers,admin:true});
    const c=await config.json(),s=c.status;
    const budget=await e.DB.prepare('SELECT lane,reads,writes FROM worker_read_budget WHERE day=? LIMIT 2').bind(new Date().toISOString().slice(0,10)).all();
    return json({worker:true,d1:true,cron:s.cron_active,telegram:s.native_credentials_ok,wb_source:!s.last_scan_error,last_search:s.last_search_success||s.last_scan_success,queue_size:s.queue_size,heartbeat:s.last_automatic_tick||s.clock_heartbeat,last_error:s.last_error||s.error||s.last_scan_error||'',budget:budget.results,budget_note:'Счётчик Worker, не полный биллинг аккаунта'});
  }
  if(path==='/api/admin/overview'){
    // A first admin view is read-only even if the scheduler was never provisioned.
    let row;
    try{row=await e.DB.prepare('SELECT c.*,(SELECT ready FROM scheduler_counts WHERE id=1) AS ready,(SELECT MAX(ts) FROM scheduler_posts) AS latest FROM scheduler_config c WHERE id=1').first();}
    catch(error){if(/no such table/i.test(String(error.message)))fail(503,'Настройки расписания в D1 не созданы. Сохранение заблокировано.');throw error;}
    if(!row)fail(503,'Настройки расписания в D1 не созданы. Сохранение заблокировано.');
    const stored=JSON.parse(row.data);
    // Admin must never display an invented default and later write it back over D1.
    if(Object.keys(DEFAULT_SCHEDULE).some(key=>!Object.hasOwn(stored,key)))fail(503,'Настройки расписания в D1 неполные. Сохранение заблокировано.');
    const s=validateSchedule(stored),status=JSON.parse(row.status),now=Math.floor(Date.now()/1000),wall=postingWindow(s,now);
    const lastSearch=Number(status.last_scan_attempt||0),searchInterval=(row.ready<s.min_queue?(status.last_scan_error||status.last_scan_added===0?5:1):s.search_interval_minutes)*60;
    return json({schedule:s,revision:row.revision,status:{...status,queue_size:row.ready,last_post_success:Math.max(row.latest||0,status.last_post_success||0),next_post:nextPost(s,row.latest||0,now),next_search:s.search_enabled||row.search_request?Math.max(now,lastSearch+searchInterval):null,posting_allowed:wall.allowed,cron_active:e.SCHEDULER_DRIVER==='cloudflare-native'&&now-Number(status.last_automatic_tick||0)<=180},operations:{post:row.post_request?{state:'queued',id:row.post_request}:null,search:row.search_request?{state:'queued',id:row.search_request}:null}});
  }
  return null;
}
