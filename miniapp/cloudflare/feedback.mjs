// Persistent channel reactions. No WB requests, no RAM vote counters.
import {hmac,equal} from './auth.mjs';
import {recordEvent} from './learning.mjs';
const now=()=>Math.floor(Date.now()/1000);
const q=(e,s,...v)=>e.DB.prepare(s).bind(...v);
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
export const webhookSecret=async e=>hex(await hmac(e.MINIAPP_SYNC_KEY,'wb-channel-webhook-v1'));
const schema=[
 `CREATE TABLE IF NOT EXISTS reaction_totals(scope TEXT NOT NULL,pid INTEGER NOT NULL,likes INTEGER NOT NULL DEFAULT 0,dislikes INTEGER NOT NULL DEFAULT 0,bought INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,pid))`,
 `CREATE TABLE IF NOT EXISTS reaction_votes(scope TEXT NOT NULL,pid INTEGER NOT NULL,voter TEXT NOT NULL,sentiment TEXT NOT NULL DEFAULT '',bought INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,last_event INTEGER NOT NULL,last_changed_event INTEGER NOT NULL,PRIMARY KEY(scope,pid,voter))`,
 `CREATE TRIGGER IF NOT EXISTS reaction_insert AFTER INSERT ON reaction_votes BEGIN UPDATE reaction_totals SET likes=likes+(NEW.sentiment='l'),dislikes=dislikes+(NEW.sentiment='d'),bought=bought+NEW.bought,revision=revision+1 WHERE scope=NEW.scope AND pid=NEW.pid; END`,
 `CREATE TRIGGER IF NOT EXISTS reaction_update AFTER UPDATE ON reaction_votes WHEN NEW.sentiment<>OLD.sentiment OR NEW.bought<>OLD.bought BEGIN UPDATE reaction_totals SET likes=likes+(NEW.sentiment='l')-(OLD.sentiment='l'),dislikes=dislikes+(NEW.sentiment='d')-(OLD.sentiment='d'),bought=bought+NEW.bought-OLD.bought,revision=revision+1 WHERE scope=NEW.scope AND pid=NEW.pid; END`,
 `CREATE TABLE IF NOT EXISTS reaction_messages(chat TEXT NOT NULL,message_id INTEGER NOT NULL,scope TEXT NOT NULL,pid INTEGER NOT NULL,markup TEXT NOT NULL,dirty INTEGER NOT NULL DEFAULT 1,retry_at INTEGER NOT NULL DEFAULT 0,lease TEXT,lease_until INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',receipt TEXT,PRIMARY KEY(chat,message_id))`,
 `CREATE INDEX IF NOT EXISTS reaction_dirty ON reaction_messages(dirty,retry_at,lease_until)`,
 `CREATE INDEX IF NOT EXISTS reaction_product ON reaction_messages(scope,pid)`,
 `CREATE TABLE IF NOT EXISTS reaction_admin_updates(update_id INTEGER PRIMARY KEY,data TEXT NOT NULL,ts INTEGER NOT NULL)`
];
export async function ensureReactions(e){
 const row=await q(e,"SELECT value FROM metadata WHERE key='reactions_schema'").first();
 if(row?.value==='1')return;
 await e.DB.batch(schema.map(s=>q(e,s)));
 await q(e,"INSERT OR REPLACE INTO metadata VALUES('reactions_schema','1')").run();
 await q(e,"UPDATE scheduler_config SET status=json_set(status,'$.reactions_initialized',1) WHERE id=1").run();
}
export function reactionMarkup(markup,pid,totals){
 const labels={['l'+pid]:'👍 '+totals.likes,['d'+pid]:'👎 '+totals.dislikes,['b'+pid]:'🛒 Купил '+totals.bought};
 return {inline_keyboard:markup.inline_keyboard.map(row=>row.map(b=>labels[b.callback_data]?{...b,text:labels[b.callback_data]}:{...b}))};
}
export async function telegram(e,method,body,fetcher=fetch,ms=8000){
 const response=await fetcher(`https://api.telegram.org/bot${e.TG_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(ms)});
 return response.json();
}
export async function registerMessage(e,{chat,message_id,pid,markup,scope='channel'}){
 await q(e,`INSERT INTO reaction_messages(chat,message_id,scope,pid,markup) VALUES(?,?,?,?,?)
 ON CONFLICT(chat,message_id) DO UPDATE SET dirty=1 WHERE reaction_messages.pid=excluded.pid AND reaction_messages.scope=excluded.scope`,String(chat),message_id,scope,pid,JSON.stringify(markup)).run();
}
export async function seedLegacy(e,rows){
 // Immutable legacy baseline: historical JSON has timestamps, NOT vote choices.
 // It cannot be reconstructed into per-person sentiments without inventing data.
 await ensureReactions(e);
 const clean=rows.filter(r=>Number.isSafeInteger(r.pid)&&r.pid>0).map(r=>({pid:r.pid,...Object.fromEntries(['likes','dislikes','bought'].map(k=>[k,Math.max(0,Math.min(100000,Math.floor(Number(r[k])||0)))]))}));
 await q(e,`INSERT OR IGNORE INTO reaction_totals(scope,pid,likes,dislikes,bought)
 SELECT 'channel',json_extract(value,'$.pid'),json_extract(value,'$.likes'),json_extract(value,'$.dislikes'),json_extract(value,'$.bought') FROM json_each(?)`,JSON.stringify(clean)).run();
 return {imported:clean.length};
}
export async function vote(e,{scope='channel',pid,voter,action,event_id}){
 if(!['l','d','b'].includes(action)||!Number.isSafeInteger(pid)||pid<=0||typeof voter!=='string'||!voter||!Number.isSafeInteger(event_id)||event_id<0)throw Error('Invalid reaction');
 const key=hex(await hmac(e.MINIAPP_SYNC_KEY,`reaction:${scope}:${voter}`));
 const sentiment=action==='b'?'':action,bought=action==='b'?1:0;
 const result=await e.DB.batch([
 q(e,'INSERT OR IGNORE INTO reaction_totals(scope,pid) VALUES(?,?)',scope,pid),
 q(e,`INSERT INTO reaction_votes(scope,pid,voter,sentiment,bought,last_event,last_changed_event) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(scope,pid,voter) DO UPDATE SET sentiment=CASE WHEN excluded.sentiment='' THEN reaction_votes.sentiment ELSE excluded.sentiment END,
 bought=MAX(reaction_votes.bought,excluded.bought),last_event=excluded.last_event,
 last_changed_event=CASE WHEN (excluded.sentiment<>'' AND reaction_votes.sentiment<>excluded.sentiment) OR excluded.bought>reaction_votes.bought THEN excluded.last_event ELSE reaction_votes.last_changed_event END,
 revision=reaction_votes.revision+CASE WHEN (excluded.sentiment<>'' AND reaction_votes.sentiment<>excluded.sentiment) OR excluded.bought>reaction_votes.bought THEN 1 ELSE 0 END
 WHERE excluded.last_event>reaction_votes.last_event`,scope,pid,key,sentiment,bought,event_id,event_id),
 q(e,"UPDATE reaction_messages SET dirty=1,retry_at=0 WHERE scope=? AND pid=?",scope,pid)
 ]);
 const totals=await q(e,'SELECT likes,dislikes,bought,revision FROM reaction_totals WHERE scope=? AND pid=?',scope,pid).first();
 const row=await q(e,'SELECT revision,last_changed_event FROM reaction_votes WHERE scope=? AND pid=? AND voter=?',scope,pid,key).first();
 const changed=!!result[1].meta.changes&&row.last_changed_event===event_id;
 if(changed&&scope==='channel')try{
   await recordEvent(e,{key:`reaction:${pid}:${key}:${row.revision}`,pid,kind:{l:'like',d:'dislike',b:'buy'}[action]});
   // The legacy importer must not learn this same native signal a second time.
   await q(e,`INSERT INTO learning_feedback(pid,likes,dislikes,bought) VALUES(?,?,?,?) ON CONFLICT(pid) DO UPDATE SET likes=MAX(likes,excluded.likes),dislikes=MAX(dislikes,excluded.dislikes),bought=MAX(bought,excluded.bought)`,pid,totals.likes,totals.dislikes,totals.bought).run();
 }catch{console.log('REACTION_LEARNING deferred; vote retained');}
 return {changed,totals};
}
export async function refreshMessage(e,chat,message_id,fetcher=fetch){
 chat=String(chat);
 for(let n=0;n<3;n++){
   const owner=crypto.randomUUID(),ts=now();
   const acquired=await q(e,'UPDATE reaction_messages SET lease=?,lease_until=? WHERE chat=? AND message_id=? AND dirty=1 AND retry_at<=? AND lease_until<=?',owner,ts+90,chat,message_id,ts,ts).run();
   if(!acquired.meta.changes)return {pending:true};
   const row=await q(e,`SELECT m.*,t.likes,t.dislikes,t.bought,t.revision FROM reaction_messages m JOIN reaction_totals t ON t.scope=m.scope AND t.pid=m.pid WHERE m.chat=? AND m.message_id=?`,chat,message_id).first();
   const markup=reactionMarkup(JSON.parse(row.markup),row.pid,row);
   let result;
   try{result=await telegram(e,'editMessageReplyMarkup',{chat_id:chat,message_id,reply_markup:markup},fetcher);}catch{
     // Unknown network outcome: don't overlap the in-flight editor. Cron repairs
     // the current totals after the 90s lease expires, without losing the vote.
     await q(e,"UPDATE reaction_messages SET error='Telegram edit outcome unknown',retry_at=? WHERE chat=? AND message_id=? AND lease=?",ts+90,chat,message_id,owner).run();return {pending:true};
   }
   const unmodified=Number(result.error_code)===400&&/message is not modified/i.test(result.description||'');
   if(!result.ok&&!unmodified){
     const permanent=Number(result.error_code)===403||Number(result.error_code)===400&&/message to edit not found|message can.t be edited/i.test(result.description||'');
     await q(e,"UPDATE reaction_messages SET lease=NULL,lease_until=0,dirty=?,retry_at=?,error=? WHERE chat=? AND message_id=? AND lease=?",permanent?0:1,ts+Math.max(60,Math.min(3600,Number(result.parameters?.retry_after)||60)),`Telegram markup error ${Number(result.error_code)||0}`,chat,message_id,owner).run();return {pending:true};
   }
   const receipt={message_id,totals:{likes:row.likes,dislikes:row.dislikes,bought:row.bought},reply_markup:result.result?.reply_markup||markup,ts:now()};
   await q(e,`UPDATE reaction_messages SET dirty=CASE WHEN (SELECT revision FROM reaction_totals WHERE scope=reaction_messages.scope AND pid=reaction_messages.pid)=? THEN 0 ELSE 1 END,
     lease=NULL,lease_until=0,error='',receipt=? WHERE chat=? AND message_id=? AND lease=?`,row.revision,JSON.stringify(receipt),chat,message_id,owner).run();
   if(!(await q(e,'SELECT dirty FROM reaction_messages WHERE chat=? AND message_id=?',chat,message_id).first()).dirty)return receipt;
 }
 return {pending:true};
}
export async function repairReactions(e,fetcher=fetch){
 const rows=(await q(e,'SELECT chat,message_id FROM reaction_messages WHERE dirty=1 AND retry_at<=? AND lease_until<=? LIMIT 2',now(),now()).all()).results;
 // One per minute also bounds Telegram/D1 work on a broken/deleted message.
 if(rows[0])await refreshMessage(e,rows[0].chat,rows[0].message_id,fetcher);
}
export async function processCallback(e,cb,fetcher=fetch,defer=null){
 const match=/^([ldb])(\d{1,12})$/.exec(String(cb.data||'')),msg=cb.message;
 if(!match||!Number.isSafeInteger(msg?.message_id)||!Number.isSafeInteger(cb.from?.id)||cb.from.id<=0||!Array.isArray(msg.reply_markup?.inline_keyboard))return {ignored:true};
 const pid=Number(match[2]),chat=String(msg.chat?.id);
 if(pid<=0||!Number.isSafeInteger(cb.update_id)||cb.update_id<0)return {ignored:true};
 if(!msg.reply_markup.inline_keyboard.flat().some(b=>b.callback_data===cb.data))return {ignored:true};
 await ensureReactions(e);
 const existing=await q(e,'SELECT scope,pid FROM reaction_messages WHERE chat=? AND message_id=?',chat,msg.message_id).first();
 const policy=JSON.parse((await q(e,'SELECT data FROM scheduler_policy WHERE id=1').first()).data);
 if(chat!==String(policy.chat_id)&&!(existing?.scope.startsWith('test:')&&chat===String(e.MINIAPP_ADMIN_ID)))return {ignored:true};
 const scope=existing?.scope||'channel';if(existing&&existing.pid!==pid)return {ignored:true};
 if(scope==='channel')try{
   // Old D1 aggregate totals also survive when the JSON record was pruned.
   // Lazy import is a single primary-key lookup; never scan feedback history.
   await q(e,`INSERT OR IGNORE INTO reaction_totals(scope,pid,likes,dislikes,bought) SELECT 'channel',pid,likes,dislikes,bought FROM learning_feedback WHERE pid=?`,pid).run();
 }catch(error){if(!/no such table.*learning_feedback/.test(String(error.message)))throw error;}
 await registerMessage(e,{chat,message_id:msg.message_id,pid,markup:msg.reply_markup,scope});
 const saved=await vote(e,{scope,pid,voter:String(cb.from.id),action:match[1],event_id:cb.update_id});
 console.log('FEEDBACK_TOTALS',JSON.stringify({pid,...saved.totals}));
 if(saved.changed&&scope==='channel'){
   const card=await q(e,'SELECT data FROM scheduler_inventory WHERE pid=? UNION ALL SELECT data FROM products WHERE id=? LIMIT 1',pid,pid).first();
   const p=card?JSON.parse(card.data):{};
   await q(e,'INSERT OR IGNORE INTO reaction_admin_updates VALUES(?,?,?)',cb.update_id,JSON.stringify({update_id:cb.update_id,feedback_event:{pid,query:p.query||null,cat:p.category||p.cat||null,action:{l:'likes',d:'dislikes',b:'bought'}[match[1]],totals:saved.totals,ts:now()}}),now()).run();
 }
 let receipt;if(defer){defer(env=>refreshMessage(env,chat,msg.message_id,fetcher));receipt={pending:true};}else receipt=await refreshMessage(e,chat,msg.message_id,fetcher);
 return {...saved,receipt};
}
export async function handleMainUpdate(e,update,fetcher=fetch,defer=null){
 const cb=update.callback_query;
 if(cb&&/^([ldb])(\d{1,12})$/.test(cb.data||''))return processCallback(e,{...cb,update_id:update.update_id},fetcher,defer);
 const user=cb?.from||update.message?.from;
 if(String(user?.id)!==String(e.MINIAPP_ADMIN_ID))return {ignored:true};
 const msg=cb?.message||update.message;
 if(!Number.isSafeInteger(update.update_id)||String(msg?.chat?.id)!==String(e.MINIAPP_ADMIN_ID))return {ignored:true};
 await ensureReactions(e);
 // Only owner's command fields, no subscriber messages/cookies/credentials.
 const safe={update_id:update.update_id,...(cb?{callback_query:{id:'',data:String(cb.data||'').slice(0,100),from:{id:user.id},message:{chat:{id:msg.chat.id,type:'private'},message_id:msg.message_id}}}:{message:{from:{id:user.id},chat:{id:msg.chat.id,type:'private'},text:String(msg.text||'').slice(0,4000)}})};
 await q(e,'INSERT OR IGNORE INTO reaction_admin_updates VALUES(?,?,?)',update.update_id,JSON.stringify(safe),now()).run();
 return {queued:true};
}
export async function feedbackRoute(request,e,{payload,json,fail},fetcher=fetch){
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/api/scheduler/feedback'))return null;
 await ensureReactions(e);
 if(path.endsWith('/seed')&&request.method==='POST'){const data=await payload(request);if(!Array.isArray(data.rows)||data.rows.length>100)fail(400,'До 100 товаров');return json(await seedLegacy(e,data.rows));}
 if(path.endsWith('/callback')&&request.method==='POST')return json(await processCallback(e,(await payload(request)).callback,fetcher));
 if(path.endsWith('/updates')&&request.method==='POST'){
   const data=await payload(request);
   if(Number.isSafeInteger(data.offset)&&data.offset>=0)await q(e,'DELETE FROM reaction_admin_updates WHERE update_id<?',data.offset).run();
   const rows=(await q(e,'SELECT data FROM reaction_admin_updates ORDER BY update_id LIMIT 20').all()).results;
   return json({updates:rows.map(r=>JSON.parse(r.data))});
 }
 if(path.endsWith('/activate')&&request.method==='POST'){
   const root=new URL(request.url).origin;
   const info=await telegram(e,'getWebhookInfo',{},fetcher);
   if(!info.ok)fail(503,'Не удалось проверить webhook');
   if(info.result.url&&info.result.url!==root+'/telegram/main/webhook')fail(409,'Другой webhook уже настроен; не заменён');
   const result=await telegram(e,'setWebhook',{url:root+'/telegram/main/webhook',secret_token:await webhookSecret(e),allowed_updates:['callback_query','message'],drop_pending_updates:false,max_connections:20},fetcher);
   if(!result.ok)fail(503,'Не удалось включить webhook');
   const checked=await telegram(e,'getWebhookInfo',{},fetcher);
   return json({webhook_ok:checked.ok&&checked.result.url===root+'/telegram/main/webhook',pending_updates:checked.result?.pending_update_count||0,last_error:checked.result?.last_error_message?'Telegram webhook delivery error':''});
 }
 if(path.endsWith('/status')&&!path.includes('/test/')&&request.method==='GET'){
   const result=await telegram(e,'getWebhookInfo',{},fetcher),row=await q(e,"SELECT value FROM metadata WHERE key='reaction_last_callback'").first();
   return json({webhook_ok:result.ok&&result.result.url===new URL('/telegram/main/webhook',request.url).href,pending_updates:result.result?.pending_update_count||0,webhook_error:result.result?.last_error_message?'Telegram delivery error':'',last_callback:row?JSON.parse(row.value):null});
 }
 if(path.endsWith('/repair_latest')&&request.method==='POST'){
   const row=await q(e,'SELECT pid,message_id FROM scheduler_deliveries WHERE message_id IS NOT NULL ORDER BY ts DESC LIMIT 1').first();
   if(!row)fail(404,'Нет опубликованного сообщения');
   const policy=JSON.parse((await q(e,'SELECT data FROM scheduler_policy WHERE id=1').first()).data);
   const launch=e.MINIAPP_LINK_MODE==='startapp'?'startapp':'start',link=`https://t.me/${e.MINIAPP_BOT_USERNAME||'WbPodborr_bot'}?${launch}=`;
   const markup={inline_keyboard:[[{text:'Открыть на WB',url:`https://www.wildberries.ru/catalog/${row.pid}/detail.aspx`}],[{text:'👍 0',callback_data:'l'+row.pid},{text:'👎 0',callback_data:'d'+row.pid},{text:'🛒 Купил 0',callback_data:'b'+row.pid}],[{text:'🔖 Сохранить',url:link+'save_'+row.pid},{text:'✨ Собрать образ',url:link+'look_'+row.pid}]]};
   await q(e,"INSERT OR IGNORE INTO reaction_totals(scope,pid) VALUES('channel',?)",row.pid).run();
   await registerMessage(e,{chat:policy.chat_id,message_id:row.message_id,pid:row.pid,markup});
   return json(await refreshMessage(e,policy.chat_id,row.message_id,fetcher));
 }
 if(path.includes('/test/')&&request.method==='POST'){
   const data=await payload(request),id=data.request_id;
   if(typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,70}$/.test(id))fail(400,'Некорректный тест');
   const key='reaction_test:'+id,stored=await q(e,'SELECT value FROM metadata WHERE key=?',key).first();
   if(path.endsWith('/create')){
     if(stored){const value=JSON.parse(stored.value);if(!value.message_id)fail(409,'Предыдущая доставка имеет неизвестный результат; новый пост не создан');return json(value);}
     const row=await q(e,'SELECT status FROM scheduler_config WHERE id=1').first(),pid=Number(JSON.parse(row.status).selected_product);
     if(!Number.isSafeInteger(pid)||pid<=0)fail(503,'Нет реального товара для теста');
     const inserted=await q(e,'INSERT OR IGNORE INTO metadata VALUES(?,?)',key,JSON.stringify({state:'attempted'})).run();
     if(!inserted.meta.changes)fail(409,'Тест уже запускается');
     const markup={inline_keyboard:[[{text:'Открыть на WB',url:`https://www.wildberries.ru/catalog/${pid}/detail.aspx`}],[{text:'👍 0',callback_data:'l'+pid},{text:'👎 0',callback_data:'d'+pid},{text:'🛒 Купил 0',callback_data:'b'+pid}]]};
     const result=await telegram(e,'sendMessage',{chat_id:e.MINIAPP_ADMIN_ID,text:'🔬 Проверка счётчиков реакций. Тестовые A/B изолированы от канала и обучения.',reply_markup:markup},fetcher);
     if(!result.ok)fail(503,'Тестовое сообщение не доставлено владельцу');
     const value={message_id:result.result.message_id,chat:String(e.MINIAPP_ADMIN_ID),pid,scope:'test:'+id,initial_reply_markup:result.result.reply_markup};
     await q(e,'INSERT OR IGNORE INTO reaction_totals(scope,pid) VALUES(?,?)',value.scope,pid).run();
     await registerMessage(e,{...value,markup});
     await q(e,'UPDATE metadata SET value=? WHERE key=?',JSON.stringify(value),key).run();
     return json(value);
   }
   if(!stored)fail(404,'Сначала создайте тест');const value=JSON.parse(stored.value);
   if(!value.message_id)fail(409,'Неизвестный результат доставки');
   if(path.endsWith('/step')){
     if(![1,2,3].includes(data.step))fail(400,'Шаг1–3');
     const stepKey=key+':'+data.step,done=await q(e,'SELECT value FROM metadata WHERE key=?',stepKey).first();
     if(done)return json(JSON.parse(done.value));
     if(data.step>1&&!await q(e,'SELECT value FROM metadata WHERE key=?',key+':'+(data.step-1)).first())fail(409,'Сначала предыдущий шаг');
     const saved=await vote(e,{...value,voter:data.step===2?'controlled-test-B':'controlled-test-A',action:data.step===3?'d':'l',event_id:data.step});
     const receipt=await refreshMessage(e,value.chat,value.message_id,fetcher);
     if(receipt.pending)fail(503,'Клавиатура ожидает восстановления; голос уже сохранён');
     const proof={test_actors:'controlled, not real Telegram user identities',step:data.step,...saved,receipt};
     await q(e,'INSERT OR IGNORE INTO metadata VALUES(?,?)',stepKey,JSON.stringify(proof)).run();return json(proof);
   }
   if(path.endsWith('/status'))return json({...value,totals:await q(e,'SELECT likes,dislikes,bought FROM reaction_totals WHERE scope=? AND pid=?',value.scope,value.pid).first(),message:await q(e,'SELECT dirty,error,receipt FROM reaction_messages WHERE chat=? AND message_id=?',value.chat,value.message_id).first()});
 }
 return null;
}
