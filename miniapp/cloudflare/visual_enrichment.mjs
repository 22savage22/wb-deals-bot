// Optional sidecar: no Telegram, WB search, posting config, personal data or API token.
import {VISUAL_VERSION,normalizeAnalysis,mergeAnalyses,visualPrompt,profileFeatures,visualLabel} from './visual_features.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a),now=()=>Math.floor(Date.now()/1000);
export const VISUAL_MODEL='@cf/meta/llama-3.2-11b-vision-instruct';
export const VISUAL_DAILY_CALLS=40;
const missing=e=>/no such table.*visual_/i.test(String(e?.message));
export async function ensureVisual(e){
  if(await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v2'").first())return;
  if(await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v1'").first()){
    await e.DB.batch([
      q(e,'CREATE INDEX IF NOT EXISTS visual_queue_latest ON visual_queue(state,retry_at,queued_at DESC,pid)'),
      q(e,`CREATE TRIGGER IF NOT EXISTS visual_photo_repaired AFTER UPDATE OF data ON scheduler_inventory WHEN COALESCE(json_extract(NEW.data,'$.image'),'')<>'' AND NOT EXISTS(SELECT 1 FROM visual_profiles WHERE pid=NEW.pid) BEGIN INSERT INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at) ON CONFLICT(pid) DO UPDATE SET state='pending',retry_at=0,error='' WHERE visual_queue.error='VISUAL_NO_IMAGE'; END`),
      q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v2','1')")
    ]);return;
  }
  await e.DB.batch([
    q(e,"CREATE TABLE IF NOT EXISTS visual_queue(pid INTEGER PRIMARY KEY,state TEXT NOT NULL DEFAULT 'pending',retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,queued_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '')"),
    q(e,'CREATE INDEX IF NOT EXISTS visual_queue_due ON visual_queue(state,retry_at,queued_at,pid)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_profiles(pid INTEGER PRIMARY KEY,version INTEGER NOT NULL,analyzed_at INTEGER NOT NULL,profile TEXT NOT NULL,feedback_cursor INTEGER NOT NULL DEFAULT 0,backfill_pending INTEGER NOT NULL DEFAULT 1)'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_profiles_time ON visual_profiles(analyzed_at DESC)'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_profiles_backfill ON visual_profiles(backfill_pending,pid)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_images(pid INTEGER NOT NULL,image_index INTEGER NOT NULL,url TEXT NOT NULL,hash TEXT NOT NULL,analysis TEXT NOT NULL,PRIMARY KEY(pid,image_index))'),
    q(e,"CREATE TABLE IF NOT EXISTS visual_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,last_run INTEGER NOT NULL DEFAULT 0,last_success INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',lease TEXT,expires INTEGER NOT NULL DEFAULT 0,event_cursor INTEGER NOT NULL DEFAULT 0)"),
    q(e,'INSERT OR IGNORE INTO visual_state(id) VALUES(1)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_events(event_id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,ts INTEGER NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL,keys TEXT NOT NULL)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_stats(key TEXT PRIMARY KEY,likes REAL NOT NULL DEFAULT 0,dislikes REAL NOT NULL DEFAULT 0,bought REAL NOT NULL DEFAULT 0,saves REAL NOT NULL DEFAULT 0,clicks REAL NOT NULL DEFAULT 0,observations INTEGER NOT NULL DEFAULT 0,products INTEGER NOT NULL DEFAULT 0,last INTEGER NOT NULL DEFAULT 0)'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_stats_rank ON visual_stats(observations DESC)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_memberships(key TEXT NOT NULL,pid INTEGER NOT NULL,PRIMARY KEY(key,pid))'),
    q(e,'CREATE INDEX IF NOT EXISTS learning_events_pid_id ON learning_events(pid,id)'),
    q(e,`CREATE TRIGGER IF NOT EXISTS visual_new_product AFTER INSERT ON scheduler_inventory WHEN NEW.state='ready' BEGIN INSERT OR IGNORE INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at); END`),
    q(e,`CREATE TRIGGER IF NOT EXISTS visual_member_count AFTER INSERT ON visual_memberships BEGIN UPDATE visual_stats SET products=products+1 WHERE key=NEW.key; END`),
    q(e,`CREATE TRIGGER IF NOT EXISTS visual_aggregate AFTER INSERT ON visual_events BEGIN
      INSERT INTO visual_stats(key,likes,dislikes,bought,saves,clicks,observations,last)
        SELECT value,CASE WHEN NEW.kind='like' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='buy' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='save' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='click' THEN NEW.weight ELSE 0 END,1,NEW.ts FROM json_each(NEW.keys) WHERE value NOT LIKE 'visual.group=%'
        ON CONFLICT(key) DO UPDATE SET likes=likes+excluded.likes,dislikes=dislikes+excluded.dislikes,bought=bought+excluded.bought,saves=saves+excluded.saves,clicks=clicks+excluded.clicks,observations=observations+1,last=MAX(last,excluded.last);
      INSERT OR IGNORE INTO visual_memberships SELECT value,NEW.pid FROM json_each(NEW.keys) WHERE value NOT LIKE 'visual.group=%' AND NEW.kind IN ('like','dislike'); END`),
    q(e,`INSERT OR IGNORE INTO visual_queue(pid,queued_at) SELECT pid,queued_at FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at DESC LIMIT 100`),
    q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v1','1')")
  ]);
  await ensureVisual(e);
}
export async function cachedProfiles(e,ids){
  if(!ids.length)return new Map();
  try{return new Map((await q(e,'SELECT pid,profile FROM visual_profiles WHERE pid IN (SELECT value FROM json_each(?)) LIMIT 300',JSON.stringify(ids.slice(0,300))).all()).results.map(r=>[r.pid,JSON.parse(r.profile)]));}catch(error){if(missing(error))return new Map();throw error;}
}
const safeImage=s=>{try{const u=new URL(s);return u.protocol==='https:'&&/^basket-\d+\.wbbasket\.ru$/.test(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.search&&/\/images\/(?:big|c246x328|c516x688)\/\d+\.(?:webp|jpg|png)$/.test(u.pathname);}catch{return false;}};
export function photoURLs(p){
  const first=p.image;if(!safeImage(first))return [];
  const extra=[...(Array.isArray(p.images)?p.images:[]),...(Array.isArray(p.photos)?p.photos:[])].filter(safeImage).find(s=>s!==first);
  // Probe at most ONE adjacent photo on the exact observed shard; absence is fine.
  return [first,extra||first.replace(/\/1\.(webp|jpg|png)$/,'/2.$1')].filter((v,i,a)=>a.indexOf(v)===i).slice(0,2);
}
async function imageBytes(url,fetcher){
  const r=await fetcher(url,{signal:AbortSignal.timeout(5000),redirect:'error'});
  if(!r.ok||!r.headers.get('content-type')?.startsWith('image/'))throw new Error('VISUAL_IMAGE_UNAVAILABLE');
  if(Number(r.headers.get('content-length'))>512000)throw new Error('VISUAL_IMAGE_TOO_LARGE');
  const reader=r.body.getReader(),parts=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>512000){await reader.cancel();throw new Error('VISUAL_IMAGE_TOO_LARGE');}parts.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  return {bytes,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')};
}
function errorCode(err){const s=String(err?.message||'');if(/agree|license|terms|5020/i.test(s))return 'VISUAL_MODEL_TERMS_REQUIRED';if(/3036|allocation|neurons|429|quota/i.test(s))return 'VISUAL_FREE_QUOTA';if(/paid plan|5035/i.test(s))return 'VISUAL_PAID_MODEL_REFUSED';if(/VISUAL_[A-Z_]+/.test(s))return s.match(/VISUAL_[A-Z_]+/)[0];return 'VISUAL_MODEL_UNAVAILABLE';}
async function infer(e,bytes){
  // Account Free plan is a hard no-billing boundary; never upgrade/enable paid models.
  const day=new Date().toISOString().slice(0,10);
  const charged=await q(e,`INSERT INTO visual_usage(day,calls) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<?`,day,VISUAL_DAILY_CALLS).run();
  if(!charged.meta.changes)throw new Error('VISUAL_FREE_QUOTA');
  let timer;try{return await Promise.race([e.AI.run(VISUAL_MODEL,{image:[...bytes],prompt:visualPrompt(),max_tokens:600,temperature:0}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('VISUAL_MODEL_TIMEOUT')),22000);})]);}finally{clearTimeout(timer);}
}
export async function maintainVisualEvents(e,pid=null){
  // Real feedback only. Unique event_id and trigger atomically deduplicate replay.
  const state=await q(e,'SELECT event_cursor FROM visual_state WHERE id=1').first();
  const cursor=pid===null?state.event_cursor:(await q(e,'SELECT feedback_cursor FROM visual_profiles WHERE pid=?',pid).first())?.feedback_cursor||0;
  const rows=(await q(e,`SELECT id FROM learning_events WHERE ${pid===null?'id>?':'pid=? AND id>?'} ORDER BY id LIMIT 5`,...(pid===null?[cursor]:[pid,cursor])).all()).results;
  if(!rows.length){if(pid!==null)await q(e,'UPDATE visual_profiles SET backfill_pending=0 WHERE pid=?',pid).run();return;}
  const end=rows.at(-1).id;
  await e.DB.batch([
    q(e,`INSERT OR IGNORE INTO visual_events SELECT a.id,a.pid,a.ts,a.kind,a.weight,json_extract(v.profile,'$.feature_keys') FROM learning_events a JOIN visual_profiles v ON v.pid=a.pid WHERE ${pid===null?'a.id>? AND a.id<=?':'a.pid=? AND a.id>? AND a.id<=?'} AND json_array_length(json_extract(v.profile,'$.feature_keys'))>0`,...(pid===null?[cursor,end]:[pid,cursor,end])),
    ...(pid===null?[q(e,'UPDATE visual_state SET event_cursor=MAX(event_cursor,?) WHERE id=1',end)]:[q(e,'UPDATE visual_profiles SET feedback_cursor=MAX(feedback_cursor,?),backfill_pending=? WHERE pid=?',end,rows.length===5?1:0,pid)])
  ]);
}
export async function visualRun(e,{fetcher=fetch,force=false,ts=now()}={}){
  await ensureVisual(e);
  const state=await q(e,'SELECT * FROM visual_state WHERE id=1').first();
  if(!state.enabled&&!force)return {state:'disabled'};
  if(!e.AI?.run)return {state:'unavailable',error:'VISUAL_BINDING_MISSING'};
  const lease=crypto.randomUUID();
  const acquired=await q(e,'UPDATE visual_state SET lease=?,expires=?,last_run=? WHERE id=1 AND expires<=?',lease,ts+180,ts,ts).run();
  if(!acquired.meta.changes)return {state:'busy'};
  try{
    await maintainVisualEvents(e);
    const replay=await q(e,'SELECT pid FROM visual_profiles WHERE backfill_pending=1 ORDER BY pid LIMIT 1').first();
    if(replay)await maintainVisualEvents(e,replay.pid);
    const row=await q(e,"SELECT * FROM visual_queue WHERE state='pending' AND retry_at<=? ORDER BY retry_at,queued_at DESC,pid LIMIT 1",ts).first();
    if(!row)return {state:'idle'};
    if((await cachedProfiles(e,[row.pid])).has(row.pid)){await q(e,"UPDATE visual_queue SET state='complete',error='' WHERE pid=?",row.pid).run();return {state:'cached',pid:row.pid};}
    const stored=await q(e,'SELECT data FROM scheduler_inventory WHERE pid=?',row.pid).first();
    if(!stored){await q(e,"UPDATE visual_queue SET state='skipped',error='VISUAL_NO_PRODUCT' WHERE pid=?",row.pid).run();return {state:'skipped',pid:row.pid};}
    const p=JSON.parse(stored.data),urls=photoURLs(p),analyses=[];
    try{
      if(!urls.length){await q(e,"UPDATE visual_queue SET state='skipped',error='VISUAL_NO_IMAGE' WHERE pid=?",row.pid).run();return {state:'skipped',pid:row.pid,error:'VISUAL_NO_IMAGE'};}
      for(const [index,url] of urls.entries()){
        const cached=await q(e,'SELECT analysis FROM visual_images WHERE pid=? AND image_index=? AND url=?',row.pid,index,url).first();
        if(cached){analyses.push(JSON.parse(cached.analysis));continue;}
        let image;try{image=await imageBytes(url,fetcher);}catch(error){if(index)continue;throw error;}
        try{
          const result=await infer(e,image.bytes),text=result?.response??result?.description;
          const analysis=normalizeAnalysis(text,{url,hash:image.hash,image_index:index});
          await q(e,'INSERT OR REPLACE INTO visual_images VALUES(?,?,?,?,?)',row.pid,index,url,image.hash,JSON.stringify(analysis)).run();analyses.push(analysis);
          // One inference/execution fits waitUntil's 30s grace. Resume a second
          // view next time using the durable first-image cache, never reinfer it.
          if(index===0&&urls.length>1)return {state:'partial',pid:row.pid,images_cached:1};
        }catch(error){if(index&&analyses.length)break;throw error;}
      }
      const profile=mergeAnalyses(analyses,ts,VISUAL_MODEL);
      await e.DB.batch([q(e,'INSERT OR IGNORE INTO visual_profiles(pid,version,analyzed_at,profile) VALUES(?,?,?,?)',row.pid,VISUAL_VERSION,ts,JSON.stringify(profile)),q(e,"UPDATE visual_queue SET state='complete',error='' WHERE pid=?",row.pid),q(e,"UPDATE visual_state SET last_success=?,last_error='' WHERE id=1",ts)]);
      await maintainVisualEvents(e,row.pid);
      console.log('VISUAL_CACHED',JSON.stringify({pid:row.pid,images:profile.images.length,features:profile.feature_keys.length}));
      return {state:'complete',pid:row.pid,title:p.title,profile};
    }catch(err){
      const code=errorCode(err),blocked=['VISUAL_MODEL_TERMS_REQUIRED','VISUAL_PAID_MODEL_REFUSED'].includes(code),quota=code==='VISUAL_FREE_QUOTA';
      const tomorrow=new Date();tomorrow.setUTCHours(24,1,0,0);
      const retry=quota?Math.floor(tomorrow.getTime()/1000):ts+Math.min(21600,300*2**Math.min(6,row.attempts))+Math.floor(Math.random()*61);
      await e.DB.batch([q(e,"UPDATE visual_queue SET attempts=attempts+1,retry_at=?,error=?,state=? WHERE pid=?",retry,code,row.attempts>=4&&!quota&&!blocked?'skipped':'pending',row.pid),q(e,'UPDATE visual_state SET last_error=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=1',code,blocked?1:0)]);
      console.log('VISUAL_DEFERRED',code);return {state:'deferred',pid:row.pid,error:code,retry_at:retry};
    }
  }finally{await q(e,'UPDATE visual_state SET expires=0,lease=NULL WHERE id=1 AND lease=?',lease).run();}
}
export function confidenceInterval(likes,dislikes){const n=likes+dislikes;if(!n)return [0,1];const z=1.96,p=likes/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,r=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-r),Math.min(1,c+r)];}
export async function visualStatus(e){
  try{
    const state=await q(e,'SELECT * FROM visual_state WHERE id=1').first();if(!state)return {initialized:false};
    const day=new Date().toISOString().slice(0,10),usage=await q(e,'SELECT calls FROM visual_usage WHERE day=?',day).first();
    const examples=(await q(e,'SELECT v.pid,v.profile,i.data FROM visual_profiles v JOIN scheduler_inventory i ON i.pid=v.pid ORDER BY v.analyzed_at DESC LIMIT 3').all()).results.map(r=>({pid:r.pid,title:JSON.parse(r.data).title,...JSON.parse(r.profile)}));
    const next=(await q(e,"SELECT v.pid,i.data FROM visual_queue v JOIN scheduler_inventory i ON i.pid=v.pid WHERE v.state='pending' AND v.retry_at<=? ORDER BY v.retry_at,v.queued_at DESC,v.pid LIMIT 3",now()).all()).results.map(r=>{const p=JSON.parse(r.data);return {pid:r.pid,title:p.title,image:safeImage(p.image)?p.image:'',image_present:!!p.image};});
    const stats=(await q(e,'SELECT * FROM visual_stats ORDER BY observations DESC LIMIT 30').all()).results.map(r=>{const interval=confidenceInterval(r.likes,r.dislikes),enough=r.observations>=20&&r.products>=5&&r.likes+r.dislikes>=20;return {...r,label:visualLabel(r.key),interval,sufficient:enough,direction:enough&&interval[0]>.5?'positive':enough&&interval[1]<.5?'negative':'insufficient'};});
    return {initialized:true,enabled:!!state.enabled,model:VISUAL_MODEL,last_run:state.last_run,last_success:state.last_success,last_error:state.last_error,calls_today:usage?.calls||0,daily_call_limit:VISUAL_DAILY_CALLS,examples,next,insights:stats,note:'Наблюдения по реальным событиям, не причинный эффект. Интервал Wilson 95%; минимум20 наблюдений/5товаров. Self-confidence vision не калибрована. Неизвестные признаки не учитываются.'};
  }catch(error){if(missing(error))return {initialized:false,enabled:false,examples:[],insights:[]};throw error;}
}
export async function visualRoute(request,e,{json,fail}){
  const path=new URL(request.url).pathname;
  const response=data=>json({...data,d1:e.D1_METER?{...e.D1_METER,before_ledger_settlement:true}:null});
  if(path.endsWith('/status')&&request.method==='GET')return response(await visualStatus(e));
  if(path.endsWith('/run')&&request.method==='POST'){
    // Keep first-run DDL separate from inference under the Free subrequest cap.
    if(!await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v1'").first()){await ensureVisual(e);return response({state:'initialized',enabled:false});}
    return response(await visualRun(e,{force:true}));
  }
  if(path.endsWith('/activate')&&request.method==='POST'){
    await ensureVisual(e);if(!await q(e,"SELECT pid FROM visual_profiles WHERE json_array_length(json_extract(profile,'$.feature_keys'))>=3 LIMIT 1").first())fail(409,'Сначала подтвердите полезный реальный visual profile');
    await q(e,'UPDATE visual_state SET enabled=1 WHERE id=1').run();return response({enabled:true});
  }
  fail(405,'Метод не поддерживается');
}
