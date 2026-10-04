import {telegramUser,equal,hmac} from './auth.mjs';
import {normalize,build,integer,SLOTS,OCCASIONS} from './domain.mjs';
import {schedulerRoute,ensureScheduler} from './scheduler_api.mjs';
import {scheduledTick} from './cron_driver.mjs';
import {nativeTick,bootstrap,checkAutopost} from './native_scheduler.mjs';
import {observeD1,d1QuotaFailure} from './d1_budget.mjs';
import {catalogSnapshot,ensureCatalog,invalidateCatalog} from './catalog_cache.mjs';
import {withReadBudget,ReadBudgetError} from './read_guard.mjs';
import {productionDiagnostic} from './production_diagnostic.mjs';
import {adminRoute} from './admin_api.mjs';
import {learningRoute,recordEvent} from './learning.mjs';
import {feedbackRoute,webhookSecret,telegram,handleMainUpdate} from './feedback.mjs';

class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new HttpError(status,message);};
const json=(data,status=200)=>Response.json(data,{status});
const second=()=>Math.floor(Date.now()/1000);
const product=row=>({...JSON.parse(row.data),...JSON.parse(row.overrides)});
const headers={
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://*.wbbasket.ru; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
};
async function payload(request,max=32768) {
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail(400,'Нужен JSON-объект');
  if(Number(request.headers.get('content-length')||0)>max) fail(413,'Слишком большой запрос');
  // Bound streamed bodies as well as Content-Length, which clients can omit.
  const reader=request.body?.getReader();if(!reader) fail(400,'Нужен JSON-объект');
  const chunks=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>max){await reader.cancel();fail(413,'Слишком большой запрос');}chunks.push(value);}
  const buffer=new Uint8Array(length);let offset=0;for(const c of chunks){buffer.set(c,offset);offset+=c.length;}
  let data;try{data=JSON.parse(new TextDecoder().decode(buffer));}catch{fail(400,'Некорректный JSON');}
  if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'Нужен JSON-объект');return data;
}
async function route(request,env,ctx) {
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(path==='/telegram/main/webhook'&&method==='POST'){
    if(!env.TG_BOT_TOKEN||!env.MINIAPP_SYNC_KEY||!equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),await webhookSecret(env)))fail(403,'Нет доступа');
    const update=await payload(request);
    // FIRST network operation is the bounded Telegram acknowledgement. Never
    // reserve/read D1 or process another command before acknowledging this one.
    const ackStart=Date.now();let ackOK=false;
    if(update.callback_query?.id)try{ackOK=(await telegram(env,'answerCallbackQuery',{callback_query_id:update.callback_query.id,text:'✓'},fetch,900)).ok===true;}catch{}
    const ackMS=Date.now()-ackStart;
    const cb=update.callback_query,actor=cb?.from||update.message?.from,message=cb?.message||update.message;
    if(cb)console.log('REAL_CALLBACK_RECEIVED',JSON.stringify({update_id:update.update_id,message_id:message?.message_id,chat:message?.chat?.id,data:String(cb.data||'').slice(0,30),has_markup:Array.isArray(message?.reply_markup?.inline_keyboard),ack_ok:ackOK,ack_ms:ackMS}));
    const isOwner=String(actor?.id)===String(env.MINIAPP_ADMIN_ID)&&String(message?.chat?.id)===String(env.MINIAPP_ADMIN_ID);
    const isReaction=/^[ldb][1-9]\d{0,11}$/.test(cb?.data||'')&&Number.isSafeInteger(update.update_id)&&update.update_id>=0&&Number.isSafeInteger(cb?.from?.id)&&cb.from.id>0&&Number.isSafeInteger(message?.message_id)&&Array.isArray(message.reply_markup?.inline_keyboard)&&message.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===cb.data);
    // Unrelated subscriber private messages are acknowledged, not retained or
    // charged a conservative "unknown" D1 reservation for a zero-query path.
    if(!isOwner&&!isReaction)return json({ok:true});
    if(update.callback_query?.from?.id&&env.RATE_LIMITER&&!(await env.RATE_LIMITER.limit({key:'channel-reaction:'+String(update.callback_query.from.id)})).success)return json({ok:true});
    // Persist BEFORE webhook HTTP200: D1 failure gets503 and Telegram redelivers.
    // Only markup rendering is asynchronous; idempotent votes survive retries.
    await withReadBudget(env,'optional',1500,async e=>{
      if(isReaction)await e.DB.prepare("INSERT OR REPLACE INTO metadata VALUES('reaction_last_received',?)").bind(JSON.stringify({update_id:update.update_id,message_id:message.message_id,chat:String(message.chat.id),pid:Number(cb.data.slice(1)),ack_ok:ackOK,ack_ms:ackMS,ts:second()})).run();
      const result=await handleMainUpdate(e,update,fetch,operation=>ctx.waitUntil(withReadBudget(env,'optional',500,operation).catch(()=>console.log('REACTION_MARKUP pending Cron repair'))));
      if(result.ignored)console.log('REAL_CALLBACK_IGNORED',result.reason||'invalid_callback');
      if(result.totals)await e.DB.prepare("INSERT OR REPLACE INTO metadata VALUES('reaction_last_callback',?)").bind(JSON.stringify({update_id:update.update_id,callback_id:cb.id,message_id:cb.message.message_id,chat:String(cb.message.chat.id),pid:Number(cb.data.slice(1)),totals:result.totals,ack_ms:ackMS,ack_ok:ackOK,ts:second()})).run();
    });
    return json({ok:true});
  }
  if(path==='/telegram/webhook'&&method==='POST') {
    const secret=env.MINIAPP_WEBHOOK_SECRET||'';
    if(secret.length<32||!equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),secret))fail(403,'Нет доступа');
    const update=await payload(request),message=update.message;
    if(message?.chat?.type==='private'&&integer(message.chat.id)&&typeof message.text==='string') {
      const command=/^\/(?:start|admin)(?:@[A-Za-z0-9_]+)?(?:\s+((?:save|look)_\d{1,12}|admin))?\s*$/.exec(message.text);
      if(command) {
        const owner=String(message.from?.id)===String(env.MINIAPP_ADMIN_ID);
        const wantsAdmin=message.text.startsWith('/admin')||command[1]==='admin';
        if(wantsAdmin&&!owner)return json({ok:true});
        const app=new URL('/',url.origin);if(command[1])app.searchParams.set('tgWebAppStartParam',command[1]);
        if(wantsAdmin){app.pathname='/admin';app.search='';}
        const send=fetch(`https://api.telegram.org/bot${env.MINIAPP_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:message.chat.id,text:wantsAdmin?'Управление каналом — только для владельца.':'Добро пожаловать в «Находки»! Сохраняйте понравившиеся вещи и собирайте образы в своём бюджете.',reply_markup:{inline_keyboard:[[{text:wantsAdmin?'Открыть управление ⚙️':'Открыть находки ✨',web_app:{url:app.href}}]]}})}).then(r=>{if(!r.ok)throw new Error('Telegram delivery failed');});
        // No callback work blocks Telegram's acknowledgement; no credentials are logged.
        ctx.waitUntil(send.catch(()=>{}));
      }
    }
    return json({ok:true});
  }
  if(!path.startsWith('/api/')) {
    if(!['GET','HEAD'].includes(method)) fail(405,'Метод не поддерживается');
    if(!['/','/index.html','/static/app.js','/static/app.css','/admin','/admin/','/admin/index.html','/admin/app.js','/admin/app.css'].includes(path))fail(404,'Не найдено');
    const assetURL=new URL(url);assetURL.pathname=path==='/'?'/index.html':path;
    if(['/admin','/admin/'].includes(path))assetURL.pathname='/admin/index.html';
    return env.ASSETS.fetch(new Request(assetURL,request));
  }
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  if(path.startsWith('/api/scheduler/')) {
    const key=env.MINIAPP_SYNC_KEY||'';
    if(key.length<32||!equal(request.headers.get('Authorization'),'Bearer '+key))fail(403,'Нет доступа');
    if(path==='/api/scheduler/diagnostic'&&method==='GET')return json(await productionDiagnostic(env));
    if(path.startsWith('/api/scheduler/feedback')){const result=await feedbackRoute(request,env,{payload,json,fail});if(result)return result;}
    if(path==='/api/scheduler/admin/check'&&method==='POST'){
      const response=await adminRoute(new Request('https://internal/api/admin/check',request),env,{payload,fail,json,ctx});
      return json(await response.json()); // CLI compatibility; UI receives HTTP 202.
    }
    if(path==='/api/scheduler/admin'&&method==='GET'){
      const overview=await (await adminRoute(new Request('https://internal/api/admin/overview'),env,{payload,fail,json,ctx})).json();
      const learning=await (await learningRoute(new Request('https://internal/api/admin/learning'),env,{payload,fail,json})).json();
      const pid=Number(overview.status.selected_product||0);
      const posting_debug={pid,claim:await prepare('SELECT status,ts FROM scheduler_claims WHERE pid=?',pid).first(),inventory:await prepare('SELECT state,retry_at,checked_at FROM scheduler_inventory WHERE pid=?',pid).first(),prior_post:await prepare('SELECT ts FROM scheduler_posts WHERE pid=? ORDER BY ts DESC LIMIT 1',pid).first()};
      return json({admin_version:1,...overview,learning,posting_debug,link:`https://t.me/${env.MINIAPP_BOT_USERNAME}?start=admin`});
    }
    if(path==='/api/scheduler/admin/invite'&&method==='POST'){
      if(!/^\d+$/.test(String(env.MINIAPP_ADMIN_ID))||!env.MINIAPP_BOT_TOKEN)fail(503,'Не настроен владелец');
      const claimed=await prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('admin_invite_v1',?)",JSON.stringify({state:'attempted',ts:second()})).run();
      if(claimed.meta.changes){
        let result;try{result=await (await fetch(`https://api.telegram.org/bot${env.MINIAPP_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),body:JSON.stringify({chat_id:env.MINIAPP_ADMIN_ID,text:'Управление каналом готово. Расписание, поиск и наблюдение за обучением — в одном месте.',reply_markup:{inline_keyboard:[[{text:'Открыть управление ⚙️',web_app:{url:new URL('/admin',url.origin).href}}]]}})})).json();}catch{fail(503,'Статус доставки неизвестен. Используйте /admin в боте');}
        if(!result.ok)fail(503,'Не удалось отправить владельцу; используйте /admin в боте');
        await prepare("UPDATE metadata SET value=? WHERE key='admin_invite_v1'",JSON.stringify({state:'sent',message_id:result.result.message_id,ts:second()})).run();
      }
      return json(JSON.parse((await prepare("SELECT value FROM metadata WHERE key='admin_invite_v1'").first()).value));
    }
    if(path.startsWith('/api/scheduler/learning')){await ensureScheduler(env);return learningRoute(request,env,{payload,fail,json});}
    if(path==='/api/scheduler/bootstrap'&&method==='POST') {
      try{return json(await bootstrap(env,await payload(request,2*1024*1024)));}catch{fail(400,'Некорректные данные переноса');}
    }
    if(path==='/api/scheduler/check'&&method==='GET')return json(await checkAutopost(env));
    if(path==='/api/scheduler/tick'&&method==='POST') {
      if(env.SCHEDULER_DRIVER!=='cloudflare-native')fail(409,'Прямой scheduler ещё не включён');
      return json(await nativeTick(env,Date.now(),fetch,'api'));
    }
    return schedulerRoute(request,env,{payload,fail,json});
  }
  const all=async(sql,...args)=>(await prepare(sql,...args).all()).results;
  const catalog=()=>catalogSnapshot(env.DB);
  let uid;
  if(!['/api/catalog','/api/sync','/api/health'].includes(path)) {
    try{uid=await telegramUser(request.headers.get('X-Telegram-Init-Data'),env.MINIAPP_BOT_TOKEN);}catch{fail(401,'Откройте приложение заново через Telegram');}
    // Optional Cloudflare rate-limiter binding. Identity comes only from verified Telegram data.
    if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:String(uid)})).success)fail(429,'Слишком много запросов. Подождите минуту.');
  }
  const admin=()=>{if(!env.MINIAPP_ADMIN_ID||String(uid)!==String(env.MINIAPP_ADMIN_ID))fail(403,'Доступ только владельцу');};
  if(path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/schedule')&&!path.startsWith('/api/admin/products')){admin();const result=await adminRoute(request,env,{payload,fail,json,ctx});if(result)return result;}
  if(path.startsWith('/api/admin/schedule')) {admin();if(path==='/api/admin/schedule/check'&&method==='GET')return json(await checkAutopost(env));return schedulerRoute(request,env,{payload,fail,json,admin:true});}
  if(path==='/api/health'&&method==='GET') {
    await prepare('SELECT 1').first();return json({ok:true,configured:Boolean(env.MINIAPP_BOT_TOKEN&&env.MINIAPP_SYNC_KEY?.length>=32),d1_optimization_version:3,admin_version:1,runtime_version:env.CF_VERSION?.id||null});
  }
  if(path==='/api/catalog'&&method==='GET') {
    const [products,meta]=await Promise.all([catalog(),prepare("SELECT value FROM metadata WHERE key='synced_at'").first()]);
    return json({products:products.filter(p=>p.enabled!==false),slots:SLOTS,occasions:OCCASIONS,synced_at:Number(meta?.value||0),bot_username:env.MINIAPP_BOT_USERNAME||''});
  }
  if(path==='/api/sync'&&method==='POST') {
    const key=env.MINIAPP_SYNC_KEY||'';
    if(key.length<32||!equal(request.headers.get('Authorization'),'Bearer '+key))fail(403,'Нет доступа');
    const data=await payload(request,2*1024*1024);
    if(!Array.isArray(data.products)||data.products.length>1000)fail(400,'Некорректный каталог');
    let cleaned;try{cleaned=data.products.map(normalize);}catch{fail(400,'Некорректные поля товара');}
    // A single set-based write avoids the Free plan's per-request D1 query limit.
    // Never overwrite newer prices, images absent from older bot posts, or owner overrides.
    await env.DB.batch([
      prepare(`INSERT INTO products(id,data,checked_at)
        SELECT json_extract(value,'$.id'),value,json_extract(value,'$.checked_at') FROM json_each(?) WHERE true
        ON CONFLICT(id) DO UPDATE SET data=CASE WHEN json_extract(excluded.data,'$.image')=''
          THEN json_set(excluded.data,'$.image',COALESCE(json_extract(products.data,'$.image'),'')) ELSE excluded.data END,
        checked_at=excluded.checked_at WHERE excluded.checked_at>=products.checked_at AND
          products.data<>CASE WHEN json_extract(excluded.data,'$.image')=''
          THEN json_set(excluded.data,'$.image',COALESCE(json_extract(products.data,'$.image'),'')) ELSE excluded.data END`,JSON.stringify(cleaned)),
      prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('synced_at',?)",String(second()))
    ]);
    return json({imported:cleaned.length});
  }
  if(path==='/api/me'&&method==='GET') {
    await ensureCatalog(env.DB);
    const [pref,saved,rows,privateRows]=await Promise.all([
      prepare('SELECT data FROM preferences WHERE user_id=?',uid).first(),
      all('SELECT product_id,folder,owned FROM saved WHERE user_id=? ORDER BY created_at DESC LIMIT 1000',uid),
      all('SELECT id,data FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50',uid),
      all(`SELECT data,overrides FROM products WHERE id IN (
        SELECT product_id FROM saved WHERE user_id=? UNION
        SELECT CAST(j.value AS INTEGER) FROM outfits o,json_each(o.data,'$.ids') j WHERE o.user_id=?)`,uid,uid)
    ]);
    return json({saved,outfits:rows.map(r=>({id:r.id,...JSON.parse(r.data)})),products:privateRows.map(product),preferences:pref?JSON.parse(pref.data):{},plan:'free',is_admin:Boolean(env.MINIAPP_ADMIN_ID)&&String(uid)===String(env.MINIAPP_ADMIN_ID)});
  }
  if(path==='/api/me'&&method==='DELETE') {
    await env.DB.batch(['saved','outfits','preferences'].map(table=>prepare(`DELETE FROM ${table} WHERE user_id=?`,uid)));return json({ok:true});
  }
  if(path==='/api/preferences'&&method==='PUT') {
    const data=await payload(request),budget=data.budget??5000,occasion=data.occasion??'everyday';
    if(!integer(budget)||budget<100||budget>100000)fail(400,'Бюджет: от 100 до 100 000 ₽');
    if(typeof occasion!=='string'||!Object.hasOwn(OCCASIONS,occasion))fail(400,'Неизвестный повод');
    await prepare('INSERT OR REPLACE INTO preferences(user_id,data) VALUES (?,?)',uid,JSON.stringify({budget,occasion})).run();return json({ok:true});
  }
  let match;
  if((match=/^\/api\/saved\/(\d+)$/.exec(path))&&['PUT','DELETE'].includes(method)) {
    const pid=Number(match[1]);if(!integer(pid))fail(400,'Некорректный товар');
    if(method==='DELETE'){await prepare('DELETE FROM saved WHERE user_id=? AND product_id=?',uid,pid).run();return json({ok:true});}
    const data=await payload(request),folder=typeof(data.folder??'Себе')==='string'?(data.folder??'Себе').trim():'',owned=data.owned??false;
    if(!folder||folder.length>40||typeof owned!=='boolean')fail(400,'Некорректная папка или отметка покупки');
    if(!await prepare('SELECT 1 FROM products WHERE id=?',pid).first())fail(404,'Товар пока не добавлен в каталог');
    // Enforce the per-user cap in the write itself, including concurrent requests.
    const result=await prepare(`INSERT INTO saved(user_id,product_id,folder,owned,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM saved WHERE user_id=?)<1000
        OR EXISTS(SELECT 1 FROM saved WHERE user_id=? AND product_id=?)
      ON CONFLICT(user_id,product_id) DO UPDATE SET folder=excluded.folder,owned=excluded.owned`,uid,pid,folder,owned?1:0,second(),uid,uid,pid).run();
    if(!result.meta.changes)fail(400,'Сохранено 1000 вещей. Удалите ненужные, чтобы добавить новую');
    // De-duplicate without storing user IDs/names in ML data. Never block saving.
    try{const kind=owned?'buy':'save',digest=await hmac(env.MINIAPP_BOT_TOKEN,`${uid}:${pid}:${kind}`),key=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');await recordEvent(env,{key,pid,kind});}catch{}
    return json({ok:true});
  }
  if(path==='/api/outfits'&&method==='POST') {
    const data=await payload(request),{anchor,budget}=data,excluded=data.exclude??[];
    if(!integer(anchor)||!integer(budget)||budget<100||budget>100000)fail(400,'Выберите вещь и бюджет от 100 до 100 000 ₽');
    if(!Array.isArray(excluded)||excluded.length>100||!excluded.every(integer))fail(400,'Некорректный список замен');
    const [products,owned]=await Promise.all([catalog(),all('SELECT product_id FROM saved WHERE user_id=? AND owned=1 LIMIT 1000',uid)]);
    let outfits;try{outfits=build(products,anchor,budget,data.occasion??'everyday',owned.map(r=>r.product_id),excluded);}catch(e){fail(400,e.message);}
    return json({outfits,message:outfits.length?'':'Пока мало свежих вещей для полного образа в этом бюджете. Попробуйте другую вещь или увеличьте бюджет.'});
  }
  if(path==='/api/outfits/saved'&&method==='POST') {
    const data=await payload(request),ids=data.ids;
    if(!Array.isArray(ids)||ids.length<2||ids.length>8||!ids.every(integer)||new Set(ids).size!==ids.length)fail(400,'Некорректный образ');
    const count=await prepare('SELECT count(*) AS n FROM products WHERE id IN (SELECT value FROM json_each(?))',JSON.stringify(ids)).first();
    if(count.n!==ids.length)fail(400,'Товар больше не доступен');
    const title=String(data.title??'Мой образ').trim().slice(0,80)||'Мой образ';
    await env.DB.batch([
      prepare('INSERT INTO outfits(user_id,data,created_at) VALUES (?,?,?)',uid,JSON.stringify({title,ids}),second()),
      prepare('DELETE FROM outfits WHERE user_id=? AND id NOT IN (SELECT id FROM outfits WHERE user_id=? ORDER BY id DESC LIMIT 50)',uid,uid)
    ]);return json({ok:true});
  }
  if((match=/^\/api\/outfits\/saved\/(\d+)$/.exec(path))&&method==='DELETE') {
    const id=Number(match[1]);if(!integer(id))fail(400,'Некорректный образ');
    await prepare('DELETE FROM outfits WHERE id=? AND user_id=?',id,uid).run();return json({ok:true});
  }
  if(path==='/api/admin/products'&&method==='GET'){admin();return json({products:await catalog()});}
  if((match=/^\/api\/admin\/products\/(\d+)$/.exec(path))&&method==='PUT') {
    admin();const pid=Number(match[1]),data=await payload(request),{slot,audience}=data,enabled=data.enabled??true;
    if(!integer(pid)||typeof slot!=='string'||!Object.hasOwn(SLOTS,slot)||!['women','men','unknown'].includes(audience)||typeof enabled!=='boolean')fail(400,'Некорректные настройки товара');
    const result=await prepare('UPDATE products SET overrides=? WHERE id=?',JSON.stringify({slot,audience,enabled}),pid).run();
    if(!result.meta.changes)fail(404,'Не найдено');await invalidateCatalog(env.DB);return json({ok:true});
  }
  fail(404,'Не найдено');
}
export default {
  async scheduled(controller,env){
    const meter=observeD1(env.DB),runtimeEnv={...env,DB:meter.DB};
    try{return await withReadBudget(runtimeEnv,'core',25000,e=>env.SCHEDULER_DRIVER==='cloudflare-native'?nativeTick(e,controller.scheduledTime):scheduledTick(e,controller.scheduledTime));}
    catch(error){const quota=d1QuotaFailure(error);console.error('SCHEDULER_ERROR',quota?.code||'RUNTIME_UNAVAILABLE',quota?{retry_at:quota.retry_at}:{});throw new Error(quota?.code||'RUNTIME_UNAVAILABLE');}
    finally{console.log('D1_BUDGET',JSON.stringify({...meter.metrics,top_queries:meter.topQueries()}));}
  },
  async fetch(request,env,ctx={waitUntil:()=>{}}) {
    const meter=observeD1(env.DB),runtimeEnv={...env,DB:meter.DB};
    const url=new URL(request.url),publicCatalog=request.method==='GET'&&url.pathname==='/api/catalog';
    const cache=globalThis.caches?.default,cacheKey=new Request(new URL('/api/catalog',url.origin));
    let response;
    try {
      const hit=publicCatalog&&cache?await cache.match(cacheKey).catch(()=>null):null;
      if(hit)response=hit;
      else {
      const path=new URL(request.url).pathname;
      // Reject unauthenticated requests before touching the budget ledger.
      let budgeted=path==='/api/catalog',lane='optional';
      if(path.startsWith('/api/scheduler/')||path==='/api/sync'){
        const key=env.MINIAPP_SYNC_KEY||'';budgeted=key.length>=32&&equal(request.headers.get('Authorization'),'Bearer '+key);lane=path==='/api/sync'||path.startsWith('/api/scheduler/learning')||path.startsWith('/api/scheduler/feedback')?'optional':'core';
      }else if(path.startsWith('/api/')&&path!=='/api/health'&&!budgeted){
        try{const uid=await telegramUser(request.headers.get('X-Telegram-Init-Data'),env.MINIAPP_BOT_TOKEN);budgeted=!path.startsWith('/api/admin/')||String(uid)===String(env.MINIAPP_ADMIN_ID);if(path.startsWith('/api/admin/')&&String(uid)===String(env.MINIAPP_ADMIN_ID)&&!path.startsWith('/api/admin/learning'))lane='core';}catch{}
      }
      const diagnostic=path==='/api/scheduler/diagnostic'&&request.method==='GET';
      if(diagnostic)lane='diagnostic';
      const readOnly=request.method==='GET'&&['/api/scheduler/config','/api/scheduler/budget','/api/scheduler/check','/api/scheduler/diagnostic'].includes(path);
      response=budgeted?await withReadBudget(runtimeEnv,lane,diagnostic?1500:lane==='core'?25000:15000,e=>route(request,e,ctx),readOnly?{writes:4}:path==='/api/scheduler/bootstrap'?{writes:5000}:{}):await route(request,runtimeEnv,ctx);
      if(publicCatalog&&cache&&response.ok){const cached=response.clone();cached.headers.set('Cache-Control','public, max-age=60');ctx.waitUntil(cache.put(cacheKey,cached).catch(()=>{}));}
      }
    } catch(error) {
      // Never include database errors, request headers or secrets in public responses/logs.
      const quota=d1QuotaFailure(error);
      response=json(quota||{error:error instanceof HttpError||error instanceof ReadBudgetError?error.message:'Сервис временно недоступен. Попробуйте позже.'},error instanceof HttpError||error instanceof ReadBudgetError?error.status:503);
      if(quota)response.headers.set('Retry-After',String(Math.max(1,quota.retry_at-second())));
    }
    if(meter.metrics.queries)console.log('D1_BUDGET_HTTP',JSON.stringify({...meter.metrics,top_queries:meter.topQueries()}));
    const secured=new Response(response.body,response);
    for(const [key,value] of Object.entries(headers))secured.headers.set(key,value);
    // Telegram UI uses React style props; relax styles ONLY for the admin shell.
    // Script policy and the public application's policy remain unchanged.
    if(url.pathname==='/admin'||url.pathname.startsWith('/admin/'))secured.headers.set('Content-Security-Policy',headers['Content-Security-Policy'].replace("style-src 'self'","style-src 'self' 'unsafe-inline'"));
    secured.headers.set('Cache-Control',new URL(request.url).pathname.startsWith('/api/')?'no-store':'no-cache');
    return secured;
  }
};
