import {selectionSettings,validateSelection,similarity,querySuggestions} from './selection_policy.mjs';
import {policyState,queryRules} from './query_control.mjs';
import {ensureControl,auditStatement,pruneChanges} from './admin_history.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a);
export async function saveSelection(e,input,fail){const old=await policyState(e);if(input.revision!==old.revision)fail(409,'Настройки изменились. Обновите страницу');let value;try{value=validateSelection(input.settings);}catch(er){fail(400,er.message);}const next={...old.policy,selection:value,max_price:value.max_price,min_rating:value.min_rating,min_feedbacks:value.min_feedbacks,blocked_words:value.blocked_words,blacklist:value.blacklist};if(input.active===false)delete next.selection;await ensureControl(e);const result=await e.DB.batch([q(e,'UPDATE scheduler_policy SET data=? WHERE id=1 AND data=?',JSON.stringify(next),old.raw),auditStatement(e,'selection',{settings:selectionSettings(old.policy),active:Boolean(old.policy.selection)},{settings:value,active:input.active!==false})]);if(!result[0].meta.changes)fail(409,'Настройки изменились во время сохранения');await pruneChanges(e);return {ok:true};}
export async function selectionRoute(request,e,{json,fail,payload}){
  const u=new URL(request.url),current=await policyState(e);
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
