// Native runtime: D1 bindings, existing claims and expiring leases; no CI token.
import {ensureScheduler,validateSchedule,schedulerRoute} from './scheduler_api.mjs';
import {safeImage,normalize} from './domain.mjs';
const q=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const sec=()=>Math.floor(Date.now()/1000);
const topic=p=>String(p.query||p.category||p.cat||'').trim().toLowerCase();
const titleKey=p=>String(p.title||'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const escape=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
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
export function choose(rows,recent,total=0){
  const counts=new Map();for(const p of recent)counts.set(p.topic,(counts.get(p.topic)||0)+1);
  const eligible=rows.filter(p=>(counts.get(p.topic)||0)<8&&!recent.some(r=>r.title_key===p.title_key));
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
  if(!r.ok)throw new Error('WB HTTP '+r.status);return r.json();
}
const common={appType:'1',curr:'rub',dest:'-1257786',spp:'30',lang:'ru'};
function wbURL(kind,params={}){const url=new URL(kind==='search'?'https://search.wb.ru/exactmatch/ru/common/v9/search':'https://card.wb.ru/cards/v4/detail');url.search=new URLSearchParams({...common,...params}).toString();return url.href;}
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
  return p;
}
async function imageFor(env,p,fetcher){
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
  const start=Math.max(1,Number(p.photo_probe||1));
  for(let host=start;host<Math.min(start+6,51);host++)urls.push(`https://basket-${String(host).padStart(2,'0')}.wbbasket.ru/vol${vol}/part${part}/${p.id}/images/big/1.webp`);
  for(const url of urls){
    try{const r=await fetcher(url,{signal:AbortSignal.timeout(3000)});const okay=r.ok&&r.headers.get('content-type')?.startsWith('image/');await r.body?.cancel();if(okay)return {image:url};}catch{}
  }
  return {image:'',photo_probe:start+6>50?1:start+6};
}
export async function readHeader(env){
  const row=await q(env,`SELECT c.*,(SELECT data FROM scheduler_policy WHERE id=1) AS policy,
      (SELECT MAX(ts) FROM scheduler_posts) AS last_post,
      (SELECT ready FROM scheduler_counts WHERE id=1) AS queue_size FROM scheduler_config c WHERE id=1`).first();
  return {row,s:validateSchedule(JSON.parse(row.data)),policy:JSON.parse(row.policy||'{}'),last:Number(row.last_post||0),count:row.queue_size};
}
async function selectionState(env,header,preflight=false){
  const [ready,recent]=await Promise.all([
    q(env,`SELECT * FROM scheduler_inventory WHERE state='ready' AND expires>? AND retry_at<=? ${preflight?'AND checked_at<?':''} ORDER BY queued_at,pid LIMIT 300`,sec(),sec(),...(preflight?[sec()-1800]:[])).all(),
    q(env,'SELECT topic,title_key,ts FROM scheduler_deliveries WHERE ts>? ORDER BY ts DESC LIMIT 4032',sec()-86400).all()]);recent.results.reverse();
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
  try{const response=await source(wbURL('cards',{nm:String(item.pid)}),fetcher);card=(response.products||response.data?.products||[]).find(p=>p.id===item.pid);}
  catch{unavailable=true;if(now-item.checked_at>6*3600||!saved.image){await q(env,'UPDATE scheduler_inventory SET retry_at=? WHERE pid=?',now+300,item.pid).run();return null;}}
  let deal=card?cardDeal(card,policy):unavailable&&now-item.checked_at<=6*3600?saved:null;
  if(!deal||deal.product>saved.product*1.1){await q(env,"UPDATE scheduler_inventory SET state='rejected' WHERE pid=?",item.pid).run();return null;}
  deal={...deal,query:saved.query||'',image:saved.image||'',photo_probe:saved.photo_probe||1};
  deal={...deal,...await imageFor(env,deal,fetcher)};
  if(!deal.image){await q(env,'UPDATE scheduler_inventory SET data=?,retry_at=? WHERE pid=?',JSON.stringify(deal),now+60,item.pid).run();return null;}
  await q(env,'UPDATE scheduler_inventory SET data=?,checked_at=? WHERE pid=?',JSON.stringify(deal),now,item.pid).run();return deal;
}
async function publish(env,state,fetcher){
  const owner=crypto.randomUUID(),lock=await runtime(env,{op:'acquire',kind:'post',owner,ttl:120});
  if(!lock.ok)return {result:'lock_busy'};
  try{
    const latest=await q(env,'SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1').first();
    let current={...state,s:validateSchedule(JSON.parse(latest.data)),last:Number(latest.last_post||0),ready:[...state.ready]};
    const manual=current.row.post_request;
    if(!postDue(current.s,current.last,sec(),Boolean(manual)))return {result:'not_due'};
    if(!env.TG_BOT_TOKEN||!current.policy.chat_id)throw new Error('Missing Telegram runtime secret');
    // One candidate per minute bounds the Free plan CPU/D1 budget even when
    // several cards fail. The next Cron selects the next non-deferred product.
    for(let attempt=0;attempt<1;attempt++){
      const item=choose(current.ready,current.recent,current.policy.total_posts+current.recent.length);
      if(!item)return {result:'no_eligible_product'};
      current.ready=current.ready.filter(p=>p.pid!==item.pid);
      const now=sec();
      await status(env,{last_post_attempt:now,selected_product:item.pid});
      const deal=await validateQueued(env,item,current.policy,fetcher);if(!deal)continue;
      // Re-read pause/timezone after external calls, immediately before claim/send.
      const latest=await q(env,'SELECT data,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1').first();
      current.s=validateSchedule(JSON.parse(latest.data));current.last=Number(latest.last_post||0);if(!postDue(current.s,current.last,sec(),Boolean(manual)))return {result:'not_due'};
      const claim=await runtime(env,{op:'claim',owner,product_id:item.pid,request_id:manual||undefined});if(!claim.ok)return {result:claim.reason};
      if(manual&&!(await runtime(env,{op:'consume',kind:'post',owner,request_id:manual})).ok){await runtime(env,{op:'complete',owner,product_id:item.pid,success:false});return {result:'request_already_consumed'};}
      const caption=`✨ <b>${escape(deal.title)}</b>\n\n💰 Сейчас: <b>${deal.product} ₽</b>\n⭐ ${deal.rating} · ${deal.feedbacks} отзывов\n${escape(deal.brand)}\n\nЦена проверена перед публикацией. На WB она может меняться.`,url=`https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;
      const launch=env.MINIAPP_LINK_MODE==='startapp'?'startapp':'start',miniapp=`https://t.me/${env.MINIAPP_BOT_USERNAME||'WbPodborr_bot'}?${launch}=`;
      const reply_markup={inline_keyboard:[[{text:'Открыть на WB',url}],[{text:'👍 0',callback_data:'l'+deal.id},{text:'👎 0',callback_data:'d'+deal.id},{text:'🛒 Купил',callback_data:'b'+deal.id}],[{text:'🔖 Сохранить',url:miniapp+'save_'+deal.id},{text:'✨ Собрать образ',url:miniapp+'look_'+deal.id}]]};
      let result;
      try{const r=await fetcher(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:current.policy.chat_id,photo:deal.image,caption,parse_mode:'HTML',reply_markup}),signal:AbortSignal.timeout(15000)});result=await r.json();}
      catch{await runtime(env,{op:'complete',owner,product_id:item.pid,success:false});await q(env,"UPDATE scheduler_inventory SET state='uncertain' WHERE pid=?",item.pid).run();throw new Error('Telegram send outcome unknown; automatic duplicate retry suppressed');}
      if(!result.ok){await runtime(env,{op:'complete',owner,product_id:item.pid,success:false});await q(env,'UPDATE scheduler_inventory SET retry_at=? WHERE pid=?',sec()+Math.max(300,Number(result.parameters?.retry_after||0)),item.pid).run();throw new Error('Telegram rejected publication');}
      const message_id=result.result?.message_id;if(!Number.isInteger(message_id))throw new Error('Telegram receipt missing');
      // If persistence fails after send, pending claim still prevents duplicates.
      await runtime(env,{op:'complete',owner,product_id:item.pid,success:true});
      const sent=sec();await env.DB.batch([
        q(env,"UPDATE scheduler_inventory SET state='posted' WHERE pid=?",item.pid),
        q(env,'INSERT OR IGNORE INTO scheduler_deliveries(pid,ts,message_id,topic,title_key,data) VALUES(?,?,?,?,?,?)',item.pid,sent,message_id,item.topic,item.title_key,JSON.stringify(deal)),
        q(env,'INSERT INTO products(id,data,checked_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at',deal.id,JSON.stringify(normalize({...deal,checked_at:sent})),sent)
      ]);
      await status(env,{last_post_success:sent,last_post:sent,last_message_id:message_id,last_error:'',error:'',next_post:sent+current.s.post_interval_minutes*60});
      console.log('SELECTED_PRODUCT',item.pid,'TELEGRAM_SEND SUCCESS message_id',message_id);return {result:'success',product_id:item.pid,message_id};
    }return {result:'invalid_candidates'};
  }finally{await runtime(env,{op:'release',kind:'post',owner});}
}
async function search(env,state,fetcher){
  if(!state.policy.queries?.length)return {result:'not_configured'};
  const owner=crypto.randomUUID();if(!(await runtime(env,{op:'acquire',kind:'search',owner,ttl:90})).ok)return {result:'lock_busy'};
  try{
    const now=sec(),old=JSON.parse(state.row.status||'{}'),cursor=Number(old.search_cursor||0),queries=state.policy.queries;
    const daily=(await q(env,'SELECT topic,COUNT(*) AS n FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic',now-86400).all()).results;
    const dailyCounts=new Map(daily.map(r=>[r.topic,r.n]));let offset=0;
    while(offset<queries.length){const t=queries[(cursor+offset)%queries.length].toLowerCase();if(!state.policy.disabled_topics?.includes(t)&&(dailyCounts.get(t)||0)<8)break;offset++;}
    await status(env,{last_scan_attempt:now,search_cursor:cursor+offset+1});
    if(offset===queries.length)return {result:'daily_topics_at_cap'};
    const query=queries[(cursor+offset)%queries.length];
    if(state.row.search_request)await runtime(env,{op:'consume',kind:'search',owner,request_id:state.row.search_request});
    let response;try{response=await source(wbURL('search',{query,page:String(1+Math.floor(cursor/state.policy.queries.length)%5),sort:cursor%2?'popular':'newly',resultset:'catalog'}),fetcher);}catch{
      // One bounded alternative destination; no endless retries on a blocked IP.
      response=await source(wbURL('search',{query,page:'1',sort:'popular',dest:'123585633',resultset:'catalog'}),fetcher);
    }
    const found=response.products||response.data?.products||[],counts=new Map();
    const existing=(await q(env,"SELECT topic,COUNT(*) AS n FROM scheduler_inventory WHERE state='ready' AND expires>? GROUP BY topic",now).all()).results;for(const r of existing)counts.set(r.topic,r.n);
    const valid=[];for(const card of found){const p=cardDeal(card,state.policy);if(!p)continue;p.query=query;const t=topic(p);if(state.policy.disabled_topics?.includes(t)||(counts.get(t)||0)>=8)continue;counts.set(t,(counts.get(t)||0)+1);valid.push(p);if(valid.length>=8)break;}
    const records=valid.map(p=>({id:p.id,data:JSON.stringify(p),topic:topic(p),title_key:titleKey(p)}));
    const inserted=await q(env,`INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires)
      SELECT json_extract(value,'$.id'),json_extract(value,'$.data'),json_extract(value,'$.topic'),json_extract(value,'$.title_key'),?,0,? FROM json_each(?)
      WHERE NOT EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM products WHERE id=json_extract(value,'$.id'))
      AND NOT EXISTS(SELECT 1 FROM scheduler_inventory WHERE title_key=json_extract(value,'$.title_key'))
      AND (SELECT ready FROM scheduler_counts WHERE id=1)<? LIMIT ?`,now,now+72*3600,JSON.stringify(records),state.s.min_queue,Math.max(0,state.s.min_queue-state.count)).run();
    await status(env,{last_search_success:now,last_scan_success:now,last_scan_error:'',last_scan_found:found.length,last_scan_added:inserted.meta.changes,next_search:now+state.s.search_interval_minutes*60});
    console.log('SOURCE WB SEARCH_RESULTS',found.length,'VALID_PRODUCTS',valid.length,'ADDED_TO_QUEUE',inserted.meta.changes);return {result:'success',found:found.length,added:inserted.meta.changes};
  }finally{await runtime(env,{op:'release',kind:'search',owner});}
}
export async function nativeTick(env,scheduledTime=Date.now(),fetcher=fetch,origin='cron'){
  await ensureScheduler(env);const now=sec(),results={};
  await status(env,{last_scheduler_tick:now,clock_heartbeat:now,heartbeat:now,clock_driver:'cloudflare-native',cron_active:true,...(origin==='cron'?{last_automatic_tick:now}:{})});
  try{
    let state=await readHeader(env),previous=JSON.parse(state.row.status||'{}');
    const due=postDue(state.s,state.last,now,Boolean(state.row.post_request));
    // Idle minute executions never load the inventory/history. Cleanup is
    // bounded by active-state/time indexes and runs every five minutes.
    // Expired leases are also safe on acquire between maintenance ticks.
    if(now>=Number(previous.last_maintenance||0)+300){
    await q(env,"DELETE FROM scheduler_leases WHERE expires<=?",now).run();
    await q(env,"UPDATE scheduler_inventory SET state='posted' WHERE state='ready' AND EXISTS(SELECT 1 FROM scheduler_posts WHERE pid=scheduler_inventory.pid AND ts>?)",now-7*86400).run();
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
    if(due&&state.count>0&&now>=Number(previous.post_retry_at||0))try{state=await selectionState(env,state);results.post=await publish(env,state,fetcher);if(['no_eligible_product','invalid_candidates'].includes(results.post.result))await status(env,{last_error:'Нет готового подходящего товара; поиск пополняет очередь',error:'Нет готового подходящего товара; поиск пополняет очередь'});if(['duplicate_or_limit_or_no_lease','lock_busy','no_eligible_product'].includes(results.post.result))await status(env,{post_retry_at:now+300});}catch(error){const safe=/^Missing Telegram/.test(error.message)?'Missing Telegram runtime secret':error.message.startsWith('Telegram send outcome')?'Telegram delivery outcome unknown':'Publication failed; next Cron will retry';await status(env,{last_error:safe,error:safe,post_retry_at:now+300});results.post={result:'error'};}
    // Verify stale inventory between posts, instead of discovering a poisoned
    // buffer only when the next publication is due. A scan uses a separate tick.
    if(!results.post&&state.count>=state.s.min_queue&&!state.row.search_request&&now>=Number(previous.last_preflight||0)+300&&now<Number(previous.last_scan_attempt||0)+state.s.search_interval_minutes*60){
      state=await selectionState(env,state,true);
      const item=choose(state.ready.filter(p=>p.checked_at<now-1800),state.recent,state.policy.total_posts+state.recent.length);
      if(item)results.preflight={product_id:item.pid,valid:Boolean(await validateQueued(env,item,state.policy,fetcher))};
      await status(env,{last_preflight:now});
    }
    const noEligible=results.post?.result==='no_eligible_product',emptySearch=previous.last_scan_error||previous.last_scan_added===0;
    const interval=state.count<state.s.min_queue||noEligible?(emptySearch?300:60):state.s.search_interval_minutes*60;
    // A successful send and a catalogue scan use separate minute ticks. This
    // keeps even a cold-isolate invocation inside the Free D1 query budget.
    if(results.post?.result!=='success'&&!results.preflight&&(state.row.search_request||state.s.search_enabled&&now>=Number(previous.last_scan_attempt||0)+interval))try{results.search=await search(env,state,fetcher);}catch{await status(env,{last_scan_error:'WB search unavailable; ready queue retained'});results.search={result:'error'};}
    const count=(results.post||results.preflight||results.search)?(await q(env,'SELECT ready AS n FROM scheduler_counts WHERE id=1').first()).n:state.count;
    const last=results.post?.result==='success'?sec():state.last;
    await status(env,{queue_size:count,next_post:last+state.s.post_interval_minutes*60,post_running:false,scan_running:false});
    console.log('SCHEDULER_TICK OK QUEUE_SIZE',count,JSON.stringify(results));return {enabled:true,results,queue_size:count};
  }catch{await status(env,{last_error:'Scheduler execution failed; next Cron continues',error:'Scheduler execution failed; next Cron continues'});return {enabled:true,error:'scheduler_error'};}
}
export async function checkAutopost(env,fetcher=fetch){
  await ensureScheduler(env);const state=await readState(env),now=sec(),window=postingWindow(state.s,now),item=choose(state.ready,state.recent,state.policy.total_posts+state.recent.length),status=JSON.parse(state.row.status||'{}');
  const result={ok:true,dry_run:true,telegram_posts_created:0,cron:env.SCHEDULER_DRIVER==='cloudflare-native',last_scheduler_tick:status.last_scheduler_tick||0,heartbeat_stale:now-Number(status.last_scheduler_tick||0)>180,queue_size:state.count,eligible_products:state.ready.filter(p=>(state.recent.filter(r=>r.topic===p.topic).length)<8).length,next_product:item?.pid||null,posting_allowed:window.allowed,timezone:window.timezone,current_local_time:window.clock,quiet_hours:state.s.quiet_enabled?state.s.quiet_start+'–'+state.s.quiet_end:'OFF',telegram_configured:Boolean(env.TG_BOT_TOKEN&&state.policy.chat_id),last_post:state.last,last_message_id:status.last_message_id||null};
  if(result.telegram_configured)try{const r=await fetcher(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`,{signal:AbortSignal.timeout(5000)});result.telegram_auth=(await r.json()).ok===true;}catch{result.telegram_auth=false;}
  if(item)try{const cards=await source(wbURL('cards',{nm:String(item.pid)}),fetcher);const card=(cards.products||cards.data?.products||[]).find(c=>c.id===item.pid),deal=cardDeal(card,state.policy),saved=JSON.parse(item.data);result.live_card=Boolean(deal);result.price_increase_ok=Boolean(deal&&deal.product<=saved.product*1.1);if(deal){result.title=deal.title;result.price=deal.product;result.url=`https://www.wildberries.ru/catalog/${deal.id}/detail.aspx`;result.image=(await imageFor(env,{...deal,...saved},fetcher)).image;}}catch{result.live_card=false;}
  result.ok=result.cron&&!result.heartbeat_stale&&result.telegram_configured&&result.telegram_auth&&result.queue_size>0&&result.live_card&&result.price_increase_ok&&Boolean(result.image);return result;
}
