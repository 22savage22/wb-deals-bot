import {selectionSettings,validateSelection,similarity,querySuggestions} from './selection_policy.mjs';
import {policyState,queryRules} from './query_control.mjs';
import {ensureControl,auditStatement,pruneChanges} from './admin_history.mjs';
import {qualitySettings,validateQuality,QUALITY_CATEGORIES,candidateQuality,qualityRank} from './audience_quality.mjs';
import {audienceContext,feedbackSummary} from './audience_feedback.mjs';
import {selectionReason} from './selection_policy.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a);
export async function saveQuality(e,input,fail){
  if(input.confirmed!==true||typeof input.request_id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(input.request_id))fail(400,'Подтвердите изменение правил');
  const key='quality-save:'+input.request_id;
  if(await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first())return {ok:true,duplicate:true};
  const current=await policyState(e);if(input.revision!==current.revision)fail(409,'Настройки изменились. Обновите страницу');
  let value;try{value=validateQuality(input.settings);}catch(er){fail(400,er.message);}
  if(value.enabled){const indexes=(await q(e,"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('reaction_votes_quality_recent','scheduler_inventory_quality')").all()).results;if(indexes.length!==2)fail(409,'Сначала требуется проверенная миграция индексов качества');}
  const next={...current.policy,audience_quality:value};await ensureControl(e);
  const results=await e.DB.batch([
    q(e,'UPDATE scheduler_policy SET data=? WHERE id=1 AND data=? AND NOT EXISTS(SELECT 1 FROM scheduler_actions WHERE request_id=?)',JSON.stringify(next),current.raw,key),
    auditStatement(e,'audience_quality',qualitySettings(current.policy),value),
    q(e,'INSERT OR IGNORE INTO scheduler_actions(request_id,ts) SELECT ?,? WHERE changes()>0',key,Math.floor(Date.now()/1000))
  ]);
  if(!results[0].meta.changes){if(await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first())return {ok:true,duplicate:true};fail(409,'Настройки изменились во время сохранения');}
  await pruneChanges(e);return {ok:true};
}
export async function saveSelection(e,input,fail){
  // Loading examples, stale clients and background refreshes must never activate
  // a new policy. Require the explicit owner-confirmed save contract, not a GET
  // revision alone. Telegram signature/owner verification still happens first.
  if(input.confirmed!==true||typeof input.request_id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(input.request_id))fail(400,'Подтвердите сохранение в обновлённой админке. Настройки не изменены');
  const key='selection-save:'+input.request_id;
  if(await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first())return {ok:true,duplicate:true};
  const old=await policyState(e);if(input.revision!==old.revision)fail(409,'Настройки изменились. Обновите страницу');
  let value;try{value=validateSelection(input.settings);}catch(er){fail(400,er.message);}
  const next={...old.policy,selection:value,max_price:value.max_price,min_rating:value.min_rating,min_feedbacks:value.min_feedbacks,blocked_words:value.blocked_words,blacklist:value.blacklist};
  if(input.active===false)delete next.selection;
  await ensureControl(e);
  const result=await e.DB.batch([
    q(e,'UPDATE scheduler_policy SET data=? WHERE id=1 AND data=? AND NOT EXISTS(SELECT 1 FROM scheduler_actions WHERE request_id=?)',JSON.stringify(next),old.raw,key),
    auditStatement(e,'selection',{settings:selectionSettings(old.policy),active:Boolean(old.policy.selection)},{settings:value,active:input.active!==false,confirmed:true,request_id:input.request_id}),
    q(e,'INSERT OR IGNORE INTO scheduler_actions(request_id,ts) SELECT ?,? WHERE changes()>0',key,Math.floor(Date.now()/1000))
  ]);
  if(!result[0].meta.changes){if(await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first())return {ok:true,duplicate:true};fail(409,'Настройки изменились во время сохранения');}
  await pruneChanges(e);return {ok:true};
}
export async function selectionRoute(request,e,{json,fail,payload}){
  const u=new URL(request.url),current=await policyState(e);
  if(u.pathname==='/api/admin/selection/quality'&&request.method==='PUT')return json(await saveQuality(e,await payload(request),fail));
  if(u.pathname==='/api/admin/selection/quality'&&request.method==='GET'){
    const rows=(await q(e,"SELECT pid,data,topic,title_key,queued_at,checked_at FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at,pid LIMIT 100").all()).results;
    const quarantined=current.policy.audience_quality?(await q(e,"SELECT pid,data FROM scheduler_inventory WHERE state='owner_excluded' ORDER BY queued_at,pid LIMIT 20").all()).results:[];
    const context=await audienceContext(e,rows.map(r=>r.pid));
    const describe=row=>{const p=JSON.parse(row.data),v=candidateQuality(p,current.policy,context,context.visual.get(row.pid)||[]),reason=selectionReason(p,current.policy);return {pid:row.pid,title:p.title,price:p.product,rating:p.rating,reviews:p.feedbacks,...v,...(reason?{allowed:false,reason,score:0}:{})};};
    return json({settings:qualitySettings(current.policy),revision:current.revision,categories:QUALITY_CATEGORIES,feedback:feedbackSummary(context),candidates:qualityRank(rows.filter(r=>!selectionReason(JSON.parse(r.data),current.policy)),[],current.policy,context).slice(0,12).map(describe),rejected:[...quarantined,...rows].map(describe).filter(p=>!p.allowed).slice(0,20),note:'Снимок до 100 кандидатов, не обещание следующего поста. Окончательно проверяются цена, фото, дубли и ограничения расписания. Открытие не сохраняет настройки. Старые слова-исключения сохраняются отдельно: при разрешении категории проверьте и этот список.'});
  }
  if(u.pathname==='/api/admin/selection'&&request.method==='PUT')return json(await saveSelection(e,await payload(request),fail));
  if(request.method!=='GET')fail(405,'Метод не поддерживается');
  if(u.pathname==='/api/admin/selection')return json({settings:selectionSettings(current.policy),revision:current.revision,active:Boolean(current.policy.selection),styles_available:false,discount_available:false,note:'Категории и бренды — точные названия WB. Аудитория — только явные слова в названии, иначе неизвестна. Доли и повторы мягкие: при нехватке используется другой прошедший фильтры товар.'});
  // Fixed-size local candidate window, no unbounded catalogue scans or WB calls.
  const rows=(await q(e,"SELECT pid,data FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at,pid LIMIT 120").all()).results,products=rows.map(r=>JSON.parse(r.data));
  if(u.pathname==='/api/admin/selection/similar'){
    const pid=Number(u.searchParams.get('pid'));if(!Number.isSafeInteger(pid)||pid<=0)fail(400,'Укажите артикул WB');const row=await q(e,'SELECT data FROM scheduler_inventory WHERE pid=?',pid).first()||await q(e,'SELECT data FROM products WHERE id=?',pid).first();if(!row)fail(404,'Товар пока неизвестен каталогу. Сначала найдите его обычным поиском');const source=JSON.parse(row.data),items=products.filter(p=>p.id!==pid).map(p=>({...p,...similarity(source,p)})).filter(p=>p.score>=.25).sort((a,b)=>b.score-a.score).slice(0,8);return json({source,items,scope:'До 120 ближайших товаров очереди. Сходство текста и категории, не фотографий; цена не является признаком качества.'});
  }
  if(u.pathname==='/api/admin/selection/suggestions'){
    const items=querySuggestions(queryRules(current.policy),products);
    return json({items,note:'Подсказки не запускают WB и не меняют поиск. Выберите вариант, затем сохраните в разделе запросов.'});
  }fail(404,'Раздел не найден');
}
