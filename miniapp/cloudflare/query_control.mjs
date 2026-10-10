import {ensureControl,optionalRows,auditStatement,pruneChanges,changes} from './admin_history.mjs';
import {searchDue,SEARCH_MIN_GAP} from './search_backoff.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a),now=()=>Math.floor(Date.now()/1000);
export const queryKey=s=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('ru');
export function queryRules(policy){
  const saved=Array.isArray(policy.query_settings)?policy.query_settings:[],byText=new Map(saved.map(r=>[queryKey(r.text),r]));
  const active=(policy.queries||[]).map(text=>{const known=byText.get(queryKey(text));return {id:known?.id||'existing:'+text,text,origin:known?.origin||'existing',priority:known?.priority||1,enabled:!(policy.disabled_topics||[]).includes(text.toLowerCase()),archived:false};});
  return [...active,...saved.filter(r=>r.archived&&!active.some(x=>x.id===r.id))];
}
export function discoveryQueries(policy){const rules=queryRules(policy).filter(r=>!r.archived);return rules.flatMap(r=>Array(Math.max(1,Math.min(5,r.priority))).fill(r.text));}
export async function fingerprint(raw){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function policyState(e){const row=await q(e,'SELECT data FROM scheduler_policy WHERE id=1').first();if(!row){const er=new Error('Подбор товаров ещё не настроен. Сохранение недоступно.');er.status=503;throw er;}return {raw:row.data,policy:JSON.parse(row.data),revision:await fingerprint(row.data)};}
export function validateQueries(input,previous=[]){
  if(!Array.isArray(input)||input.length>100)throw new Error('Можно сохранить до 100 поисковых фраз');
  const seen=new Set(),ids=new Set(),old=new Map(previous.map(r=>[r.id,r]));
  return input.map(r=>{
    if(!r||typeof r.text!=='string')throw new Error('Укажите текст запроса');
    const text=r.text.normalize('NFKC').trim().replace(/\s+/gu,' '),key=queryKey(text);
    if(text.length<2||text.length>100||/[\u0000-\u001f\u007f]/.test(text)||seen.has(key))throw new Error('Фраза должна быть уникальной и содержать 2–100 символов');seen.add(key);
    if(typeof r.enabled!=='boolean'||typeof r.archived!=='boolean'||!Number.isInteger(r.priority)||r.priority<1||r.priority>5)throw new Error('Проверьте переключатели и приоритет от 1 до 5');
    const prev=old.get(r.id)||previous.find(x=>queryKey(x.text)===key),id=prev?.id||crypto.randomUUID();if(ids.has(id))throw new Error('Повторяющийся идентификатор запроса');ids.add(id);
    return {id,text,enabled:r.enabled,archived:r.archived,priority:r.priority,origin:prev?.origin||'manual'};
  });
}
export async function saveQueries(e,input,fail){
  const current=await policyState(e);if(input.revision!==current.revision)fail(409,'Список уже изменился. Обновите страницу перед сохранением');
  let rules;try{rules=validateQueries(input.queries,queryRules(current.policy));}catch(er){fail(400,er.message);}
  // Preserve channel, posting counters and unrelated filters. Removal is archival.
  const absent=queryRules(current.policy).filter(r=>!rules.some(x=>x.id===r.id)).map(r=>({...r,archived:true,enabled:false}));
  rules=[...rules,...absent];if(rules.length>100)fail(400,'Всего с архивом можно сохранить до 100 запросов');
  if(new Set(rules.map(r=>queryKey(r.text))).size!==rules.length)fail(400,'Фраза совпадает с архивной. Восстановите её из архива или выберите другое имя');
  const previous=queryRules(current.policy),oldKeys=new Set(previous.map(r=>r.text.toLowerCase()));
  const disabled=[...(current.policy.disabled_topics||[]).filter(k=>!oldKeys.has(k)),...rules.filter(r=>!r.archived&&!r.enabled).map(r=>r.text.toLowerCase())];
  const next={...current.policy,queries:rules.filter(r=>!r.archived).map(r=>r.text),disabled_topics:[...new Set(disabled)],query_settings:rules};
  await ensureControl(e);
  const result=await e.DB.batch([q(e,'UPDATE scheduler_policy SET data=? WHERE id=1 AND data=?',JSON.stringify(next),current.raw),auditStatement(e,'queries',previous,rules)]);
  if(!result[0].meta.changes)fail(409,'Настройки изменились во время сохранения');await pruneChanges(e);
  return {ok:true,revision:await fingerprint(JSON.stringify(next)),queries:rules};
}
export async function queryRoute(request,e,{json,fail,payload}){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/api/admin/config/history'&&request.method==='GET'){
    const cursor=Number(url.searchParams.get('cursor')||0);if(!Number.isSafeInteger(cursor)||cursor<0)fail(400,'Некорректная страница');
    const rows=await changes(e,cursor);return json({items:rows.map(r=>({...r,before:JSON.parse(r.before_data),after:JSON.parse(r.after_data),before_data:undefined,after_data:undefined})),next_cursor:rows.length===20?rows.at(-1).id:null});
  }
  if(path==='/api/admin/config/restore'&&request.method==='POST'){
    const data=await payload(request);if(!Number.isSafeInteger(data.id)||data.id<=0)fail(400,'Некорректная запись');
    const rows=await optionalRows(e,'SELECT scope,before_data FROM admin_changes WHERE id=?',data.id),row=rows?.[0];if(!row)fail(404,'Версия уже удалена из ограниченной истории');
    if(row.scope==='selection'){const {saveSelection}=await import('./selection_control.mjs');return json(await saveSelection(e,{revision:data.revision,...JSON.parse(row.before_data)},fail));}
    if(row.scope==='schedule'){const {schedulerRoute}=await import('./scheduler_api.mjs');return schedulerRoute(new Request('https://internal/api/admin/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:data.revision,schedule:JSON.parse(row.before_data)})}),e,{json,fail,payload,admin:true});}
    if(row.scope==='learning'){const {learningRoute}=await import('./learning.mjs');return learningRoute(new Request('https://internal/api/admin/learning',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:data.revision,...JSON.parse(row.before_data)})}),e,{json,fail,payload});}
    if(row.scope!=='queries')fail(400,'Эта версия восстанавливается в своём разделе');
    return json(await saveQueries(e,{revision:data.revision,queries:JSON.parse(row.before_data)},fail));
  }
  if(!path.startsWith('/api/admin/search'))return null;
  if(path==='/api/admin/search/queries'&&request.method==='PUT')return json(await saveQueries(e,await payload(request),fail));
  if(path==='/api/admin/search/history'&&request.method==='GET'){
    const cursor=Number(url.searchParams.get('cursor')||0),id=url.searchParams.get('query_id')||'';
    if(!Number.isSafeInteger(cursor)||cursor<0||id.length>150)fail(400,'Некорректная страница');
    const rows=await optionalRows(e,`SELECT id,ts,query,query_id,origin,error,data FROM admin_search_runs WHERE (?='' OR query_id=?) AND (?=0 OR id<?) ORDER BY id DESC LIMIT 20`,id,id,cursor,cursor);
    return json({items:(rows||[]).map(r=>({...r,receipt:JSON.parse(r.data),data:undefined})),available:rows!==null,next_cursor:rows?.length===20?rows.at(-1).id:null});
  }
  const current=await policyState(e),row=await q(e,'SELECT data,status,search_request FROM scheduler_config WHERE id=1').first(),s=JSON.parse(row.data),status=JSON.parse(row.status),rules=queryRules(current.policy);
  if(path==='/api/admin/search'&&request.method==='GET'){
    const stats=await optionalRows(e,`SELECT query_id,COUNT(*) runs,SUM(success) successful,MAX(ts) last_used,SUM(found) found,SUM(new_count) new_count,SUM(json_extract(data,'$.new_candidates')) candidates,SUM(passed) passed,SUM(added) added,
      (SELECT error FROM admin_search_runs last WHERE last.query_id=r.query_id ORDER BY id DESC LIMIT 1) last_error FROM admin_search_runs r GROUP BY query_id LIMIT 100`);
    const published=(await q(e,'SELECT topic,COUNT(*) n FROM scheduler_deliveries INDEXED BY scheduler_deliveries_time WHERE ts>? GROUP BY topic LIMIT 100',now()-14*86400).all()).results;
    return json({revision:current.revision,queries:rules.map(r=>({...r,stats:stats?.find(x=>x.query_id===r.id)||null,published_14d:published.find(p=>p.topic===r.text.toLowerCase())?.n??0})),history_available:stats!==null,stats_scope:'Поиск: последние 500 проверок с подключения истории. Публикации: сохранённая история за 14 дней по текущему тексту фразы. Ранее: нет данных.',last_receipt:status.search_receipt||null,last_error:status.last_scan_error_code||null,retry_at:Math.max(Number(status.search_retry_at||0),Number(status.last_scan_attempt||0)+SEARCH_MIN_GAP),pending:row.search_request?{id:row.search_request,query:status.admin_search_query||null}:null,minimum_gap_seconds:SEARCH_MIN_GAP,source:'scheduler_policy в D1',export_version:1});
  }
  if(path==='/api/admin/search/test'&&request.method==='POST'){
    const data=await payload(request),rule=rules.find(r=>r.id===data.query_id&&!r.archived),id=data.request_id;
    if(!rule||typeof id!=='string'||!/^[-\w]{1,64}$/.test(id))fail(400,'Выберите сохранённый запрос');
    const key='query-test:'+id;if(await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first())return json({accepted:true,duplicate:true},202);
    if(!searchDue(s,status,now(),true))fail(429,'WB отдыхает после поиска или ограничения. Время следующей проверки показано на экране');
    const patch={admin_search_request:key,admin_search_query:rule.text,admin_search_query_id:rule.id,admin_search_test:true};
    const results=await e.DB.batch([q(e,"UPDATE scheduler_config SET search_request=?,status=json_patch(status,?) WHERE id=1 AND search_request IS NULL AND status=? AND NOT EXISTS(SELECT 1 FROM scheduler_leases WHERE kind='search' AND expires>?)",key,JSON.stringify(patch),row.status,now()),q(e,'INSERT OR IGNORE INTO scheduler_actions(request_id,ts) SELECT ?,? WHERE changes()>0',key,now())]);
    if(!results[0].meta.changes)fail(409,'Поиск уже выполняется или его состояние изменилось');
    return json({accepted:true,query:rule.text,test_only:true,note:'Проверка через общую очередь поиска; найденные товары не добавляются в публикации.'},202);
  }
  fail(405,'Метод не поддерживается');
}
