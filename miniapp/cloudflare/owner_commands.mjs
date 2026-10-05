import {telegram} from './feedback.mjs';
import {nextPost} from './admin_api.mjs';
const now=()=>Math.floor(Date.now()/1000);
const q=(e,sql,...args)=>e.DB.prepare(sql).bind(...args);
const stamp=(ts,zone)=>ts?new Intl.DateTimeFormat('ru-RU',{timeZone:zone,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ts*1000)):'пока нет';
export function ownerCommand(update){
  const m=update.message;
  if(m?.chat?.type!=='private'||m.from?.is_bot||!Number.isSafeInteger(update.update_id)||update.update_id<0||!Number.isSafeInteger(m.from?.id))return null;
  if(/^\/start(?:@[a-zA-Z0-9_]+)?\s+admin\s*$/i.test(m.text||''))return 'admin';
  return /^\/(help|status|admin)(?:@[a-zA-Z0-9_]+)?\s*$/i.exec(m.text||'')?.[1].toLowerCase()||null;
}
export async function handleOwnerCommand(e,update,origin,fetcher=fetch){
  const command=ownerCommand(update),m=update.message;
  if(!command||!e.MINIAPP_ADMIN_ID||String(m.from.id)!==String(e.MINIAPP_ADMIN_ID)||String(m.chat.id)!==String(e.MINIAPP_ADMIN_ID))return {ignored:true};
  const key='owner_command_'+command,ts=now(),start=Date.now();
  // A per-command watermark prevents Telegram webhook redelivery from sending
  // duplicate replies. Explicit Telegram failures can retry; ambiguous sends cannot.
  const claim=await q(e,`INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE json_extract(metadata.value,'$.update_id')<json_extract(excluded.value,'$.update_id')
    OR (json_extract(metadata.value,'$.update_id')=json_extract(excluded.value,'$.update_id') AND ((json_extract(metadata.value,'$.state')='retry' AND json_extract(metadata.value,'$.retry_at')<=?) OR (json_extract(metadata.value,'$.state')='preparing' AND json_extract(metadata.value,'$.at')<?)))`,key,JSON.stringify({update_id:update.update_id,command,state:'preparing',at:ts}),ts,ts-15).run();
  if(!claim.meta.changes){
    const prior=JSON.parse((await q(e,'SELECT value FROM metadata WHERE key=?',key).first()).value);
    if(prior.update_id===update.update_id&&['retry','preparing'].includes(prior.state))throw Error('Owner reply retry pending');
    return {duplicate:true};
  }
  const write=value=>q(e,"UPDATE metadata SET value=? WHERE key=? AND json_extract(value,'$.update_id')=?",JSON.stringify({update_id:update.update_id,command,at:ts,...value}),key,update.update_id).run();
  let text=command==='admin'?'⚙️ Управление каналом':'Управление каналом\n/admin — открыть админку\n/status — состояние канала\n/help — это меню';
  if(command==='status'){
    try{
      const row=await q(e,'SELECT data,status,(SELECT ready FROM scheduler_counts WHERE id=1) AS ready,(SELECT MAX(ts) FROM scheduler_posts) AS last_post FROM scheduler_config WHERE id=1').first();
      if(!row)throw Error('Missing settings');
      const s=JSON.parse(row.data),status=JSON.parse(row.status),zone=s.timezone,last=Math.max(row.last_post||0,status.last_post_success||0),retry=Number(status.search_retry_at||0);
      text=`Автопостинг: ${s.enabled&&!s.paused?'🟢 ON':'🔴 OFF'}\nИнтервал публикации: ${s.post_interval_minutes} мин${s.mode==='times'?' (режим точного времени)':''}\nОчередь: ${row.ready??0}\nПоследний пост: ${stamp(last,zone)}\nСледующий пост: ${stamp(nextPost(s,last),zone)}\nПоследний поиск WB: ${stamp(status.last_search_success||status.last_scan_success,zone)}\nWB backoff: ${retry>ts?'до '+stamp(retry,zone):'нет'}\nВремя: ${zone}`;
    }catch{await write({state:'retry',retry_at:ts});throw Error('Owner status temporarily unavailable');}
  }
  await write({state:'sending'});
  let result;
  try{result=await telegram(e,'sendMessage',{chat_id:e.MINIAPP_ADMIN_ID,text,reply_markup:{inline_keyboard:[[{text:'⚙️ Открыть админку',web_app:{url:new URL('/admin',origin).href}}]]}},fetcher,4000);}
  catch{await write({state:'uncertain',error:'Telegram response timeout',latency_ms:Date.now()-start});return {uncertain:true};}
  if(!result.ok){
    const permanent=[400,401,403].includes(Number(result.error_code));
    await write({state:permanent?'failed':'retry',retry_at:ts+Math.min(3600,Math.max(5,Number(result.parameters?.retry_after)||5)),error:'Telegram '+Number(result.error_code||0)});
    if(permanent)return {failed:true};throw Error('Owner Telegram reply failed');
  }
  const receipt={state:'sent',message_id:result.result.message_id,latency_ms:Date.now()-start,admin_url:new URL('/admin',origin).href};
  await write(receipt);console.log('OWNER_COMMAND_REPLY',JSON.stringify({command,update_id:update.update_id,...receipt}));
  return receipt;
}
export async function setupOwnerMenu(e,origin,fetcher=fetch){
  if(!/^\d+$/.test(String(e.MINIAPP_ADMIN_ID))||!e.TG_BOT_TOKEN)throw Error('Owner configuration missing');
  const me=await telegram(e,'getMe',{},fetcher,4000);
  if(!me.ok)throw Error('Main bot authentication failed');
  const menu={type:'web_app',text:'⚙️ Админка',web_app:{url:new URL('/admin',origin).href}};
  const result=await telegram(e,'setChatMenuButton',{chat_id:Number(e.MINIAPP_ADMIN_ID),menu_button:menu},fetcher,4000);
  if(!result.ok)throw Error('Owner menu setup failed');
  const list=await telegram(e,'setMyCommands',{scope:{type:'chat',chat_id:Number(e.MINIAPP_ADMIN_ID)},commands:[{command:'help',description:'Меню управления'},{command:'status',description:'Состояние канала'},{command:'admin',description:'Открыть админку'}]},fetcher,4000);
  if(!list.ok)throw Error('Owner commands setup failed');
  const checked=await telegram(e,'getChatMenuButton',{chat_id:Number(e.MINIAPP_ADMIN_ID)},fetcher,4000);
  if(!checked.ok||checked.result?.web_app?.url!==menu.web_app.url)throw Error('Owner menu not confirmed');
  const receipt={at:now(),bot_id:me.result.id,username:me.result.username,menu_ok:true,commands_ok:true,admin_url:menu.web_app.url};
  await q(e,"INSERT OR REPLACE INTO metadata VALUES('owner_bot',?)",JSON.stringify(receipt)).run();return receipt;
}
export async function ownerEvidence(e,origin,fetcher=fetch){
  const rows=(await q(e,"SELECT key,value FROM metadata WHERE key IN ('owner_bot','owner_admin_open','owner_command_help','owner_command_status','owner_command_admin') LIMIT 5").all()).results;
  const info=await telegram(e,'getWebhookInfo',{},fetcher,4000);
  return {receipts:Object.fromEntries(rows.map(r=>[r.key,JSON.parse(r.value)])),webhook_ok:info.ok&&info.result.url===new URL('/telegram/main/webhook',origin).href,pending_updates:info.result?.pending_update_count||0,last_error:info.result?.last_error_message||'',runtime_version:e.CF_VERSION?.id||null};
}
