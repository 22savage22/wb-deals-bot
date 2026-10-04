// Scheduling metadata is deliberately separate from catalogue/user tables.
export const DEFAULT_SCHEDULE=Object.freeze({enabled:true,paused:false,mode:'interval',post_interval_minutes:10,post_times:[],weekdays:[0,1,2,3,4,5,6],quiet_enabled:false,quiet_start:'23:00',quiet_end:'07:00',search_enabled:true,search_interval_minutes:20,min_queue:100,natural_interval_enabled:false,jitter_minutes:2,timezone:'Europe/Moscow',min_post_gap_minutes:5,max_posts_hour:12,max_posts_day:144});
const time=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const seconds=()=>Math.floor(Date.now()/1000);
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const validZones=new Set();
export function validateSchedule(input){
  if(!object(input))throw new Error('Некорректное расписание');
  const s={...DEFAULT_SCHEDULE,...input};
  for(const k of ['enabled','paused','quiet_enabled','search_enabled','natural_interval_enabled'])if(typeof s[k]!=='boolean')throw new Error('Некорректный переключатель');
  if(!['interval','times'].includes(s.mode))throw new Error('Неизвестный режим расписания');
  for(const k of ['post_interval_minutes','search_interval_minutes'])if(!Number.isInteger(s[k])||s[k]<5||s[k]>10080)throw new Error('Интервал: от 5 до 10080 минут');
  for(const [k,min,max] of [['min_queue',1,300],['jitter_minutes',0,120],['min_post_gap_minutes',5,1440],['max_posts_hour',1,12],['max_posts_day',1,288]])if(!Number.isInteger(s[k])||s[k]<min||s[k]>max)throw new Error('Некорректный лимит: '+k);
  if(!Array.isArray(s.post_times)||s.post_times.length>24||!s.post_times.every(x=>typeof x==='string'&&time.test(x)))throw new Error('Укажите до 24 точных времён HH:MM');
  s.post_times=[...new Set(s.post_times)].sort();if(s.mode==='times'&&!s.post_times.length)throw new Error('Добавьте время публикации');
  if(!Array.isArray(s.weekdays)||!s.weekdays.length||!s.weekdays.every(x=>Number.isInteger(x)&&x>=0&&x<=6))throw new Error('Выберите дни недели');
  s.weekdays=[...new Set(s.weekdays)].sort();
  if(!time.test(s.quiet_start)||!time.test(s.quiet_end)||s.quiet_enabled&&s.quiet_start===s.quiet_end)throw new Error('Проверьте часы тишины');
  if(typeof s.timezone!=='string'||s.timezone.length>80)throw new Error('Некорректный часовой пояс');
  if(!validZones.has(s.timezone)){try{new Intl.DateTimeFormat('en',{timeZone:s.timezone}).format();validZones.add(s.timezone);}catch{throw new Error('Неизвестный часовой пояс');}}
  return Object.fromEntries(Object.keys(DEFAULT_SCHEDULE).map(k=>[k,s[k]]));
}
const schemas=[
  'CREATE TABLE IF NOT EXISTS scheduler_inventory (pid INTEGER PRIMARY KEY,data TEXT NOT NULL,topic TEXT NOT NULL,title_key TEXT NOT NULL,queued_at INTEGER NOT NULL,checked_at INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT \'ready\',retry_at INTEGER NOT NULL DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_ready ON scheduler_inventory(state,retry_at,expires)',
  'CREATE TABLE IF NOT EXISTS scheduler_policy (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS scheduler_deliveries (pid INTEGER NOT NULL,ts INTEGER NOT NULL,message_id INTEGER,topic TEXT NOT NULL,title_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(pid,ts))',
  'CREATE TABLE IF NOT EXISTS scheduler_config (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,revision INTEGER NOT NULL,post_request TEXT,search_request TEXT,status TEXT NOT NULL DEFAULT \'{}\')',
  'CREATE TABLE IF NOT EXISTS scheduler_leases (kind TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS scheduler_claims (pid INTEGER PRIMARY KEY,owner TEXT NOT NULL,ts INTEGER NOT NULL,status TEXT NOT NULL,request_id TEXT)',
  'CREATE TABLE IF NOT EXISTS scheduler_posts (pid INTEGER NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(pid,ts))',
  'CREATE TABLE IF NOT EXISTS scheduler_requests (kind TEXT NOT NULL,request_id TEXT NOT NULL,ts INTEGER NOT NULL,PRIMARY KEY(kind,request_id))',
  'CREATE TABLE IF NOT EXISTS scheduler_actions (request_id TEXT PRIMARY KEY,ts INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS scheduler_runtime (id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS scheduler_posts_time ON scheduler_posts(ts)'
];
const initialized=new WeakMap();
// The daily Free budget counts scanned rows, not just the number of queries.
// In particular, a topic check for each queued card must not scan all history.
export const SCHEDULER_INDEXES=[
  'CREATE INDEX IF NOT EXISTS scheduler_deliveries_topic_time ON scheduler_deliveries(topic,ts)',
  'CREATE INDEX IF NOT EXISTS scheduler_deliveries_time ON scheduler_deliveries(ts)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_title ON scheduler_inventory(title_key)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_topic_ready ON scheduler_inventory(state,topic,expires)',
  'CREATE INDEX IF NOT EXISTS scheduler_claims_time ON scheduler_claims(ts)',
  'CREATE INDEX IF NOT EXISTS scheduler_claims_status_time ON scheduler_claims(status,ts)',
  'CREATE INDEX IF NOT EXISTS scheduler_requests_time ON scheduler_requests(ts DESC)',
  'CREATE INDEX IF NOT EXISTS scheduler_actions_time ON scheduler_actions(ts)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_expiry ON scheduler_inventory(state,expires)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_order ON scheduler_inventory(state,queued_at,pid)',
  'CREATE INDEX IF NOT EXISTS scheduler_inventory_preflight ON scheduler_inventory(state,checked_at)'
];
export const QUEUE_COUNTER_SCHEMA=[
  'CREATE TABLE IF NOT EXISTS scheduler_counts (id INTEGER PRIMARY KEY CHECK(id=1),ready INTEGER NOT NULL)',
  "INSERT OR IGNORE INTO scheduler_counts SELECT 1,COUNT(*) FROM scheduler_inventory WHERE state='ready'",
  "CREATE TRIGGER IF NOT EXISTS inventory_count_insert AFTER INSERT ON scheduler_inventory WHEN NEW.state='ready' BEGIN UPDATE scheduler_counts SET ready=ready+1 WHERE id=1; END",
  "CREATE TRIGGER IF NOT EXISTS inventory_count_delete AFTER DELETE ON scheduler_inventory WHEN OLD.state='ready' BEGIN UPDATE scheduler_counts SET ready=ready-1 WHERE id=1; END",
  "CREATE TRIGGER IF NOT EXISTS inventory_count_update AFTER UPDATE OF state ON scheduler_inventory WHEN OLD.state<>NEW.state BEGIN UPDATE scheduler_counts SET ready=ready+(NEW.state='ready')-(OLD.state='ready') WHERE id=1; END"
];
export async function ensureScheduler(env){
  if(initialized.has(env.DB))return initialized.get(env.DB);
  const pending=initialize(env);initialized.set(env.DB,pending);
  try{await pending;}catch(e){initialized.delete(env.DB);throw e;}
}
async function initialize(env){
  const q=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  let existing;
  try{existing=await q('SELECT status FROM scheduler_config WHERE id=1').first();}
  catch(error){
    // A quota/network failure is NOT an empty database: never retry DDL then.
    if(!/no such table.*scheduler_config/i.test(String(error.message)))throw error;
  }
  if(Number(JSON.parse(existing?.status||'{}').schema_version||0)>=3)return;
  if(!existing){
    await env.DB.batch(schemas.map(sql=>q(sql)));
    await env.DB.batch([q('INSERT OR IGNORE INTO scheduler_config(id,data,revision) VALUES(1,?,1)',JSON.stringify(DEFAULT_SCHEDULE)),q("INSERT OR IGNORE INTO scheduler_runtime(id,data) VALUES(1,'{}')")]);
  }
  // Additive migration; settings, runtime secrets and existing records survive.
  await env.DB.batch(SCHEDULER_INDEXES.map(sql=>q(sql)));
  await env.DB.batch(QUEUE_COUNTER_SCHEMA.map(sql=>q(sql)));
  await q("UPDATE scheduler_config SET status=json_set(status,'$.schema_version',3) WHERE id=1").run();
}
const dayFormatters=new Map();
function dayAt(ts,zone){if(!dayFormatters.has(zone))dayFormatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}));return dayFormatters.get(zone).format(new Date(ts*1000));}
function dayStart(ts,zone){const day=dayAt(ts,zone);let lo=ts-90000,hi=ts;while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(dayAt(mid,zone)===day)hi=mid;else lo=mid;}return hi;}
const text=(v,max=120)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\r\n]/.test(v)?v:null;
const safeError=v=>typeof v==='string'?v.replace(/https?:\/\/\S+|(?:bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi,'[скрыто]').slice(0,180):'';
const number=v=>Number.isFinite(v)&&v>=0?Math.floor(v):0;
function sanitizedStatus(input){const result={heartbeat:seconds()};for(const k of ['last_post','last_scan_attempt','last_scan_success','queue_size','new_today','posted_today','posts_hour','next_post','next_search','revision'])if(Number.isFinite(input[k]))result[k]=number(input[k]);for(const k of ['post_running','scan_running'])if(typeof input[k]==='boolean')result[k]=input[k];for(const k of ['last_scan_error','error'])if(input[k])result[k]=safeError(input[k]);if(Array.isArray(input.next_posts))result.next_posts=input.next_posts.filter(Number.isFinite).slice(0,5).map(number);return result;}
export async function schedulerRoute(request,env,{payload,fail,json,admin=false}={}){
  const path=new URL(request.url).pathname,method=request.method;
  if(!path.startsWith('/api/scheduler/')&&!path.startsWith('/api/admin/schedule'))return null;
  const q=(sql,...args)=>env.DB.prepare(sql).bind(...args),all=async(sql,...args)=>(await q(sql,...args).all()).results;
  await ensureScheduler(env);
  const config=async()=>{const row=await q('SELECT * FROM scheduler_config WHERE id=1').first();const status=JSON.parse(row.status),heartbeat=Math.max(status.heartbeat||0,status.clock_heartbeat||0),cron_configured=['cloudflare','cloudflare-native'].includes(env.SCHEDULER_DRIVER);return {schedule:JSON.parse(row.data),revision:row.revision,post_request:row.post_request,search_request:row.search_request,status:{...status,driver:env.SCHEDULER_DRIVER||'github-actions',cron_configured,cron_active:cron_configured&&seconds()-Number(status.clock_heartbeat||0)<=180,heartbeat_stale:!heartbeat||seconds()-heartbeat>180}};};
  const save=async(data)=>{let schedule;try{schedule=validateSchedule(data.schedule);}catch(e){fail(400,e.message);}if(!Number.isInteger(data.revision))fail(400,'Нужна версия настроек');const revision=Math.max(Date.now(),data.revision+1);const r=await q('UPDATE scheduler_config SET data=?,revision=? WHERE id=1 AND revision=?',JSON.stringify(schedule),revision,data.revision).run();if(!r.meta.changes)fail(409,'Настройки уже изменились. Обновите страницу');return config();};
  if((path==='/api/scheduler/config'||path==='/api/admin/schedule')&&method==='GET')return json(await config());
  if(path==='/api/scheduler/budget'&&method==='GET')return json({day:new Date().toISOString().slice(0,10),rows:await all('SELECT lane,reads,writes FROM worker_read_budget WHERE day=? LIMIT 2',new Date().toISOString().slice(0,10)),limits:{core:1500000,optional:1500000},write_limits:{core:35000,optional:45000},includes_read_ledger_overhead:false});
  if((path==='/api/scheduler/config'||path==='/api/admin/schedule')&&method==='PUT')return json(await save(await payload(request)));
  if((path==='/api/admin/schedule/action'&&admin||path==='/api/scheduler/action')&&method==='POST'){
    const data=await payload(request),action=data.action;if(['post_now','search_now'].includes(action)){const key=action==='post_now'?'post_request':'search_request',id=data.request_id??crypto.randomUUID();if(!text(id))fail(400,'Некорректный запрос');await env.DB.batch([q(`UPDATE scheduler_config SET ${key}=? WHERE id=1 ${admin?'AND '+key+' IS NULL':''} AND NOT EXISTS(SELECT 1 FROM scheduler_actions WHERE request_id=?)`,id,id),q('INSERT OR IGNORE INTO scheduler_actions(request_id,ts) VALUES(?,?)',id,seconds())]);return json({...await config(),accepted:true},admin?202:200);}
    if(['pause','resume'].includes(action)){for(let attempt=0;attempt<3;attempt++){const current=await config();try{return json(await save({schedule:{...current.schedule,paused:action==='pause'},revision:current.revision}));}catch(e){if(e.status!==409||attempt===2)throw e;}}}
    fail(400,'Неизвестное действие');
  }
  if(path==='/api/scheduler/status'&&method==='PUT'){const data=await payload(request),status=sanitizedStatus(data);status.error=safeError(data.error);status.last_scan_error=safeError(data.last_scan_error);await q('UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1',JSON.stringify(status)).run();return json({ok:true});}
  if(path!=='/api/scheduler/runtime'||method!=='POST')fail(405,'Метод не поддерживается');
  const data=await payload(request),now=seconds(),kind=data.kind,owner=text(data.owner);
  const runtime=async()=>JSON.parse((await q('SELECT data FROM scheduler_runtime WHERE id=1').first()).data);
  const updateRuntime=async(value)=>q('UPDATE scheduler_runtime SET data=? WHERE id=1',JSON.stringify(value)).run();
  if(data.op==='snapshot'){
    const [stored,posts,leases,consumed]=await Promise.all([runtime(),all('SELECT pid,ts FROM scheduler_posts WHERE ts>? ORDER BY ts DESC LIMIT 4032',now-14*86400),all('SELECT kind,expires FROM scheduler_leases WHERE expires>? LIMIT 2',now),all('SELECT kind,request_id FROM scheduler_requests ORDER BY ts DESC LIMIT 200')]);posts.reverse();
    return json({...stored,last_post:posts.at(-1)?.ts||0,posts,scan_running:leases.some(x=>x.kind==='search'),post_running:leases.some(x=>x.kind==='post'),consumed_requests:consumed});
  }
  if(['acquire','renew','release'].includes(data.op)){
    if(!['post','search'].includes(kind)||!owner)fail(400,'Некорректная аренда');
    if(data.op==='release'){await q('DELETE FROM scheduler_leases WHERE kind=? AND owner=?',kind,owner).run();return json({ok:true});}
    const ttl=data.ttl??300;if(!Number.isInteger(ttl)||ttl<5||ttl>1800)fail(400,'Некорректное время аренды');
    const result=data.op==='acquire'?await q(`INSERT INTO scheduler_leases(kind,owner,expires) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE scheduler_leases.expires<=?`,kind,owner,now+ttl,now).run():await q('UPDATE scheduler_leases SET expires=? WHERE kind=? AND owner=? AND expires>?',now+ttl,kind,owner,now).run();return json({ok:!!result.meta.changes,...(!result.meta.changes?{reason:'lock_busy'}:{})});
  }
  if(data.op==='consume'){
    if(!['post','search'].includes(kind)||!text(data.request_id)||!owner)fail(400,'Некорректный запрос');
    const field=kind==='post'?'post_request':'search_request';
    const results=await env.DB.batch([
      q(`INSERT OR IGNORE INTO scheduler_requests(kind,request_id,ts) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM scheduler_leases WHERE kind=? AND owner=? AND expires>?)`,kind,data.request_id,now,kind,owner,now),
      q(`UPDATE scheduler_config SET ${field}=NULL WHERE id=1 AND ${field}=? AND EXISTS(SELECT 1 FROM scheduler_requests WHERE kind=? AND request_id=?)`,data.request_id,kind,data.request_id)
    ]);const changed=!!results[0].meta.changes;return json({ok:changed,...(!changed?{reason:'consumed_or_no_lease'}:{})});
  }
  if(data.op==='claim'){
    if(!owner||!Number.isInteger(data.product_id)||data.product_id<=0)fail(400,'Некорректный товар');
    const schedule=(await config()).schedule;
    if(!text(data.request_id)&&(!schedule.enabled||schedule.paused))return json({ok:false,reason:'posting_paused'});
    const gap=Math.max(data.min_gap_minutes??schedule.min_post_gap_minutes,schedule.min_post_gap_minutes),hour=Math.min(data.max_hour??schedule.max_posts_hour,schedule.max_posts_hour),day=Math.min(data.max_day??schedule.max_posts_day,schedule.max_posts_day),repost=data.repost_days??7,zone=schedule.timezone;
    if(!Number.isInteger(gap)||gap<5||gap>1440||!Number.isInteger(hour)||hour<1||hour>12||!Number.isInteger(day)||day<1||day>288||!Number.isInteger(repost)||repost<7||repost>365)fail(400,'Некорректные ограничения публикации');let start;try{start=dayStart(now,zone);}catch{fail(400,'Некорректный часовой пояс');}
    // Unknown send outcomes also reserve capacity: lost Telegram responses must
    // not allow a restarted runner to exceed hourly/daily limits.
    const r=await q(`INSERT INTO scheduler_claims(pid,owner,ts,status,request_id) SELECT ?,?,?,'pending',? WHERE EXISTS(SELECT 1 FROM scheduler_leases WHERE kind='post' AND owner=? AND expires>?) AND NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE ts>?) AND (SELECT count(*) FROM scheduler_claims WHERE ts>? AND status<>'rejected')<? AND (SELECT count(*) FROM scheduler_claims WHERE ts>=? AND status<>'rejected')<? AND NOT EXISTS(SELECT 1 FROM scheduler_claims WHERE status IN ('pending','error') AND ts>?) ON CONFLICT(pid) DO UPDATE SET owner=excluded.owner,ts=excluded.ts,status='pending',request_id=excluded.request_id WHERE scheduler_claims.ts<?`,data.product_id,owner,now,text(data.request_id),owner,now,now-gap*60,now-3600,hour,start,day,now-gap*60,now-repost*86400).run();
    return json({ok:!!r.meta.changes,...(!r.meta.changes?{reason:'duplicate_or_limit_or_no_lease'}:{})});
  }
  if(data.op==='complete'){
    if(!owner||!Number.isInteger(data.product_id)||typeof data.success!=='boolean')fail(400,'Некорректный результат');
    const status=data.success?'success':data.rejected===true?'rejected':'error';
    // Both writes share one atomic D1 batch; retries cannot record a second successful post.
    await env.DB.batch([q(`INSERT OR IGNORE INTO scheduler_posts(pid,ts) SELECT pid,? FROM scheduler_claims WHERE pid=? AND owner=? AND status='pending' AND ?=1`,now,data.product_id,owner,data.success?1:0),q("UPDATE scheduler_claims SET status=? WHERE pid=? AND owner=? AND status='pending'",status,data.product_id,owner)]);return json({ok:true});
  }
  if(data.op==='scan_complete'){
    if(!owner||!await q("SELECT 1 FROM scheduler_leases WHERE kind='search' AND owner=? AND expires>?",owner,now).first())return json({ok:false,reason:'no_lease'});
    const stored=await runtime(),zone=(await config()).schedule.timezone,today=dayAt(now,zone);const error=safeError(data.error);await updateRuntime({...stored,last_scan_attempt:now,...(!error?{last_scan_success:now}:{}),last_scan_error:error,new_day:today,new_today:(stored.new_day===today?number(stored.new_today):0)+number(data.new),queue_size:number(data.queue_size),last_scan_found:number(data.found),last_scan_added:number(data.added)});
    await env.DB.batch([q('DELETE FROM scheduler_posts WHERE ts<?',now-14*86400),q('DELETE FROM scheduler_claims WHERE ts<?',now-14*86400),q('DELETE FROM scheduler_requests WHERE ts<?',now-14*86400),q('DELETE FROM scheduler_actions WHERE ts<?',now-14*86400)]);return json({ok:true});
  }
  fail(400,'Неизвестная операция');
}
