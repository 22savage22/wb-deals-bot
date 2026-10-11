// Owner-only UI over the existing inventory, leases and idempotent requests.
const q=(e,s,...v)=>e.DB.prepare(s).bind(...v);
export async function queueRoute(request,e,{json,fail,payload}){
  const url=new URL(request.url),now=Math.floor(Date.now()/1000);
  if(request.method==='GET'){
    const cursor=url.searchParams.get('cursor')||'',match=cursor.match(/^(\d+):(\d+)$/),view=url.searchParams.get('view')||'ready',needle=(url.searchParams.get('q')||'').normalize('NFKC').toLowerCase().trim(),category=(url.searchParams.get('category')||'').toLowerCase().trim(),query=(url.searchParams.get('query')||'').toLowerCase().trim(),readiness=url.searchParams.get('readiness')||'all';
    if(cursor&&!match||!['ready','published'].includes(view)||!['all','checked','waiting'].includes(readiness)||[needle,category,query].some(x=>x.length>100))fail(400,'Проверьте фильтры и страницу');
    const time=match?Number(match[1]):view==='published'?now+1:0,id=match?Number(match[2]):0;if(!Number.isSafeInteger(time)||!Number.isSafeInteger(id))fail(400,'Некорректная страница');
    const size=needle||category||query||readiness!=='all'?100:7;
    const rows=(await (view==='published'?q(e,`SELECT pid,data,topic,ts AS queued_at,ts AS checked_at,0 AS retry_at,message_id FROM scheduler_deliveries WHERE ts>? AND (ts,pid)<(?,?) ORDER BY ts DESC,pid DESC LIMIT ?`,now-14*86400,time,id,size):q(e,`SELECT pid,data,topic,queued_at,checked_at,retry_at FROM scheduler_inventory WHERE state='ready' AND (queued_at,pid)>(?,?) AND expires>? ORDER BY queued_at,pid LIMIT ?`,time,id,now,size)).all()).results;
    const mapped=rows.map(r=>{const p=JSON.parse(r.data),waiting=r.retry_at>now;return {pid:r.pid,title:p.title,price:p.product||p.price,image:p.image,brand:p.brand||'',rating:p.rating??null,feedbacks:p.feedbacks??null,category:p.category||r.topic,query:p.query||r.topic,checked_at:r.checked_at,retry_at:r.retry_at,posted_at:view==='published'?r.queued_at:null,readiness:view==='published'?'Опубликован':waiting?'Ожидает проверки':r.checked_at?'Цена и фото проверены; перед отправкой проверим снова':'Нужна проверка цены и фото',url:`https://www.wildberries.ru/catalog/${r.pid}/detail.aspx`,reason:view==='published'?'Подтверждённая публикация из сохранённой истории.':'Принят поиском по теме «'+r.topic+'». Порядок определяется правилами подбора; перед отправкой проверяются цена, фото и дубли.',_cursor:`${r.queued_at}:${r.pid}`};});
    const filtered=mapped.filter(p=>(!needle||(p.title+' '+p.pid+' '+p.brand).toLowerCase().includes(needle))&&(!category||p.category.toLowerCase().includes(category))&&(!query||p.query.toLowerCase().includes(query))&&(readiness==='all'||readiness==='waiting'?(readiness==='all'||p.retry_at>now||!p.checked_at):p.checked_at>0&&p.retry_at<=now)),items=filtered.slice(0,6);
    const next=filtered.length>6?items.at(-1)._cursor:rows.length===size?mapped.at(-1)?._cursor:null;
    return json({items:items.map(({_cursor,...p})=>p),next_cursor:next,view,scanned:rows.length,note:view==='published'?'Сохранённые публикации за 14 дней.':'Проверяем до 100 карточек на страницу. Если совпадений нет, перейдите дальше. Это запас кандидатов, точный порядок зависит от проверки.'});
  }
  if(request.method!=='POST')fail(405,'Метод не поддерживается');
  const {action,pid,request_id}=await payload(request);
  if(!['post','skip','delete'].includes(action)||!Number.isSafeInteger(pid)||pid<=0||typeof request_id!=='string'||!/^[-a-zA-Z0-9_]{1,64}$/.test(request_id))fail(400,'Некорректное действие');
  const key=`queue:${action}:${pid}:${request_id}`;
  if((await q(e,'SELECT request_id FROM scheduler_actions WHERE request_id=?',key).first()))return json({accepted:true,duplicate:true,pid,action},202);
  const row=await q(e,`SELECT i.state,i.expires,(SELECT post_request FROM scheduler_config WHERE id=1) AS request,
    (SELECT expires FROM scheduler_leases WHERE kind='post') AS lease,
    (SELECT MAX(ts) FROM scheduler_posts WHERE pid=i.pid) AS posted,
    (SELECT ts FROM scheduler_claims WHERE pid=i.pid AND status IN ('pending','error','success')) AS claimed
    FROM scheduler_inventory i WHERE pid=?`,pid).first();
  if(!row||row.state!=='ready'||row.expires<=now)fail(409,'Товар уже выбыл из очереди. Обновите список.');
  if(row.lease>now||row.request)fail(409,'Публикация уже выполняется или ожидает Cron. Дождитесь результата.');
  if(row.posted>now-7*86400||row.claimed>now-7*86400)fail(409,'Этот товар уже опубликован или его отправка требует проверки.');
  // Batch is atomic. Recheck the live lease and pending request at mutation time.
  const guard=`NOT EXISTS(SELECT 1 FROM scheduler_leases WHERE kind='post' AND expires>?)
    AND NOT EXISTS(SELECT 1 FROM scheduler_actions WHERE request_id=?)`;
  const update=action==='post'?q(e,`UPDATE scheduler_config SET post_request=?,status=json_patch(status,?)
    WHERE id=1 AND post_request IS NULL AND ${guard} AND EXISTS(SELECT 1 FROM scheduler_inventory WHERE pid=? AND state='ready')`,key,JSON.stringify({admin_product_request:key,admin_product_id:pid,admin_product_result:'Товар '+pid+' ожидает проверки и публикации Cron.'}),now,key,pid):
    q(e,`UPDATE scheduler_inventory SET state=? WHERE pid=? AND state='ready' AND ${guard}
      AND NOT EXISTS(SELECT 1 FROM scheduler_config WHERE post_request IS NOT NULL)`,action==='skip'?'admin_skipped':'admin_removed',pid,now,key);
  const result=await e.DB.batch([update,q(e,`INSERT OR IGNORE INTO scheduler_actions(request_id,ts) SELECT ?,? WHERE changes()>0`,key,now)]);
  if(!result[0].meta.changes)fail(409,'Состояние изменилось. Обновите очередь.');
  // Tombstones retain dedup/history; "delete" removes only from the ready queue.
  return json({accepted:true,pid,action,request_id:key},202);
}
