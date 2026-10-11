// Native runtime: D1 bindings, existing claims and expiring leases; no CI token.
import {ensureScheduler,validateSchedule,schedulerRoute} from './scheduler_api.mjs';
import {safeImage,normalize} from './domain.mjs';
import {shadowChoice,explorationQuery} from './learning.mjs';
import {repairReactions} from './feedback.mjs';
import {searchDue,searchBackoff,retryAfter,nextSearchDelay} from './search_backoff.mjs';
import {withReadBudget} from './read_guard.mjs';
import {queryRules,discoveryQueries} from './query_control.mjs';
import {recordDiscovery} from './admin_history.mjs';
import {selectionReason,diverseChoice} from './selection_policy.mjs';
const q=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const sec=()=>Math.floor(Date.now()/1000);
const topic=p=>String(p.query||p.category||p.cat||'').trim().toLowerCase();
const titleKey=p=>String(p.title||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const escape=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function runtimeError(error){
  const message=String(error?.message||'');
  // Whitelisted error classes only: never persist URLs, tokens or payloads.
  const code=/too many|maximum.*quer|query.*limit/i.test(message)?'D1_QUERY_LIMIT':/D1.*daily|free tier/i.test(message)?'D1_DAILY_LIMIT':/D1_ERROR|SQLITE|no such|constraint/i.test(message)?'D1_SQL_ERROR':/CPU|execution time/i.test(message)?'WORKER_EXECUTION_LIMIT':/Telegram send outcome/i.test(message)?'TELEGRAM_UNKNOWN':/Missing Telegram/i.test(message)?'TELEGRAM_SECRET_MISSING':/Telegram rejected/i.test(message)?'TELEGRAM_REJECTED':'RUNTIME_UNEXPECTED';
  console.error('NATIVE_RUNTIME_ERROR',JSON.stringify({code,type:String(error?.name||'Error').slice(0,60),...(code==='D1_SQL_ERROR'?{detail:message.replace(/https?:\/\/\S+|(?:bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi,'[hidden]').slice(0,160)}:{})}));return code;
}
const pattern=['bags','men','women','women','neutral','belts','women','men','women','women','caps','men','women','women','neutral','jewelry','women','men','women','women'];
const women=/женск|плать|юбк|блуз|сумк|космет|макияж|серьг|кольц|туфл|колгот|леггин|бюстг|купальник/;
const accessories={bags:/сумк|рюкзак|клатч|кошел/,belts:/ремн|реме|пояс/,caps:/кепк|бейсбол|панам|шляп/,jewelry:/украшен|серьг|кольц|брасл|цепоч|ожерел|кулон|брош/};
function groups(p){const text=[p.title,p.query,p.category].join(' ').toLowerCase(),audience=text.includes('женск')?'women':text.includes('мужск')?'men':women.test(text)?'women':'neutral',accessory=Object.keys(accessories).find(k=>accessories[k].test(text));return {audience,accessory};}
const formatters=new Map();
export function postingWindow(schedule,now=sec()){
  const s=validateSchedule(schedule),key=s.timezone;
  if(!formatters.has(key))formatters.set(key,new Intl.DateTimeFormat('en-GB',{timeZone:key,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
  const p=Object.fromEntries(formatters.get(key).formatToParts(new Date(now*1000)).map(x=>[x.type,x.value]));
  const clock=p.hour+':'+p.minute,weekday=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(p.weekday);
  const quiet=s.quiet_enabled&&(s.quiet_start<s.quiet_end?s.quiet_start<=clock&&clock<s.quiet_end:clock>=s.quiet_start||clock<s.quiet_end);
  return {allowed:s.enabled&&!s.paused&&s.weekdays.includes(weekday)&&!quiet,clock,date:p.year+'-'+p.month+'-'+p.day,timezone:key,quiet};
}
export function postDue(s,last,now,manual=false){
  if(!postingWindow(s,now).allowed||now<last+s.min_post_gap_minutes*60)return false;
  if(manual)return true; // Owner request, never bypasses safety gap/quiet hours/caps.
  if(s.mode==='times'){
    const wall=postingWindow(s,now).clock;
    // Catch a delayed minute execution without treating every later tick as due.
    const previous=postingWindow(s,last||now-86400),current=postingWindow(s,now);
    return s.post_times.some(t=>t<=wall&&(previous.date!==current.date||previous.clock<t));
  }
  const jitter=s.natural_interval_enabled?((last%Math.max(1,2*s.jitter_minutes+1))-s.jitter_minutes)*60:0;
  return now>=last+Math.max(s.min_post_gap_minutes*60,s.post_interval_minutes*60+jitter);
}
export function choose(rows,recent,total=0,policy={}){
  const counts=new Map();for(const p of recent)counts.set(p.topic,(counts.get(p.topic)||0)+1);
  const eligible=rows.filter(p=>(counts.get(p.topic)||0)<8&&!recent.some(r=>r.title_key===p.title_key)&&!selectionReason(JSON.parse(p.data),policy));
  const custom=diverseChoice(eligible,recent,policy);if(custom!==undefined)return custom;
  const target=pattern[total%pattern.length],fallback={women:['women','neutral','men'],men:['men','women','neutral'],neutral:['neutral','women','men']}[target]||[target,'women','neutral','men'];
  for(const group of [...fallback,'any']){
    const matches=eligible.filter(row=>{const p=groups(JSON.parse(row.data));return group==='any'||(Object.hasOwn(accessories,group)?p.accessory===group&&p.audience==='women':!p.accessory&&p.audience===group);});
    if(matches.length){
      const verified=matches.filter(p=>p.checked_at>0&&safeImage(JSON.parse(p.data).image));
      return verified.find(p=>p.topic!==recent.at(-1)?.topic)||verified[0]||matches.find(p=>p.topic!==recent.at(-1)?.topic)||matches[0];
    }
  }return null;
}
async function runtime(env,body){
  const request=new Request('https://internal/api/scheduler/runtime',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const result=await schedulerRoute(request,env,{payload:r=>r.json(),json:Response.json,fail:(status,message)=>{throw new Error('Scheduler validation '+status);}});
  return result.json();
}
async function status(env,patch){await q(env,"UPDATE scheduler_config SET status=json_patch(status,?) WHERE id=1",JSON.stringify(patch)).run();}
async function source(url,fetcher){
  const r=await fetcher(url,{headers:{Accept:'application/json','Accept-Language':'ru-RU,ru;q=0.9'},redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!r.ok){const error=new Error('WB HTTP '+r.status);error.status=r.status;error.retry_after=retryAfter(r.headers.get('Retry-After'),sec());
    // Provenance only: never persist response bodies, cookies or credentials.
    error.upstream={host:new URL(url).hostname,path:new URL(url).pathname,status:r.status,retry_after:error.retry_after,server:String(r.headers.get('server')||'').slice(0,80),content_type:String(r.headers.get('content-type')||'').slice(0,80),cf_ray:Boolean(r.headers.get('cf-ray'))};throw error;}return r.json();
}
const common={appType:'1',curr:'rub',dest:'-1257786',spp:'30',lang:'ru'};
function wbURL(kind,params={}){const url=new URL(kind==='search'?'https://search.wb.ru/exactmatch/ru/common/v9/search':'https://card.wb.ru/cards/v4/detail');url.search=new URLSearchParams({...common,...params}).toString();return url.href;}
export function discoveryParams(policy,query,cursor){
  // "New to our database" does not mean an unrated, just-created WB listing.
  // Rotate pages/queries but search established goods, then apply the unchanged
  // local quality filters and independently re-check detailed current prices.
  return {query,page:String(1+Math.floor(cursor/policy.queries.length)%5),sort:cursor%2?'popular':'priceup',resultset:'catalog',...(policy.max_price>0?{priceU:`0;${Math.floor(policy.max_price*100)}`}:{})};
}
function rejectedCardReason(card,policy){
  const raw=cardDeal(card,{min_rating:0,min_feedbacks:0});
  if(!raw)return 'missing_price_or_stock';
  if(policy.max_price&&raw.product>policy.max_price)return 'price';
  if(raw.rating<Number(policy.min_rating??4.3))return 'rating';
  if(raw.feedbacks<Number(policy.min_feedbacks??20))return 'reviews';
  return 'blocked';
}
export function cardDeal(card,policy={}){
  const prices=(card?.sizes||[]).map(s=>s.price).filter(p=>p?.product>0&&p?.basic>=p.product);
  if(!card?.id||!card.name||!prices.length)return null;
  const stock=(card.sizes||[]).filter(s=>s.qty!=null);if(stock.length&&!stock.some(s=>s.qty>0))return null;
  const best=prices.reduce((a,b)=>a.product<b.product?a:b),price=Math.floor(best.product/100),rating=Number(card.reviewRating||card.rating||0);
  const p={id:Number(card.id),title:String(card.name).slice(0,200),brand:String(card.brand||'').slice(0,100),product:price,basic:price,discount:0,selection_mode:'good_price',rating,feedbacks:Number(card.feedbacks||card.nmFeedbacks||0),category:String(card.subjectName||card.subject||'другое')};
  const text=(p.title+' '+p.category).toLowerCase();
  if(price<=0||policy.max_price&&price>policy.max_price||rating<Number(policy.min_rating??4.3)||p.feedbacks<Number(policy.min_feedbacks??20))return null;
  if((policy.blocked_words||[]).some(w=>text.includes(String(w).toLowerCase())))return null;
  if((policy.blacklist||[]).some(w=>String(w)===String(p.id)||p.brand.toLowerCase().includes(String(w).toLowerCase())))return null;
  return selectionReason(p,policy)?null:p;
}
async function imageFor(env,p,fetcher,options={}){
  const vol=Math.floor(p.id/100000),part=Math.floor(p.id/1000);
  // Reuse a genuinely observed shard for this volume, but verify this product's
  // image with a real GET. This is a hint, never evidence that an image exists.
  // An observed image needs no catalogue lookup at all. Missing images use
  // primary-key/range probes, never an OR + computed sort of the catalogue.
  let stored=null;
  if(!safeImage(p.image)){
    stored=await q(env,'SELECT id,data FROM products WHERE id=?',p.id).first();
    if(!safeImage(stored?JSON.parse(stored.data).image:'')){
      const hints=(await q(env,'SELECT id,data FROM products WHERE id>=? AND id<? LIMIT 8',vol*100000,(vol+1)*100000).all()).results;
      stored=hints.find(row=>safeImage(JSON.parse(row.data).image))||stored;
    }
  }
  const storedImage=safeImage(stored?JSON.parse(stored.data).image:'');
  const hint=storedImage?.match(/^https:\/\/(basket-\d+\.wbbasket\.ru)\//)?.[1];
  const known=safeImage(p.image)||(stored?.id===p.id?storedImage:hint?`https://${hint}/vol${vol}/part${part}/${p.id}/images/big/1.webp`:'');
  const urls=known?[known]:[];
  if(!known){
    // Sparse catalogue: another nmId in this exact 100k volume usually does
    // not exist. Probe a few genuinely observed neighbouring shards first.
    // Four PK range seeks, LIMIT 8 each; never scan/sort the whole catalogue.
    const neighbours=(await q(env,`SELECT id,data FROM (SELECT id,data FROM products WHERE id<=? ORDER BY id DESC LIMIT 8)
      UNION ALL SELECT id,data FROM (SELECT id,data FROM products WHERE id>? ORDER BY id LIMIT 8)
      UNION ALL SELECT pid,data FROM (SELECT pid,data FROM scheduler_deliveries WHERE pid<=? ORDER BY pid DESC LIMIT 8)
      UNION ALL SELECT pid,data FROM (SELECT pid,data FROM scheduler_deliveries WHERE pid>? ORDER BY pid LIMIT 8)`,p.id,p.id,p.id,p.id).all()).results;
    const hosts=[];for(const row of neighbours.sort((a,b)=>Math.abs(a.id-p.id)-Math.abs(b.id-p.id))){
      const host=safeImage(JSON.parse(row.data).image)?.match(/^https:\/\/(basket-\d+\.wbbasket\.ru)\//)?.[1];
      if(host&&!hosts.includes(host))hosts.push(host);if(hosts.length===3)break;
    }
    for(const host of hosts)urls.push(`https://${host}/vol${vol}/part${part}/${p.id}/images/big/1.webp`);
  }
  const start=Math.max(1,Number(p.photo_probe||1));
  for(let host=start;host<Math.min(start+6,51);host++)urls.push(`https://basket-${String(host).padStart(2,'0')}.wbbasket.ru/vol${vol}/part${part}/${p.id}/images/big/1.webp`);
  let probes=0;for(const url of urls){
    if(options.deadline&&Date.now()>=options.deadline||options.maxProbes&&probes>=options.maxProbes)break;probes++;
    try{const r=await fetcher(url,{signal:AbortSignal.timeout(3000)});const okay=r.ok&&r.headers.get('content-type')?.startsWith('image/');await r.body?.cancel();if(okay)return {image:url};}catch{}
  }
  return {image:'',photo_probe:start+6,photo_exhausted:start+6>50};
}
export async function readHeader(env){
  const row=await q(env,`SELECT c.*,(SELECT data FROM scheduler_policy WHERE id=1) AS policy,
      (SELECT MAX(ts) FROM scheduler_posts) AS last_post,
      (SELECT ready FROM scheduler_counts WHERE id=1) AS queue_size FROM scheduler_config c WHERE id=1`).first();
  return {row,s:validateSchedule(JSON.parse(row.data)),policy:JSON.parse(row.policy||'{}'),last:Number(row.last_post||0),count:row.queue_size};
}
async function selectionState(env,header,preflight=false){
  const [ready,recent]=await Promise.all([
    q(env,`SELECT * FROM scheduler_inventory WHERE state='ready' AND expires>? AND retry_at<=? ${preflight?'AND checked_at<?':''}
      AND NOT EXISTS(SELECT 1 FROM scheduler_claims c WHERE c.pid=scheduler_inventory.pid AND c.ts>? AND c.status IN ('pending','error','success'))
      AND NOT EXISTS(SELECT 1 FROM scheduler_posts p WHERE p.pid=scheduler_inventory.pid AND p.ts>?)
      ORDER BY queued_at,pid LIMIT 300`,sec(),sec(),...(preflight?[sec()-1800]:[]),sec()-7*86400,sec()-7*86400).all(),
    q(env,'SELECT topic,title_key,ts,data FROM scheduler_deliveries WHERE ts>? ORDER BY ts DESC LIMIT 4032',sec()-86400).all()]);recent.results.reverse();
  return {...header,ready:ready.results,recent:recent.results};
}
async function readState(env){
  const header=await readHeader(env);return selectionState(env,header);
}
export async function bootstrap(env,data){
  await ensureScheduler(env);
  // Called only behind the existing sync-key authentication. No credential fields
  // are accepted or persisted; the channel ID is configuration, not a bot token.
  if(!Array.isArray(data.queue)||data.queue.length>300||!data.policy||!Array.isArray(data.posts)||data.posts.length>3000)throw new Error('Invalid bootstrap');
  const raw=data.policy,policy={chat_id:String(raw.chat_id||''),queries:(raw.queries||[]).filter(x=>typeof x==='string'&&x.length<=100).slice(0,100),max_price:Number(raw.max_price||0),min_rating:Number(raw.min_rating??4.3),min_feedbacks:Number(raw.min_feedbacks??20),blacklist:(raw.blacklist||[]).map(String).slice(0,200),blocked_words:(raw.blocked_words||[]).map(String).slice(0,200),disabled_topics:(raw.disabled_topics||[]).map(x=>String(x).toLowerCase()).slice(0,200),total_posts:Number(raw.total_posts||0)};
  if(!/^(?:-?\d{5,20}|@[a-zA-Z0-9_]{5,})$/.test(policy.chat_id)||!policy.queries.length||!Number.isFinite(policy.max_price)||policy.max_price<0)throw new Error('Invalid channel policy');
  const now=sec(),counts=new Map(),queue=data.queue.filter(p=>{try{normalize(p);}catch{return false;}const t=topic(p);if((counts.get(t)||0)>=8)return false;counts.set(t,(counts.get(t)||0)+1);return true;});
  const posts=data.posts.filter(p=>Number.isSafeInteger(p.pid)&&p.pid>0&&Number.isSafeInteger(p.ts)&&p.ts>now-14*86400&&p.ts<=now);
  await env.DB.batch([
    q(env,'INSERT OR REPLACE INTO scheduler_policy(id,data) VALUES(1,?)',JSON.stringify(policy)),
    q(env,"INSERT OR IGNORE INTO scheduler_posts(pid,ts) SELECT json_extract(value,'$.pid'),json_extract(value,'$.ts') FROM json_each(?)",JSON.stringify(posts)),
    q(env,`INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,json_extract(value,'$.checked_at'),?
      FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=json_extract(value,'$.id') AND ts>?)
      ON CONFLICT(pid) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at
      WHERE scheduler_inventory.state='ready' AND excluded.checked_at>scheduler_inventory.checked_at`,now,now+72*3600,JSON.stringify(queue.map(p=>({id:p.id,data:JSON.stringify(p),topic:topic(p),title_key:titleKey(p),checked_at:p.image&&Number.isSafeInteger(p.checked_at)&&p.checked_at<=now&&p.checked_at>now-300?p.checked_at:0}))),now-7*86400),
    q(env,`INSERT OR IGNORE INTO scheduler_deliveries(pid,ts,topic,title_key,data)
      SELECT json_extract(value,'$.pid'),json_extract(value,'$.ts'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),json_extract(value,'$.data') FROM json_each(?)`,JSON.stringify(posts.map(p=>({...p,topic:topic(p),title_key:titleKey(p),data:JSON.stringify(p)}))))
  ]);
  await status(env,{bootstrap_at:now,native_configured:true});return {ok:true,queue_size:(await readState(env)).count};
}
async function validateQueued(env,item,policy,fetcher){
  const saved=JSON.parse(item.data),now=sec();let card,unavailable=false;
  try{const response=await source(wbURL('cards',{nm:String(item.pid)}),fetcher);card=(response.products||response.data?.products||[]).find(p=>Number(p.id)===item.pid);}
  catch(error){unavailable=true;if(now-item.checked_at>6*3600||!saved.image){await q(env,"UPDATE scheduler_inventory SET retry_at=?,data=json_set(data,'$.validation_error',?) WHERE pid=?",now+300,/^WB HTTP \d{3}$/.test(error.message)?error.message:'WB unavailable',item.pid).run();return null;}}
  let deal=card?cardDeal(card,policy):unavailable&&now-item.checked_at<=6*3600?saved:null;
  if(!deal||deal.product>saved.product*1.1){
    const raw=cardDeal(card,{min_rating:0,min_feedbacks:0});
    const reason=!card&&!unavailable?'WB_CARD_MISSING':!deal?'CARD_FILTER':'PRICE_INCREASE';
    await q(env,"UPDATE scheduler_inventory SET state='rejected',data=json_set(data,'$.validation_error',?,'$.validation_price',?) WHERE pid=?",reason,raw?.product??null,item.pid).run();return null;
  }
  deal={...deal,query:saved.query||'',image:saved.image||'',photo_probe:saved.photo_probe||1};
  deal={...deal,...await imageFor(env,deal,fetcher)};
  if(!deal.image){deal.validation_error=deal.photo_exhausted?'PHOTO_EXHAUSTED':'PHOTO_SHARD_PENDING';await q(env,"UPDATE scheduler_inventory SET data=?,retry_at=?,state=? WHERE pid=?",JSON.stringify(deal),now+300,deal.photo_exhausted?'rejected':'ready',item.pid).run();return null;}
  await q(env,'UPDATE scheduler_inventory SET data=?,checked_at=? WHERE pid=?',JSON.stringify(deal),now,item.pid).run();return deal;
}
async function publish(env,state,fetcher){
  const owner=crypto.randomUUID(),lock=await runtime(env,{op:'acquire',kind:'post',owner,ttl:120});
  if(!lock.ok)return {result:'lock_busy'};
  try{
    const latest=await q(env,'SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1').first();
    let current={...state,s:validateSchedule(JSON.parse(latest.data)),last:Number(latest.last_post||0),ready:[...state.ready]};
    const manual=current.row.post_request;
    const requested=JSON.parse(current.row.status||'{}');
    const preferred=manual&&requested.admin_product_request===manual?Number(requested.admin_product_id):0;
    const cancelPreferred=async()=>{await runtime(env,{op:'consume',kind:'post',owner,request_id:manual});await status(env,{admin_product_result:'Товар не прошёл проверку или уже выбыл. Другая вещь вместо него не отправлена.',admin_product_id:null,admin_product_request:null});};
    if(!postDue(current.s,current.last,sec(),Boolean(manual)))return {result:'not_due'};
    if(!env.TG_BOT_TOKEN||!current.policy.chat_id)throw new Error('Missing Telegram runtime secret');
    // A bad card cannot monopolize a due tick. Bound both work and wall time;
    // discovery/maintenance use a different invocation, not this publication.
    const started=Date.now();let consumed=false;
    for(let attempt=0;attempt<3&&Date.now()-started<45000;attempt++){
      if(attempt>0&&Number(env.D1_METER?.queries||0)>26)break;
      const eligible=preferred?current.ready.filter(r=>r.pid===preferred):current.ready;
      const item=choose(eligible,current.recent,current.policy.total_posts+current.recent.length,current.policy);
      if(!item){if(preferred)await cancelPreferred();return {result:'no_eligible_product'};}
      current.ready=current.ready.filter(p=>p.pid!==item.pid);
      const now=sec();
      await status(env,{last_post_attempt:now,selected_product:item.pid});
      const deal=await validateQueued(env,item,current.policy,fetcher);if(!deal){if(preferred){await cancelPreferred();return {result:'requested_product_invalid'};}continue;}
      // Re-read pause/timezone after external calls, immediately before claim/send.
      const latest=await q(env,'SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1').first();
      current.s=validateSchedule(JSON.parse(latest.data));current.last=Number(latest.last_post||0);if(!postDue(current.s,current.last,sec(),Boolean(manual)))return {result:'not_due'};
      const claim=await runtime(env,{op:'claim',owner,product_id:item.pid,request_id:manual||undefined});if(!claim.ok){
        // A prior delivery claim (including uncertain/error) is a per-product
        // tombstone. Never delete it or blindly resend, but don't let that card
        // remain the preferred ready candidate and freeze the entire channel.
        // Hour/day caps, a live lease or a global safety gap must NOT evict cards.
        const previousClaim=await q(env,'SELECT status,ts FROM scheduler_claims WHERE pid=?',item.pid).first();
        if(previousClaim&&previousClaim.ts>=sec()-7*86400){
          await q(env,"UPDATE scheduler_inventory SET state=? WHERE pid=? AND state='ready'",previousClaim.status==='success'?'posted':'uncertain',item.pid).run();
          continue;
        }
        return {result:claim.reason};
      }
      if(manual&&!consumed){if(!(await runtime(env,{op:'consume',kind:'post',owner,request_id:manual})).ok){await runtime(env,{op:'complete',owner,product_id:item.pid,success:false});return {result:'request_already_consumed'};}consumed=true;}
      // Observe only the final valid selection, never every rejected candidate.
      if(JSON.parse(current.row.status||'{}').learning_initialized)try{await shadowChoice(env,current.ready.concat(item).filter(r=>(current.recent.filter(p=>p.topic===r.topic).length)<8&&!current.recent.some(p=>p.title_key===r.title_key)),item,sec(),current.s.timezone);}catch{console.log('LEARNING_SHADOW unavailable; LEGACY retained');}
      const caption=`✨ <b>${escape(deal.title)}</b>\n\n💰 Сейчас: <b>${deal.product} ₽</b>\n⭐ ${deal.rating} · ${deal.feedbacks} отзывов\n${escape(deal.brand)}\n\nЦена проверена перед публикацией. На WB она может меняться.`,url=`https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;
      const launch=env.MINIAPP_LINK_MODE==='startapp'?'startapp':'start',miniapp=`https://t.me/${env.MINIAPP_BOT_USERNAME||'WbPodborr_bot'}?${launch}=`;
      const reply_markup={inline_keyboard:[[{text:'Открыть на WB',url}],[{text:'👍 0',callback_data:'l'+deal.id},{text:'👎 0',callback_data:'d'+deal.id},{text:'🛒 Купил 0',callback_data:'b'+deal.id}],[{text:'🔖 Сохранить',url:miniapp+'save_'+deal.id},{text:'✨ Собрать образ',url:miniapp+'look_'+deal.id}]]};
      let result;
      try{
        const endpoint=`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`;
        const r=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:current.policy.chat_id,photo:deal.image,caption,parse_mode:'HTML',reply_markup}),signal:AbortSignal.timeout(15000)});result=await r.json();
        if(!result.ok){
          const description=String(result.description||'').replace(/https?:\/\/\S+|\d{6,}:[a-zA-Z0-9_-]{20,}/g,'[hidden]').slice(0,180);
          await status(env,{telegram_error_code:Number(result.error_code||0),telegram_error_description:description});
          // A definitive URL/photo rejection means NO message was created.
          // Upload the checked bytes instead of asking Telegram to fetch WB's
          // CDN. Never retry an ambiguous timeout or permission/rate-limit error.
          if(result.error_code===400&&/http|webpage|image|photo|file identifier/i.test(description)){
            const photo=await fetcher(deal.image,{signal:AbortSignal.timeout(5000)});
            if(photo.ok&&photo.headers.get('content-type')?.startsWith('image/')){
              const reader=photo.body.getReader(),chunks=[];let bytes=0;
              while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>5*1024*1024){await reader.cancel();throw new Error('Photo exceeds upload cap');}chunks.push(value);}
              const form=new FormData();form.set('chat_id',current.policy.chat_id);form.set('caption',caption);form.set('parse_mode','HTML');form.set('reply_markup',JSON.stringify(reply_markup));
              form.set('photo',new Blob(chunks,{type:photo.headers.get('content-type')}),'product-image');
              result=await (await fetcher(endpoint,{method:'POST',body:form,signal:AbortSignal.timeout(15000)})).json();
              await status(env,{last_photo_delivery:'multipart',last_photo_fallback_reason:description});
            }
          }
        }
      }
      catch{await runtime(env,{op:'complete',owner,product_id:item.pid,success:false});await q(env,"UPDATE scheduler_inventory SET state='uncertain' WHERE pid=?",item.pid).run();throw new Error('Telegram send outcome unknown; automatic duplicate retry suppressed');}
      if(!result.ok){
        const rejectedPhoto=result.error_code===400&&/http|webpage|image|photo|file identifier/i.test(String(result.description||''));
        await status(env,{telegram_error_code:Number(result.error_code||0),telegram_error_description:String(result.description||'').replace(/https?:\/\/\S+|\d{6,}:[a-zA-Z0-9_-]{20,}/g,'[hidden]').slice(0,180)});
        await runtime(env,{op:'complete',owner,product_id:item.pid,success:false,rejected:rejectedPhoto});
        await q(env,"UPDATE scheduler_inventory SET state=?,retry_at=? WHERE pid=?",rejectedPhoto?'rejected':'uncertain',sec()+Math.max(300,Number(result.parameters?.retry_after||0)),item.pid).run();
        if(rejectedPhoto)continue;throw new Error('Telegram rejected publication');
      }
      const message_id=result.result?.message_id;if(!Number.isInteger(message_id))throw new Error('Telegram receipt missing');
      // If persistence fails after send, pending claim still prevents duplicates.
      await runtime(env,{op:'complete',owner,product_id:item.pid,success:true});
      const sent=sec();await env.DB.batch([
        q(env,"UPDATE scheduler_inventory SET state='posted' WHERE pid=?",item.pid),
        q(env,'INSERT OR IGNORE INTO scheduler_deliveries(pid,ts,message_id,topic,title_key,data) VALUES(?,?,?,?,?,?)',item.pid,sent,message_id,item.topic,item.title_key,JSON.stringify(deal)),
        q(env,'INSERT INTO products(id,data,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at',deal.id,JSON.stringify(normalize({...deal,checked_at:sent})),sent)
      ]);
      await status(env,{last_post_success:sent,last_post:sent,last_message_id:message_id,last_error:'',last_error_code:'',telegram_error_code:0,telegram_error_description:'',error:'',post_retry_at:0,next_post:sent+current.s.post_interval_minutes*60,...(preferred?{admin_product_result:'✅ Товар '+item.pid+' опубликован, сообщение '+message_id+'.',admin_product_id:null,admin_product_request:null}:{})});
      console.log('SELECTED_PRODUCT',item.pid,'TELEGRAM_SEND SUCCESS message_id',message_id);return {result:'success',product_id:item.pid,message_id};
    }return {result:'invalid_candidates'};
  }finally{await runtime(env,{op:'release',kind:'post',owner});}
}
async function search(env,state,fetcher){
  const owner=crypto.randomUUID();if(!(await runtime(env,{op:'acquire',kind:'search',owner,ttl:90})).ok)return {result:'lock_busy'};
  let attempted=null;
  try{
    // Re-read AFTER taking the global lease: stale or owner requests cannot
    // bypass a persistent cooldown in another isolate.
    state=await readHeader(env);
    const now=sec(),old=JSON.parse(state.row.status||'{}'),cursor=Number(old.search_cursor||0),queries=discoveryQueries(state.policy),rules=queryRules(state.policy);
    const requested=state.row.search_request&&old.admin_search_request===state.row.search_request;
    const manual=requested?rules.find(r=>r.id===old.admin_search_query_id&&!r.archived&&r.text===old.admin_search_query):null;
    if(requested&&!manual){await runtime(env,{op:'consume',kind:'search',owner,request_id:state.row.search_request});return {result:'query_changed_or_archived'};}
    if(!queries.length){if(state.row.search_request)await runtime(env,{op:'consume',kind:'search',owner,request_id:state.row.search_request});return {result:'not_configured'};}
    if(!searchDue(state.s,old,now,Boolean(state.row.search_request)))return {result:'backoff_or_not_due',next_search:Math.max(Number(old.next_search||0),Number(old.search_retry_at||0))};
    if(state.count>=state.s.min_queue&&!state.row.search_request)return {result:'queue_full'};
    // Admission before I/O also spaces retries after a killed invocation.
    await status(env,{last_scan_attempt:now,next_search:now+state.s.search_interval_minutes*60,search_origin:env.SEARCH_ORIGIN||'cron'});
    const daily=(await q(env,'SELECT topic,COUNT(*) AS n FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic',now-86400).all()).results;
    const existing=(await q(env,"SELECT topic,COUNT(*) AS n FROM scheduler_inventory WHERE state='ready' AND expires>? GROUP BY topic",now).all()).results;
    const counts=new Map(existing.map(r=>[r.topic,r.n]));
    const dailyCounts=new Map(daily.map(r=>[r.topic,r.n]));let offset=0;
    while(offset<queries.length){const t=queries[(cursor+offset)%queries.length].toLowerCase();if(!state.policy.disabled_topics?.includes(t)&&(dailyCounts.get(t)||0)<8&&(counts.get(t)||0)<8)break;offset++;}
    await status(env,{search_cursor:cursor+offset+1});
    if(offset===queries.length&&!manual){if(state.row.search_request)await runtime(env,{op:'consume',kind:'search',owner,request_id:state.row.search_request});return {result:'daily_topics_at_cap'};}
    let experiment=null;if(!manual&&old.learning_initialized)try{experiment=await explorationQuery(env,state.policy.queries,cursor,dailyCounts,state.policy.disabled_topics);}catch{}
    const query=manual?.text||(experiment&&(counts.get(experiment.toLowerCase())||0)<8?experiment:queries[(cursor+offset)%queries.length]);
    const test=Boolean(manual&&old.admin_search_test===true);
    attempted={query,query_id:rules.find(r=>r.text===query)?.id||'existing:'+query,test,experiment:!!experiment};
    await status(env,{last_search_query:query});
    if(state.row.search_request)await runtime(env,{op:'consume',kind:'search',owner,request_id:state.row.search_request});
    const params=discoveryParams(state.policy,query,cursor);
    let response;try{response=await source(wbURL('search',params),fetcher);}catch(error){
      if([403,429].includes(error.status))throw error;
      // One bounded alternative destination; no endless retries on a blocked IP.
      response=await source(wbURL('search',{...params,page:'1',sort:'popular',dest:'123585633'}),fetcher);
    }
    const found=(response.products||response.data?.products||[]).slice(0,100);
    // Filter known IDs/titles BEFORE the eight-card cap. Otherwise the first
    // eight already-known popular cards can hide every fresh result behind them.
    // All four probes use existing PK/title indexes; never load whole history.
    const ids=JSON.stringify(found.map(p=>Number(p.id))),titles=JSON.stringify(found.map(p=>titleKey({title:p.name})));
    const known=(await q(env,`SELECT CAST(pid AS TEXT) AS key,'pid' AS kind FROM scheduler_inventory WHERE pid IN (SELECT value FROM json_each(?))
      UNION SELECT CAST(id AS TEXT),'pid' FROM products WHERE id IN (SELECT value FROM json_each(?))
      UNION SELECT CAST(pid AS TEXT),'pid' FROM scheduler_posts WHERE pid IN (SELECT value FROM json_each(?))
      UNION SELECT title_key,'title' FROM scheduler_inventory WHERE title_key IN (SELECT value FROM json_each(?))`,ids,ids,ids,titles).all()).results;
    const knownIDs=new Set(known.filter(p=>p.kind==='pid').map(p=>p.key)),knownTitles=new Set(known.filter(p=>p.kind==='title').map(p=>p.key));
    const rejected={known:0,filter:0,title_duplicate:0,topic_cap:0,photo:0,card_missing:0},filter_reasons={};
    const valid=[];for(const card of found){const p=cardDeal(card,state.policy);if(knownIDs.has(String(card.id))){rejected.known++;if(!test)continue;}if(!p){rejected.filter++;const reason=rejectedCardReason(card,state.policy);filter_reasons[reason]=(filter_reasons[reason]||0)+1;continue;}if(!test&&knownTitles.has(titleKey(p))){rejected.title_duplicate++;continue;}p.query=query;const t=topic(p);if(!test&&(state.policy.disabled_topics?.includes(t)||(counts.get(t)||0)>=8)){rejected.topic_cap++;continue;}counts.set(t,(counts.get(t)||0)+1);knownTitles.add(titleKey(p));valid.push(p);if(valid.length>=8)break;}
    // Sequential verified-image batch, bounded independently of posting.
    const verified=[],deadline=Date.now()+28000;
    const details=valid.length?await source(wbURL('cards',{nm:valid.slice(0,3).map(p=>p.id).join(';')}),fetcher):{};
    const live=new Map((details.products||details.data?.products||[]).map(p=>[Number(p.id),p]));
    for(const candidate of valid.slice(0,3)){
      if(Date.now()>=deadline)break;
      const p=cardDeal(live.get(candidate.id),state.policy);
      if(!p){rejected.card_missing++;continue;}p.query=query;
      const photo=await imageFor(env,p,fetcher,{maxProbes:6,deadline});
      if(photo.image)verified.push({...p,image:photo.image,checked_at:now});else rejected.photo++;
    }
    const records=(test?[]:verified).map(p=>({id:p.id,data:JSON.stringify(p),topic:topic(p),title_key:titleKey(p)}));
    const inserted=await q(env,`INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,?,? FROM json_each(?)
      WHERE NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM products WHERE id=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM scheduler_inventory WHERE title_key=json_extract(value,'$.title_key'))
      AND (SELECT ready FROM scheduler_counts WHERE id=1)<? LIMIT ? RETURNING pid`,now,now,now+72*3600,JSON.stringify(records),state.s.min_queue,Math.max(0,state.s.min_queue-state.count)).all();
    // D1 meta.changes includes aggregate-trigger writes, not just new products.
    // RETURNING counts only the inventory rows actually admitted, no extra query.
    const newIDs=inserted.results.map(p=>Number(p.pid));
    const finished=sec(),queueAfter=(await q(env,'SELECT ready FROM scheduler_counts WHERE id=1').first()).ready;
    const receipt={at:finished,origin:env.SEARCH_ORIGIN||'cron',source:'search.wb.ru',...attempted,sort:params.sort,price_filter:params.priceU||null,found:found.length,already_known:knownIDs.size,new_found:Math.max(0,new Set(found.map(p=>String(p.id))).size-knownIDs.size),new_candidates:valid.length,valid:verified.length,added:newIDs.length,new_ids:newIDs,queue_before:state.count,queue_after:queueAfter,rejected,filter_reasons,products:verified.filter(p=>test||newIDs.includes(p.id)).map(p=>({id:p.id,title:p.title,price:p.product,rating:p.rating,feedbacks:p.feedbacks,image:p.image,url:`https://www.wildberries.ru/catalog/${p.id}/detail.aspx`}))};
    // Optional history cannot turn a successful discovery into another WB retry.
    await recordDiscovery(env,receipt).catch(()=>{});
    await status(env,{last_search_success:finished,last_scan_success:finished,last_scan_error:'',last_scan_error_code:'',search_upstream_error:null,search_retry_at:0,search_failures:0,search_backoff_seconds:0,last_scan_found:found.length,last_scan_known:knownIDs.size,last_scan_valid:verified.length,last_scan_added:newIDs.length,last_scan_new_ids:newIDs,last_search_query:query,last_search_experiment:!!experiment,next_search:finished+nextSearchDelay(state.s,newIDs.length),search_receipt:receipt,...(newIDs.length?{last_search_add_receipt:receipt}:{})});
    console.log('SOURCE WB SEARCH_RESULTS',found.length,'VALID_PRODUCTS',verified.length,'ADDED_TO_QUEUE',newIDs.length,'NEW_NM_IDS',newIDs.join(','));return {result:'success',found:found.length,added:newIDs.length};
  }catch(error){
    const current=JSON.parse((await q(env,'SELECT status FROM scheduler_config WHERE id=1').first()).status);
    const code=/^WB HTTP \d{3}$/.test(error.message)?error.message:runtimeError(error);
    const backoff=searchBackoff(current,error,sec());
    if(attempted)await recordDiscovery(env,{...attempted,at:sec(),error:code,retry_at:backoff.search_retry_at,origin:env.SEARCH_ORIGIN||'cron'}).catch(()=>{});
    await status(env,{...backoff,last_scan_error:'WB search unavailable; ready queue retained',last_scan_error_code:code,search_upstream_error:error.upstream||null});
    console.log('WB_SEARCH_BACKOFF',JSON.stringify({code,...backoff,upstream:error.upstream||null}));return {result:'error',code,...backoff};
  }finally{await runtime(env,{op:'release',kind:'search',owner});}
}
export {search as runDiscovery};
export async function nativeTick(env,scheduledTime=Date.now(),fetcher=fetch,origin='cron'){
  await ensureScheduler(env);const now=sec(),results={};
  await status(env,{last_scheduler_tick:now,clock_heartbeat:now,heartbeat:now,clock_driver:'cloudflare-native',cron_active:true,...(origin==='cron'?{last_automatic_tick:now}:{})});
  try{
    let state=await readHeader(env),previous=JSON.parse(state.row.status||'{}');
    const due=postDue(state.s,state.last,now,Boolean(state.row.post_request));
    const canPublish=due&&state.count>0&&now>=Number(previous.post_retry_at||0);
    // Idle minute executions never load the inventory/history. Cleanup is
    // bounded by active-state/time indexes and runs every five minutes.
    // Expired leases are also safe on acquire between maintenance ticks.
    if(!canPublish&&now>=Number(previous.last_maintenance||0)+300){
    await q(env,"DELETE FROM scheduler_leases WHERE expires<=?",now).run();
    // Reconcile old delivery tombstones in one EXISTING maintenance query.
    // PK probes only, active ready buffer only; no full publication history.
    // Bulk recovery avoids spending one minute per historical failed card.
    await q(env,`UPDATE scheduler_inventory SET state=CASE WHEN EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=scheduler_inventory.pid AND ts>?) THEN 'posted' ELSE 'uncertain' END
      WHERE state='ready' AND (EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=scheduler_inventory.pid AND ts>?)
        OR EXISTS(SELECT 1 FROM scheduler_claims WHERE pid=scheduler_inventory.pid AND status IN ('pending','error') AND ts>?))`,now-7*86400,now-7*86400,now-7*86400).run();
    await q(env,"UPDATE scheduler_inventory SET state='expired' WHERE pid IN (SELECT pid FROM scheduler_inventory WHERE state IN ('ready','cooldown') AND expires<=? LIMIT 500)",now).run();
    // Daily topic caps must free the ACTIVE buffer, not poison a full queue.
    // Retain these real cards separately and reactivate when the cap expires.
    await q(env,`UPDATE scheduler_inventory SET state='ready' WHERE pid IN (
      SELECT t.pid FROM (SELECT pid,expires FROM scheduler_inventory INDEXED BY scheduler_inventory_ready WHERE state='cooldown' AND retry_at<=? ORDER BY retry_at LIMIT 300) t
      WHERE expires>? AND NOT EXISTS(SELECT 1 FROM scheduler_posts p WHERE p.pid=t.pid AND p.ts>?)
      LIMIT MAX(0,300-(SELECT ready FROM scheduler_counts WHERE id=1)))`,now,now,now-7*86400).run();
    await q(env,`UPDATE scheduler_inventory SET state='cooldown',retry_at=COALESCE((SELECT MIN(ts)+86401 FROM scheduler_deliveries d WHERE d.topic=scheduler_inventory.topic AND ts>?),?)
      WHERE state='ready' AND topic IN (SELECT topic FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic HAVING COUNT(*)>=8)`,now-86400,now+3600,now-86400).run();
    await status(env,{last_maintenance:now});
    state=await readHeader(env);
    }
    const wall=postingWindow(state.s,now);
    const overdue=wall.allowed&&state.count>0&&now-state.last>Math.max(1800,state.s.post_interval_minutes*180);
    const verified=origin==='cron'&&Number(previous.last_post_success||0)>0&&now>previous.last_post_success&&Number.isInteger(previous.last_message_id);
    await status(env,{queue_size:state.count,posting_allowed:wall.allowed,current_local_time:wall.clock,active_timezone:wall.timezone,watchdog_overdue:overdue,native_credentials_ok:Boolean(env.TG_BOT_TOKEN&&state.policy.chat_id),...(verified?{production_chain_verified_at:now,production_chain_message_id:previous.last_message_id}:{})});
    if(canPublish)try{state=await selectionState(env,state);results.post=await publish(env,state,fetcher);if(['no_eligible_product','invalid_candidates'].includes(results.post.result))await status(env,{last_error:'Нет готового подходящего товара; поиск пополняет очередь',error:'Нет готового подходящего товара; поиск пополняет очередь'});if(['duplicate_or_limit_or_no_lease','lock_busy','no_eligible_product','invalid_candidates'].includes(results.post.result))await status(env,{post_retry_at:now+(results.post.result==='invalid_candidates'?120:300)});}catch(error){const code=runtimeError(error),safe=/^Missing Telegram/.test(error.message)?'Missing Telegram runtime secret':error.message.startsWith('Telegram send outcome')?'Telegram delivery outcome unknown':'Publication failed; next Cron will retry';await status(env,{last_error:safe,error:safe,last_error_code:code,post_retry_at:now+300});results.post={result:'error',code};}
    // Verify stale inventory between posts, instead of discovering a poisoned
    // buffer only when the next publication is due. A scan uses a separate tick.
    if(!results.post&&state.count>=state.s.min_queue&&!state.row.search_request&&now>=Number(previous.last_preflight||0)+300&&now<Number(previous.last_scan_attempt||0)+state.s.search_interval_minutes*60){
      state=await selectionState(env,state,true);
      const item=choose(state.ready.filter(p=>p.checked_at<now-1800),state.recent,state.policy.total_posts+state.recent.length,state.policy);
      if(item)results.preflight={product_id:item.pid,valid:Boolean(await validateQueued(env,item,state.policy,fetcher))};
      await status(env,{last_preflight:now});
    }
    // A successful send and a catalogue scan use separate minute ticks. This
    // keeps even a cold-isolate invocation inside the Free D1 query budget.
    if(!results.post&&!results.preflight&&(state.count<state.s.min_queue||state.row.search_request)&&searchDue(state.s,previous,now,Boolean(state.row.search_request)))try{
      // Separate accounting: discovery cannot spend the posting budget. The raw
      // binding bypasses only the outer meter, never its own atomic admission.
      results.search=await withReadBudget({...env,DB:env.DISCOVERY_DB||env.DB,SEARCH_ORIGIN:origin},'optional',15000,async e=>{
        const result=await search(e,state,fetcher);
        if(!['backoff_or_not_due','lock_busy','queue_full'].includes(result.result)){
          // Official metadata of the completed discovery queries BEFORE this
          // single receipt write, no database scanning for instrumentation.
          const measured={...e.D1_METER,before_receipt_write:true};
          await status(e,{last_search_d1:measured});console.log('WB_SEARCH_D1',JSON.stringify(measured));
        }return result;
      },{writes:256});
    }catch(error){console.log('WB_SEARCH_DEFERRED',error.status===429?'DISCOVERY_BUDGET':'DISCOVERY_UNAVAILABLE');results.search={result:'deferred'};}
    // Repairs are bounded and run ONLY on otherwise idle ticks. Never add
    // reaction work to the near-50-query posting/search Free-plan invocation.
    if(previous.reactions_initialized&&!results.post&&!results.preflight&&!results.search)try{await repairReactions(env,fetcher);}catch{console.log('REACTION_REPAIR deferred; scheduler retained');}
    const count=(results.post||results.preflight||results.search)?(await q(env,'SELECT ready AS n FROM scheduler_counts WHERE id=1').first()).n:state.count;
    const last=results.post?.result==='success'?sec():state.last;
    await status(env,{queue_size:count,next_post:last+state.s.post_interval_minutes*60,post_running:false,scan_running:false,...(results.post?{last_post_result:results.post.result}:{})});
    console.log('SCHEDULER_TICK OK QUEUE_SIZE',count,JSON.stringify(results));return {enabled:true,results,queue_size:count};
  }catch(error){const code=runtimeError(error);await status(env,{last_error:'Scheduler execution failed; next Cron continues',error:'Scheduler execution failed; next Cron continues',last_error_code:code});return {enabled:true,error:'scheduler_error',code};}
}
export async function checkAutopost(env,fetcher=fetch){
  await ensureScheduler(env);const state=await readState(env),now=sec(),window=postingWindow(state.s,now),item=choose(state.ready,state.recent,state.policy.total_posts+state.recent.length,state.policy),status=JSON.parse(state.row.status||'{}');
  const result={ok:true,dry_run:true,telegram_posts_created:0,cron:env.SCHEDULER_DRIVER==='cloudflare-native',last_scheduler_tick:status.last_scheduler_tick||0,heartbeat_stale:now-Number(status.last_scheduler_tick||0)>180,queue_size:state.count,eligible_products:state.ready.filter(p=>(state.recent.filter(r=>r.topic===p.topic).length)<8).length,next_product:item?.pid||null,posting_allowed:window.allowed,timezone:window.timezone,current_local_time:window.clock,quiet_hours:state.s.quiet_enabled?state.s.quiet_start+'–'+state.s.quiet_end:'OFF',telegram_configured:Boolean(env.TG_BOT_TOKEN&&state.policy.chat_id),last_post:state.last,last_message_id:status.last_message_id||null};
  if(result.telegram_configured)try{const r=await fetcher(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`,{signal:AbortSignal.timeout(5000)});result.telegram_auth=(await r.json()).ok===true;}catch{result.telegram_auth=false;}
  if(item)try{const cards=await source(wbURL('cards',{nm:String(item.pid)}),fetcher);const card=(cards.products||cards.data?.products||[]).find(c=>c.id===item.pid),deal=cardDeal(card,state.policy),saved=JSON.parse(item.data);result.live_card=Boolean(deal);result.price_increase_ok=Boolean(deal&&deal.product<=saved.product*1.1);if(deal){result.title=deal.title;result.price=deal.product;result.url=`https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;result.image=(await imageFor(env,{...deal,...saved},fetcher)).image;}}catch{result.live_card=false;}
  result.ok=result.cron&&!result.heartbeat_stale&&result.telegram_configured&&result.telegram_auth&&result.queue_size>0&&result.live_card&&result.price_increase_ok&&Boolean(result.image);return result;
}
