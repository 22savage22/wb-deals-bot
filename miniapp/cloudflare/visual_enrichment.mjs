// Optional sidecar: no Telegram, WB search, posting config, personal data or API token.
import {VISUAL_VERSION,normalizeAnalysis,mergeAnalyses,visualPrompt,profileFeatures,visualLabel} from './visual_features.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a),now=()=>Math.floor(Date.now()/1000);
export const VISUAL_MODEL='@cf/google/gemma-4-26b-a4b-it';
export const VISUAL_TERMS_MODEL='@cf/meta/llama-3.2-11b-vision-instruct';
export const VISUAL_DAILY_CALLS=40;
export const VISUAL_DAILY_PRODUCTS=10;
export const VISUAL_DAILY_NEURONS=5000;
// Worst-case Gemma context (256k at 9091/M) + 900 output at 27273/M < 2500.
// Reserve before dispatch; unmetered errors/timeouts keep the entire reservation.
export const VISUAL_REQUEST_RESERVE=2500;
export const visualSourceVersion=p=>JSON.stringify([photoURLs(p),p.image_version??p.image_updated_at??null]);
const missing=e=>/no such table.*visual_/i.test(String(e?.message));
const TERMS_APPROVAL='meta-llama-3.2-11b-vision-20261005',TEST_KEY='visual_test_20261005';
async function ensureMeter(e){
  if(await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v6'").first())return;
  await e.DB.batch([
    q(e,"CREATE TABLE IF NOT EXISTS visual_inference_usage(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,day TEXT NOT NULL,pid INTEGER NOT NULL,image_index INTEGER NOT NULL,kind TEXT NOT NULL,outcome TEXT NOT NULL,usage TEXT NOT NULL)"),
    q(e,'CREATE INDEX IF NOT EXISTS visual_inference_day ON visual_inference_usage(day,ts DESC)'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_inference_pid ON visual_inference_usage(pid,ts DESC)'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_inference_pending ON visual_inference_usage(day,outcome,ts)'),
    q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v3','1')"),
    q(e,'CREATE TABLE IF NOT EXISTS visual_neuron_budget(day TEXT PRIMARY KEY,charged REAL NOT NULL)'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_budget_holds(day TEXT PRIMARY KEY,reason TEXT NOT NULL,request_id TEXT NOT NULL,ts INTEGER NOT NULL)'),
    q(e,"INSERT OR IGNORE INTO visual_budget_holds SELECT day,'historical_cost_unknown',id,ts FROM visual_inference_usage WHERE day=? AND json_extract(usage,'$.provider_neurons') IS NULL ORDER BY ts LIMIT 1",new Date().toISOString().slice(0,10)),
    q(e,'CREATE TABLE IF NOT EXISTS visual_daily_products(day TEXT NOT NULL,pid INTEGER NOT NULL,PRIMARY KEY(day,pid))'),
    q(e,'CREATE INDEX IF NOT EXISTS visual_images_hash ON visual_images(hash)'),
    q(e,"INSERT OR IGNORE INTO visual_daily_products SELECT DISTINCT day,pid FROM visual_inference_usage WHERE pid>0 AND kind='vision'"),
    q(e,"INSERT OR IGNORE INTO visual_neuron_budget SELECT day,SUM(COALESCE(json_extract(usage,'$.provider_neurons'),?)) FROM visual_inference_usage GROUP BY day",VISUAL_REQUEST_RESERVE),
    q(e,'CREATE TABLE IF NOT EXISTS visual_format_failures(pid INTEGER NOT NULL,image_index INTEGER NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,version INTEGER NOT NULL,failures INTEGER NOT NULL,PRIMARY KEY(pid,image_index,hash,model,version))'),
    q(e,`CREATE TRIGGER IF NOT EXISTS visual_image_changed AFTER UPDATE OF data ON scheduler_inventory WHEN COALESCE(json_extract(NEW.data,'$.image'),'')<>COALESCE(json_extract(OLD.data,'$.image'),'') OR COALESCE(json_extract(NEW.data,'$.image_version'),'')<>COALESCE(json_extract(OLD.data,'$.image_version'),'') OR COALESCE(json_extract(NEW.data,'$.image_updated_at'),'')<>COALESCE(json_extract(OLD.data,'$.image_updated_at'),'') OR COALESCE(json_extract(NEW.data,'$.images'),'')<>COALESCE(json_extract(OLD.data,'$.images'),'') OR COALESCE(json_extract(NEW.data,'$.photos'),'')<>COALESCE(json_extract(OLD.data,'$.photos'),'') BEGIN INSERT INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at) ON CONFLICT(pid) DO UPDATE SET state='pending',retry_at=0,attempts=0,error=''; END`),
    q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v4','1')"),
    q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v5','1')"),
    q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v6','1')")
  ]);
}
export async function ensureVisual(e){
  if(await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v2'").first()){await ensureMeter(e);return;}
  if(await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v1'").first()){
    await e.DB.batch([
      q(e,'CREATE INDEX IF NOT EXISTS visual_queue_latest ON visual_queue(state,retry_at,queued_at DESC,pid)'),
      q(e,`CREATE TRIGGER IF NOT EXISTS visual_photo_repaired AFTER UPDATE OF data ON scheduler_inventory WHEN COALESCE(json_extract(NEW.data,'$.image'),'')<>'' AND NOT EXISTS(SELECT 1 FROM visual_profiles WHERE pid=NEW.pid) BEGIN INSERT INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at) ON CONFLICT(pid) DO UPDATE SET state='pending',retry_at=0,error='' WHERE visual_queue.error='VISUAL_NO_IMAGE'; END`),
      q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_schema_v2','1')")
    ]);await ensureMeter(e);return;
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
  try{return new Map((await q(e,'SELECT v.pid,v.profile,i.data FROM visual_profiles v JOIN scheduler_inventory i ON i.pid=v.pid WHERE v.pid IN (SELECT value FROM json_each(?)) LIMIT 300',JSON.stringify(ids.slice(0,300))).all()).results.map(r=>[r.pid,JSON.parse(r.profile),JSON.parse(r.data)]).filter(([,p,i])=>p.version===VISUAL_VERSION&&p.model===VISUAL_MODEL&&p.source_version===visualSourceVersion(i)).map(([id,p])=>[id,p]));}catch(error){if(missing(error))return new Map();throw error;}
}
const safeImage=s=>{try{const u=new URL(s);return u.protocol==='https:'&&/^basket-\d+\.wbbasket\.ru$/.test(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.search&&/\/images\/(?:big|c246x328|c516x688)\/\d+\.(?:webp|jpg|png)$/.test(u.pathname);}catch{return false;}};
export function photoURLs(p){
  const first=p.image;if(!safeImage(first))return [];
  const extra=[...(Array.isArray(p.images)?p.images:[]),...(Array.isArray(p.photos)?p.photos:[])].filter(safeImage).find(s=>s!==first);
  // Probe at most ONE adjacent photo on the exact observed shard; absence is fine.
  return [first,extra||first.replace(/\/1\.(webp|jpg|png)$/,'/2.$1')].filter((v,i,a)=>a.indexOf(v)===i).slice(0,2);
}
async function imageBytes(url,fetcher){
  // Workers supports follow/manual only. Manual never follows redirects;
  // the non-2xx check below rejects them before any secondary host is fetched.
  const r=await fetcher(url,{signal:AbortSignal.timeout(5000),redirect:'manual'});
  if(!r.ok||!r.headers.get('content-type')?.startsWith('image/'))throw new Error('VISUAL_IMAGE_UNAVAILABLE');
  if(Number(r.headers.get('content-length'))>512000)throw new Error('VISUAL_IMAGE_TOO_LARGE');
  const reader=r.body.getReader(),parts=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>512000){await reader.cancel();throw new Error('VISUAL_IMAGE_TOO_LARGE');}parts.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
  const mime=r.headers.get('content-type').split(';')[0].trim().toLowerCase();if(!['image/webp','image/jpeg','image/png'].includes(mime))throw new Error('VISUAL_IMAGE_UNAVAILABLE');
  return {bytes,mime,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('')};
}
function providerError(err){
  // The AI binding has no credential in its input. Still never expose a raw
  // exception/stack: bound output and redact URLs, auth fields and opaque IDs.
  const source=[err?.message,err?.code,err?.cause?.message,err?.cause?.code].filter(v=>typeof v==='string'||typeof v==='number').join(' ');
  const codes=[...new Set(source.match(/\b(?:30\d{2}|50\d{2})\b/g)||[])].slice(0,3);
  const detail=source.replace(/https?:\/\/\S+/gi,'[url]').replace(/(?:Bearer|token|secret|authorization|cookie)\s*[:=]?\s*\S+/gi,'[redacted]').replace(/[A-Za-z0-9_+\/=-]{24,}/g,'[opaque]').slice(0,300);
  return {type:String(err?.name||'Error').replace(/[^A-Za-z0-9_]/g,'').slice(0,60),codes,detail};
}
function errorCode(err){
  const internal=String(err?.message||'');
  if(/^VISUAL_(BUDGET_UNKNOWN|DAILY_PRODUCTS|FREE_QUOTA|IMAGE_UNAVAILABLE|IMAGE_TOO_LARGE|MODEL_TIMEOUT|INVALID_JSON|INVALID_PROFILE|FORMAT_RETRY_EXHAUSTED|EMPTY_PROFILE)$/.test(internal))return internal;
  const {detail:s,codes}=providerError(err);if(codes.includes('5016')||/agree|license|terms|5020/i.test(s))return 'VISUAL_MODEL_TERMS_REQUIRED';if(codes.includes('5035')||/paid plan/i.test(s))return 'VISUAL_PAID_MODEL_REFUSED';if(codes.includes('3040'))return 'VISUAL_MODEL_CAPACITY';if(codes.includes('3036')||/allocation|neurons|quota/i.test(s))return 'VISUAL_FREE_QUOTA';return 'VISUAL_MODEL_UNAVAILABLE';
}
export function inferenceUsage(result,headers=null,model=VISUAL_TERMS_MODEL){
  const u=result?.usage||{},numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  const input=numeric(u.prompt_tokens??u.input_tokens),output=numeric(u.completion_tokens??u.output_tokens);
  // Only provider envelope/headers, NEVER model-generated JSON, are metering.
  const direct=numeric(u.neurons??result?.neurons),header=headers?.get('cf-ai-neurons');
  const neurons=direct??(header&&/^\d+(\.\d+)?$/.test(header)?Number(header):null);
  return {input_tokens:input,output_tokens:output,total_tokens:numeric(u.total_tokens),provider_neurons:neurons,
    tokens_calculated_neurons:input!==null&&output!==null?(model===VISUAL_MODEL?(input*9091+output*27273):(input*4410+output*61493))/1e6:null,
    source:neurons!==null?'provider':input!==null&&output!==null?'provider_tokens_pricing_estimate':'not_returned'};
}
async function infer(e,inputs,{pid=0,index=-1,kind='vision',model=VISUAL_MODEL}={}){
  // Account Free plan is a hard no-billing boundary; never upgrade/enable paid models.
  const day=new Date().toISOString().slice(0,10);
  // Unknown cost is a durable circuit breaker, not permission to spend a
  // second reservation. Forced/manual runs and new isolates obey it too.
  const pending=await q(e,"SELECT id FROM visual_inference_usage WHERE day=? AND outcome='attempt' ORDER BY ts LIMIT 1",day).first();
  if(pending)await e.DB.batch([q(e,'INSERT OR IGNORE INTO visual_budget_holds VALUES(?,?,?,?)',day,'unsettled_inference',pending.id,now()),q(e,'UPDATE visual_state SET enabled=0 WHERE id=1')]);
  if(await q(e,'SELECT reason FROM visual_budget_holds WHERE day=?',day).first())throw new Error('VISUAL_BUDGET_UNKNOWN');
  if(kind==='vision'){
    // One atomic statement admits a product. Retries/second views keep its slot;
    // failures still count. Separate requests/isolates cannot admit product 11.
    await q(e,`INSERT OR IGNORE INTO visual_daily_products(day,pid) SELECT ?,? WHERE EXISTS(SELECT 1 FROM visual_daily_products WHERE day=? AND pid=?) OR (SELECT COUNT(*) FROM visual_daily_products WHERE day=?)<?`,day,pid,day,pid,day,VISUAL_DAILY_PRODUCTS).run();
    if(!await q(e,'SELECT pid FROM visual_daily_products WHERE day=? AND pid=?',day,pid).first())throw new Error('VISUAL_DAILY_PRODUCTS');
  }
  const charged=await q(e,`INSERT INTO visual_usage(day,calls) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1 WHERE calls<?`,day,VISUAL_DAILY_CALLS).run();
  if(!charged.meta.changes)throw new Error('VISUAL_FREE_QUOTA');
  const reserve=await q(e,`INSERT INTO visual_neuron_budget VALUES(?,?) ON CONFLICT(day) DO UPDATE SET charged=charged+excluded.charged WHERE charged+excluded.charged<=?`,day,VISUAL_REQUEST_RESERVE,VISUAL_DAILY_NEURONS).run();
  if(!reserve.meta.changes)throw new Error('VISUAL_FREE_QUOTA');
  const id=crypto.randomUUID(),started=Date.now();
  await q(e,'INSERT INTO visual_inference_usage VALUES(?,?,?,?,?,?,?,?)',id,now(),day,pid,index,kind,'attempt','{}').run();
  let timer,settled=false;try{
    let result=await Promise.race([e.AI.run(model,inputs,{returnRawResponse:true,signal:AbortSignal.timeout(22000)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('VISUAL_MODEL_TIMEOUT')),22000);})]);
    let headers=null,envelope=null;if(result instanceof Response){headers=result.headers;const raw=await result.json();if(!result.ok)throw new Error(String(raw.internalCode||raw.errors?.[0]?.code||result.status)+': '+String(raw.description||raw.errors?.[0]?.message||'AI unavailable'));envelope=raw;result=raw.result||raw;}
    const usage={...inferenceUsage(result,headers,model),model,request_id:e.AI.lastRequestId||null,elapsed_ms:Date.now()-started,provider_keys:Object.keys(result||{}).slice(0,20),meter_header_names:headers?[...headers.keys()].filter(n=>/neurons|usage|tokens|cf-ai/.test(n)).slice(0,20):[]};
    // Some native responses put metering beside `result`, not inside it.
    if(usage.provider_neurons===null&&envelope){const outer=inferenceUsage(envelope,headers,model);if(outer.provider_neurons!==null)Object.assign(usage,outer);}
    const measured=usage.provider_neurons;
    if(measured!==null){await q(e,'UPDATE visual_neuron_budget SET charged=charged+? WHERE day=?',measured-VISUAL_REQUEST_RESERVE,day).run();settled=true;}
    else await e.DB.batch([q(e,'INSERT OR IGNORE INTO visual_budget_holds VALUES(?,?,?,?)',day,'provider_meter_not_returned',id,now()),q(e,"UPDATE visual_state SET enabled=0,last_error='VISUAL_BUDGET_UNKNOWN' WHERE id=1")]);
    await q(e,"UPDATE visual_inference_usage SET outcome='success',usage=? WHERE id=?",JSON.stringify(usage),id).run();
    return {...result,visual_usage:usage};
  }catch(error){
    if(!settled)await e.DB.batch([q(e,'INSERT OR IGNORE INTO visual_budget_holds VALUES(?,?,?,?)',day,'inference_cost_unknown',id,now()),q(e,'UPDATE visual_state SET enabled=0 WHERE id=1')]);
    if(errorCode(error)==='VISUAL_FREE_QUOTA')await q(e,'UPDATE visual_neuron_budget SET charged=MAX(charged,?) WHERE day=?',VISUAL_DAILY_NEURONS,day).run();
    await q(e,'UPDATE visual_inference_usage SET outcome=?,usage=? WHERE id=?',errorCode(error),JSON.stringify({request_id:e.AI.lastRequestId||null,elapsed_ms:Date.now()-started}),id).run();throw error;
  }finally{clearTimeout(timer);}
}
export function visualInputs(bytes,group=null,{retry=false,mime='image/webp'}={}){
  // Only public photo bytes cross this binding; no API token or product title.
  let binary='';for(const b of bytes)binary+=String.fromCharCode(b);
  return {messages:[{role:'user',content:[{type:'text',text:visualPrompt(group,{retry})},{type:'image_url',image_url:{url:'data:'+mime+';base64,'+btoa(binary)}}]}],max_completion_tokens:900,temperature:0,chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_object'},store:false};
}
const modelText=r=>r?.response??r?.description??r?.choices?.[0]?.message?.content;
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
export async function visualRun(e,{fetcher=fetch,force=false,ts=now(),pid=null,maxImages=2}={}){
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
    if(pid!==null){const old=(await cachedProfiles(e,[pid])).get(pid);if(old&&ts-(old.image_verified_at||old.analyzed_at)<86400)return {state:'cached',pid};if(old)await q(e,"UPDATE visual_queue SET state='pending',retry_at=0 WHERE pid=?",pid).run();}
    const row=pid===null?await q(e,"SELECT * FROM visual_queue WHERE state='pending' AND retry_at<=? ORDER BY retry_at,queued_at DESC,pid LIMIT 1",ts).first():await q(e,"SELECT * FROM visual_queue WHERE pid=? AND state='pending' AND retry_at<=?",pid,ts).first();
    if(!row)return {state:'idle'};
    const previous=(await cachedProfiles(e,[row.pid])).get(row.pid);
    if(previous&&ts-(previous.image_verified_at||previous.analyzed_at)<86400){await q(e,"UPDATE visual_queue SET state='complete',error='' WHERE pid=?",row.pid).run();return {state:'cached',pid:row.pid};}
    const stored=await q(e,'SELECT data FROM scheduler_inventory WHERE pid=?',row.pid).first();
    if(!stored){await q(e,"UPDATE visual_queue SET state='skipped',error='VISUAL_NO_PRODUCT' WHERE pid=?",row.pid).run();return {state:'skipped',pid:row.pid};}
    const p=JSON.parse(stored.data),urls=photoURLs(p).slice(0,maxImages===1?1:2),analyses=[];
    try{
      if(!urls.length){await q(e,"UPDATE visual_queue SET state='skipped',error='VISUAL_NO_IMAGE' WHERE pid=?",row.pid).run();return {state:'skipped',pid:row.pid,error:'VISUAL_NO_IMAGE'};}
      for(const [index,url] of urls.entries()){
        let image;try{image=await imageBytes(url,fetcher);}catch(error){if(index)continue;throw error;}
        const cached=await q(e,"SELECT hash,analysis FROM visual_images WHERE hash=? AND json_extract(analysis,'$.version')=? AND json_extract(analysis,'$.model')=? LIMIT 1",image.hash,VISUAL_VERSION,VISUAL_MODEL).first();
        if(cached){const a=JSON.parse(cached.analysis);if(cached.hash===image.hash&&a.version===VISUAL_VERSION&&a.model===VISUAL_MODEL){a.image.url=url;a.image.index=index;for(const f of Object.values(a.fields))f.image_index=index;analyses.push(a);continue;}}
        const failure=await q(e,'SELECT failures FROM visual_format_failures WHERE pid=? AND image_index=? AND hash=? AND model=? AND version=?',row.pid,index,image.hash,VISUAL_MODEL,VISUAL_VERSION).first();
        if(failure?.failures>=2)throw new Error('VISUAL_FORMAT_RETRY_EXHAUSTED');
        try{
          const result=await infer(e,visualInputs(image.bytes,p.visual_group??null,{retry:!!failure?.failures,mime:image.mime}),{pid:row.pid,index}),text=modelText(result);
          const analysis=normalizeAnalysis(text,{url,hash:image.hash,image_index:index});
          if(Object.keys(analysis.fields).length<2)throw new Error('VISUAL_EMPTY_PROFILE');
          analysis.model=VISUAL_MODEL;
          analysis.image.usage=result.visual_usage;
          await q(e,'INSERT OR REPLACE INTO visual_images VALUES(?,?,?,?,?)',row.pid,index,url,image.hash,JSON.stringify(analysis)).run();analyses.push(analysis);
          // One inference/execution fits waitUntil's 30s grace. Resume a second
          // view next time using the durable first-image cache, never reinfer it.
          if(index===0&&urls.length>1)return {state:'partial',pid:row.pid,images_cached:1};
        }catch(error){
          if(['VISUAL_INVALID_JSON','VISUAL_INVALID_PROFILE'].includes(error.message)){
            await q(e,'INSERT INTO visual_format_failures VALUES(?,?,?,?,?,1) ON CONFLICT(pid,image_index,hash,model,version) DO UPDATE SET failures=failures+1',row.pid,index,image.hash,VISUAL_MODEL,VISUAL_VERSION).run();
            if(failure?.failures>=1)throw new Error('VISUAL_FORMAT_RETRY_EXHAUSTED');
          }
          if(index&&analyses.length)break;throw error;
        }
      }
      const profile=mergeAnalyses(analyses,ts,VISUAL_MODEL);
      profile.source_version=visualSourceVersion(p);profile.image_verified_at=ts;
      await e.DB.batch([q(e,'INSERT INTO visual_profiles(pid,version,analyzed_at,profile) VALUES(?,?,?,?) ON CONFLICT(pid) DO UPDATE SET version=excluded.version,analyzed_at=excluded.analyzed_at,profile=excluded.profile',row.pid,VISUAL_VERSION,ts,JSON.stringify(profile)),q(e,"UPDATE visual_queue SET state='complete',error='' WHERE pid=?",row.pid),q(e,"UPDATE visual_state SET last_success=?,last_error=CASE WHEN EXISTS(SELECT 1 FROM visual_budget_holds WHERE day=?) THEN 'VISUAL_BUDGET_UNKNOWN' ELSE '' END WHERE id=1",ts,new Date().toISOString().slice(0,10))]);
      await maintainVisualEvents(e,row.pid);
      console.log('VISUAL_CACHED',JSON.stringify({pid:row.pid,images:profile.images.length,features:profile.feature_keys.length}));
      return {state:'complete',pid:row.pid,title:p.title,profile};
    }catch(err){
      const code=errorCode(err),blocked=['VISUAL_BUDGET_UNKNOWN','VISUAL_MODEL_TERMS_REQUIRED','VISUAL_PAID_MODEL_REFUSED'].includes(code),quota=['VISUAL_BUDGET_UNKNOWN','VISUAL_FREE_QUOTA','VISUAL_DAILY_PRODUCTS'].includes(code);
      const tomorrow=new Date();tomorrow.setUTCHours(24,1,0,0);
      const retry=quota?Math.floor(tomorrow.getTime()/1000):ts+Math.min(21600,300*2**Math.min(6,row.attempts))+Math.floor(Math.random()*61);
      const exhausted=['VISUAL_FORMAT_RETRY_EXHAUSTED','VISUAL_EMPTY_PROFILE'].includes(code);
      await e.DB.batch([q(e,"UPDATE visual_queue SET attempts=attempts+1,retry_at=?,error=?,state=? WHERE pid=?",retry,code,exhausted||row.attempts>=4&&!quota&&!blocked?'skipped':'pending',row.pid),q(e,'UPDATE visual_state SET last_error=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END WHERE id=1',code,blocked?1:0)]);
      const provider=providerError(err);console.log('VISUAL_DEFERRED',code,JSON.stringify({type:provider.type,codes:provider.codes}));return {state:'deferred',pid:row.pid,error:code,retry_at:retry,provider};
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
    const terms=await q(e,"SELECT value FROM metadata WHERE key='visual_meta_terms'").first(),sample=await q(e,'SELECT value FROM metadata WHERE key=?',TEST_KEY).first();
    let meter=[];try{meter=(await q(e,'SELECT ts,pid,image_index,kind,outcome,usage FROM visual_inference_usage WHERE day=? ORDER BY ts DESC LIMIT 20',day).all()).results.map(r=>({...r,usage:JSON.parse(r.usage)}));}catch(error){if(!missing(error))throw error;}
    const budget=await q(e,'SELECT charged FROM visual_neuron_budget WHERE day=?',day).first();
    const budget_hold=await q(e,'SELECT reason,request_id,ts FROM visual_budget_holds WHERE day=?',day).first();
    const admitted=await q(e,'SELECT COUNT(*) n FROM visual_daily_products WHERE day=?',day).first();
    const coverage=await q(e,'SELECT COUNT(*) profiles FROM visual_profiles WHERE version=? AND json_extract(profile,\'$.model\')=?',VISUAL_VERSION,VISUAL_MODEL).first();
    const feedback=await q(e,"SELECT COUNT(*) events,COUNT(DISTINCT pid) products FROM visual_events WHERE kind IN ('like','dislike')").first();
    return {initialized:true,enabled:!!state.enabled,model:VISUAL_MODEL,terms:terms?JSON.parse(terms.value):null,sample:sample?JSON.parse(sample.value):null,meter,last_run:state.last_run,last_success:state.last_success,last_error:state.last_error,calls_today:usage?.calls||0,daily_call_limit:VISUAL_DAILY_CALLS,daily_product_limit:VISUAL_DAILY_PRODUCTS,products_today:admitted?.n||0,profiles:coverage?.profiles||0,real_feedback:feedback,daily_neuron_limit:VISUAL_DAILY_NEURONS,neurons_charged:budget?.charged||0,budget_hold,request_reserve:VISUAL_REQUEST_RESERVE,other_account_usage:'unknown',automatic_analysis_allowed:false,examples,next,insights:stats,note:'Наблюдения по реальным событиям, не причинный эффект. Интервал Wilson 95%; минимум20 наблюдений/5товаров и20 лайков/дизлайков. Self-confidence vision не калибрована. Неизвестные признаки не учитываются.'};
  }catch(error){if(missing(error))return {initialized:false,enabled:false,examples:[],insights:[]};throw error;}
}
export async function visualRoute(request,e,{json,fail}){
  const path=new URL(request.url).pathname;
  const response=data=>json({...data,d1:e.D1_METER?{...e.D1_METER,before_ledger_settlement:true}:null});
  if(path.endsWith('/status')&&request.method==='GET')return response(await visualStatus(e));
  if(path.endsWith('/photo')&&request.method==='GET'){
    const url=new URL(request.url),pid=Number(url.searchParams.get('pid')),index=Number(url.searchParams.get('index'));
    const sample=await q(e,'SELECT value FROM metadata WHERE key=?',TEST_KEY).first();
    if(!sample||!JSON.parse(sample.value).products.some(p=>p.pid===pid)||!Number.isInteger(index)||index<0||index>1)fail(403,'Фото доступно только для выбранного теста');
    const cached=await q(e,'SELECT url,hash FROM visual_images WHERE pid=? AND image_index=?',pid,index).first();if(!cached||!safeImage(cached.url))fail(404,'Фото ещё не анализировалось');
    const image=await imageBytes(cached.url,fetch);if(image.hash!==cached.hash)fail(409,'Исходное фото изменилось после анализа');
    return new Response(image.bytes,{headers:{'Content-Type':cached.url.endsWith('.png')?'image/png':cached.url.endsWith('.jpg')?'image/jpeg':'image/webp','Cache-Control':'no-store','X-Visual-Image-Hash':image.hash}});
  }
  if(path.endsWith('/accept-terms')&&request.method==='POST'){
    const data=await request.json();if(data.approval!==TERMS_APPROVAL)fail(400,'Нужно прямое разрешение владельца на конкретную модель');
    await ensureVisual(e);const accepted=await q(e,"SELECT value FROM metadata WHERE key='visual_meta_terms'").first();if(accepted)return response(JSON.parse(accepted.value));
    const lease=crypto.randomUUID(),ts=now(),acquired=await q(e,'UPDATE visual_state SET lease=?,expires=? WHERE id=1 AND expires<=?',lease,ts+180,ts).run();if(!acquired.meta.changes)fail(409,'Анализ уже выполняется');
    try{
      const result=await infer(e,{prompt:'agree'},{kind:'agreement',model:VISUAL_TERMS_MODEL}),receipt={state:'accepted',model:VISUAL_TERMS_MODEL,at:ts,approval:TERMS_APPROVAL,usage:result.visual_usage};
      await e.DB.batch([q(e,"INSERT OR IGNORE INTO metadata VALUES('visual_meta_terms',?)",JSON.stringify(receipt)),q(e,"UPDATE visual_state SET last_error='' WHERE id=1 AND last_error='VISUAL_MODEL_TERMS_REQUIRED'")]);
      return response(receipt);
    }finally{await q(e,'UPDATE visual_state SET expires=0,lease=NULL WHERE id=1 AND lease=?',lease).run();}
  }
  if(path.endsWith('/sample')&&request.method==='POST'){
    await ensureVisual(e);const existing=await q(e,'SELECT value FROM metadata WHERE key=?',TEST_KEY).first();if(existing)return response(JSON.parse(existing.value));
    // Freeze exactly THREE existing ready products. Retry never expands the sample.
    const candidates=(await q(e,"SELECT pid,data,queued_at FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at DESC LIMIT 60").all()).results.map(r=>({...r,p:JSON.parse(r.data)})).filter(r=>photoURLs(r.p).length);
    const selected=[],take=predicate=>{const r=candidates.find(r=>!selected.includes(r)&&predicate(r.p));if(r)selected.push(r);};
    take(p=>/футбол|плать|блуз|джинс|брюк|свит|куртк|dress|shirt/i.test(p.title||''));
    take(p=>/кроссов|кед|ботин|туфл|sneaker|shoe|сумк|рюкзак/i.test(p.title||''));
    while(selected.length<3){const n=candidates.find(r=>!selected.includes(r));if(!n)break;selected.push(n);}
    if(selected.length!==3)fail(409,'Нужны три реальные карточки с фото в текущей очереди');
    const sample={id:TEST_KEY,at:now(),products:selected.map(r=>({pid:r.pid,title:r.p.title,category:r.p.category||null,price:r.p.price,image:r.p.image,url:r.p.url||`https://www.wildberries.ru/catalog/${r.pid}/detail.aspx`}))};
    await e.DB.batch([q(e,'INSERT OR IGNORE INTO metadata VALUES(?,?)',TEST_KEY,JSON.stringify(sample)),...selected.map(r=>q(e,'INSERT OR IGNORE INTO visual_queue(pid,queued_at) VALUES(?,?)',r.pid,r.queued_at))]);
    return response(JSON.parse((await q(e,'SELECT value FROM metadata WHERE key=?',TEST_KEY).first()).value));
  }
  if(path.endsWith('/run')&&request.method==='POST'){
    // Keep first-run DDL separate from inference under the Free subrequest cap.
    if(!await q(e,"SELECT value FROM metadata WHERE key='visual_schema_v1'").first()){await ensureVisual(e);return response({state:'initialized',enabled:false});}
    const data=await request.json(),sample=await q(e,'SELECT value FROM metadata WHERE key=?',TEST_KEY).first();
    if(sample){if(!Number.isSafeInteger(data.pid)||!JSON.parse(sample.value).products.some(p=>p.pid===data.pid))fail(409,'Тест ограничен тремя выбранными товарами');}
    return response(await visualRun(e,{force:true,pid:Number.isSafeInteger(data.pid)?data.pid:null}));
  }
  if(path.endsWith('/activate')&&request.method==='POST'){
    // The owner explicitly required real sample review + free-budget evidence
    // BEFORE mass enrichment. No default, Cron or successful model call unlocks it.
    const verified=await q(e,"SELECT value FROM metadata WHERE key='visual_free_verification'").first();
    const proof=verified?JSON.parse(verified.value):null;
    if(!proof?.ok||proof.version!==VISUAL_VERSION||proof.model!==VISUAL_MODEL||!Number.isSafeInteger(proof.products_reviewed)||proof.products_reviewed<10||proof.owner_reviewed!==true||proof.staging_verified!==true||proof.usage_source!=='provider'||!Number.isFinite(proof.neurons)||proof.neurons<0||proof.neurons>VISUAL_DAILY_NEURONS)fail(409,'Сначала подтвердите качество десяти реальных профилей, staging и измеренный бесплатный расход');
    const learning=await q(e,'SELECT config FROM learning_state WHERE id=1').first();if(!learning||JSON.parse(learning.config).mode!=='SHADOW')fail(409,'Ограниченное внедрение требует River SHADOW');
    await ensureVisual(e);if(!await q(e,"SELECT pid FROM visual_profiles WHERE version=? AND json_extract(profile,'$.model')=? AND json_array_length(json_extract(profile,'$.feature_keys'))>=3 LIMIT 1",VISUAL_VERSION,VISUAL_MODEL).first())fail(409,'Сначала подтвердите полезный реальный visual profile');
    // A reviewed staging receipt measures our calls, not the remaining budget
    // of the entire account. Do not unlock automatic spending on that basis.
    fail(409,'Автоматический анализ выключен: точный остаток бесплатной квоты аккаунта не подтверждён');
  }
  if(path.endsWith('/review')&&request.method==='POST'){
    // Protected by the existing scheduler sync/owner authorization in worker.mjs.
    // Only an explicit reviewed receipt unlocks the limited rollout, never Cron.
    const data=await request.json(),s=data.staging;
    if(data.approval!=='visual-v2-reviewed-10-free'||!/^[a-f0-9]{64}$/.test(data.report_sha256||'')||data.products_reviewed!==10||!Number.isFinite(data.review_neurons)||data.review_neurons<0||data.review_neurons>VISUAL_DAILY_NEURONS||s?.ok!==true||s.model!==VISUAL_MODEL||s.version!==VISUAL_VERSION||s.usage_source!=='provider'||!Number.isFinite(s.neurons)||s.neurons<=0||s.neurons>VISUAL_DAILY_NEURONS||s.cache_extra_calls!==0||!Number.isFinite(s.d1_reads)||!Number.isFinite(s.d1_writes)||s.d1_reads<=0||s.d1_writes<=0||typeof s.deployment_id!=='string'||s.deployment_id.length>80)fail(409,'Нужны явное подтверждение 10 фото и измеренный staging-тест binding, кэша и базы');
    await ensureVisual(e);
    const day=new Date().toISOString().slice(0,10);
    if(data.day!==day||!Number.isFinite(data.external_neurons_today)||data.external_neurons_today<s.neurons||data.external_neurons_today>VISUAL_DAILY_NEURONS)fail(409,'Укажите измеренный расход staging и предыдущих тестов за текущий UTC-день');
    const staging={ok:true,model:VISUAL_MODEL,version:VISUAL_VERSION,usage_source:'provider',neurons:s.neurons,cache_extra_calls:0,d1_reads:s.d1_reads,d1_writes:s.d1_writes,deployment_id:s.deployment_id};
    const proof={ok:true,version:VISUAL_VERSION,model:VISUAL_MODEL,products_reviewed:10,owner_reviewed:true,staging_verified:true,usage_source:'provider',neurons:data.review_neurons,report_sha256:data.report_sha256,staging,at:now()};
    const ledgerKey='visual_external_meter:'+day+':'+s.deployment_id;
    await e.DB.batch([
      q(e,`INSERT INTO visual_neuron_budget(day,charged) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM metadata WHERE key=?) ON CONFLICT(day) DO UPDATE SET charged=charged+excluded.charged`,day,data.external_neurons_today,ledgerKey),
      q(e,'INSERT OR IGNORE INTO metadata VALUES(?,?)',ledgerKey,JSON.stringify({neurons:data.external_neurons_today,source:'provider',at:now()})),
      q(e,"INSERT INTO metadata VALUES('visual_free_verification',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(proof))
    ]);return response({reviewed:true});
  }
  fail(405,'Метод не поддерживается');
}
