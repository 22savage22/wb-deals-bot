import {telegramUser,equal} from './auth.mjs';
import {normalize,build,integer,SLOTS,OCCASIONS} from './domain.mjs';

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
  if(path==='/telegram/webhook'&&method==='POST') {
    const secret=env.MINIAPP_WEBHOOK_SECRET||'';
    if(secret.length<32||!equal(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),secret))fail(403,'Нет доступа');
    const update=await payload(request),message=update.message;
    if(message?.chat?.type==='private'&&integer(message.chat.id)&&typeof message.text==='string') {
      const command=/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+((?:save|look)_\d{1,12}))?\s*$/.exec(message.text);
      if(command) {
        const app=new URL('/',url.origin);if(command[1])app.searchParams.set('tgWebAppStartParam',command[1]);
        const send=fetch(`https://api.telegram.org/bot${env.MINIAPP_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:message.chat.id,text:'Добро пожаловать в «Находки»! Сохраняйте понравившиеся вещи и собирайте образы в своём бюджете.',reply_markup:{inline_keyboard:[[{text:'Открыть находки ✨',web_app:{url:app.href}}]]}})}).then(r=>{if(!r.ok)throw new Error('Telegram delivery failed');});
        // No callback work blocks Telegram's acknowledgement; no credentials are logged.
        ctx.waitUntil(send.catch(()=>{}));
      }
    }
    return json({ok:true});
  }
  if(!path.startsWith('/api/')) {
    if(!['GET','HEAD'].includes(method)) fail(405,'Метод не поддерживается');
    if(!['/','/index.html','/static/app.js','/static/app.css'].includes(path))fail(404,'Не найдено');
    const assetURL=new URL(url);assetURL.pathname=path==='/'?'/index.html':path;
    return env.ASSETS.fetch(new Request(assetURL,request));
  }
  const prepare=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  const all=async(sql,...args)=>(await prepare(sql,...args).all()).results;
  const catalog=async()=> (await all('SELECT data,overrides FROM products ORDER BY checked_at DESC LIMIT 3000')).map(product);
  let uid;
  if(!['/api/catalog','/api/sync','/api/health'].includes(path)) {
    try{uid=await telegramUser(request.headers.get('X-Telegram-Init-Data'),env.MINIAPP_BOT_TOKEN);}catch{fail(401,'Откройте приложение заново через Telegram');}
    // Optional Cloudflare rate-limiter binding. Identity comes only from verified Telegram data.
    if(env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({key:String(uid)})).success)fail(429,'Слишком много запросов. Подождите минуту.');
  }
  const admin=()=>{if(!env.MINIAPP_ADMIN_ID||String(uid)!==String(env.MINIAPP_ADMIN_ID))fail(403,'Доступ только владельцу');};
  if(path==='/api/health'&&method==='GET') {
    await prepare('SELECT 1').first();return json({ok:true,configured:Boolean(env.MINIAPP_BOT_TOKEN&&env.MINIAPP_SYNC_KEY?.length>=32)});
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
    const [pref,saved,rows,privateRows]=await Promise.all([
      prepare('SELECT data FROM preferences WHERE user_id=?',uid).first(),
      all('SELECT product_id,folder,owned FROM saved WHERE user_id=? ORDER BY created_at DESC',uid),
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
    if(!result.meta.changes)fail(400,'Сохранено 1000 вещей. Удалите ненужные, чтобы добавить новую');return json({ok:true});
  }
  if(path==='/api/outfits'&&method==='POST') {
    const data=await payload(request),{anchor,budget}=data,excluded=data.exclude??[];
    if(!integer(anchor)||!integer(budget)||budget<100||budget>100000)fail(400,'Выберите вещь и бюджет от 100 до 100 000 ₽');
    if(!Array.isArray(excluded)||excluded.length>100||!excluded.every(integer))fail(400,'Некорректный список замен');
    const [products,owned]=await Promise.all([catalog(),all('SELECT product_id FROM saved WHERE user_id=? AND owned=1',uid)]);
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
    if(!result.meta.changes)fail(404,'Не найдено');return json({ok:true});
  }
  fail(404,'Не найдено');
}
export default {
  async fetch(request,env,ctx={waitUntil:()=>{}}) {
    let response;
    try {response=await route(request,env,ctx);} catch(error) {
      // Never include database errors, request headers or secrets in public responses/logs.
      response=json({error:error instanceof HttpError?error.message:'Сервис временно недоступен. Попробуйте позже.'},error instanceof HttpError?error.status:503);
    }
    const secured=new Response(response.body,response);
    for(const [key,value] of Object.entries(headers))secured.headers.set(key,value);
    secured.headers.set('Cache-Control',new URL(request.url).pathname.startsWith('/api/')?'no-store':'no-cache');
    return secured;
  }
};
