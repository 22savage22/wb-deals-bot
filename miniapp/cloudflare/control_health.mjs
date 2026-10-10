// Read existing bounded aggregates. Opening a dashboard never creates settings.
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a);
async function optional(fn){try{return await fn();}catch(er){if(/no such table/i.test(er.message))return null;throw er;}}
export async function homeSummary(e,dayStart){
  const searches=await optional(()=>q(e,'SELECT COUNT(*) runs,SUM(added) added,MIN(ts) first FROM admin_search_runs WHERE ts>=?',dayStart).first());
  const votes=await optional(()=>q(e,'SELECT likes,dislikes,bought FROM admin_reaction_summary WHERE id=1').first());
  const learning=await optional(()=>q(e,'SELECT config,model FROM learning_state WHERE id=1').first());
  return {new_today:searches?.runs?searches.added:null,new_today_note:'По сохранённым проверкам сегодня; ранняя история может отсутствовать.',audience:votes,learning:learning?{mode:JSON.parse(learning.config).mode,trained_events:JSON.parse(learning.model).trained_events||0}:null};
}
export function explainFailure(code){return /429/.test(code)?'WB попросил сделать паузу между запросами.':/403/.test(code)?'WB временно ограничил доступ.':/D1.*LIMIT|D1_QUERY|free tier/i.test(code)?'Достигнут защитный лимит базы.':/TELEGRAM_UNKNOWN/.test(code)?'Ответ Telegram потерян. Повторная отправка заблокирована во избежание дубля.':/TELEGRAM/.test(code)?'Telegram не подтвердил отправку.':/TIMEOUT|timeout/i.test(code)?'Сервис не ответил вовремя.':'Операция не завершилась. Проверка повторится по действующим ограничениям.';}
export async function healthHistory(e){
  const rows=await optional(()=>q(e,'SELECT id,ts,query,error FROM admin_search_runs ORDER BY id DESC LIMIT 100').all());if(!rows)return {events:[],available:false,note:'История начнётся после подключения журнала. Старые сбои не восстанавливаем из предположений.'};
  const ordered=[...rows.results].reverse(),events=[];let pending=null;
  for(const r of ordered){if(r.error){pending=r;events.push({id:r.id,ts:r.ts,type:'error',service:'Поиск WB',query:r.query,message:explainFailure(r.error),code:r.error});}else if(pending){events.push({id:r.id,ts:r.ts,type:'recovered',service:'Поиск WB',query:r.query,message:'Успешный поиск после ограничения или ошибки.',after_error_at:pending.ts});pending=null;}}
  const native=await optional(()=>q(e,'SELECT id,ts,service,state,code FROM admin_health_events ORDER BY id DESC LIMIT 20').all());
  for(const r of native?.results||[])events.push({id:'native:'+r.id,ts:r.ts,type:r.state,service:r.service==='cron'?'Планировщик':'Публикации',code:r.code,message:r.state==='recovered'?'Ранее записанная ошибка снята работающим процессом.':r.code==='POST_OVERDUE'?'Планировщик обнаружил задержку публикации.':explainFailure(r.code)});
  return {events:events.sort((a,b)=>b.ts-a.ts||String(b.id).localeCompare(String(a.id))).slice(0,20),available:true,note:'Последние изменения состояния публикаций/планировщика (храним 200) и ошибки среди 100 поисков. История начинается после миграции; сбой записи D1 может не попасть в журнал. Секреты и тексты ответов сервисов не сохраняются.'};
}
export async function visionHealth(e){const state=await optional(()=>q(e,'SELECT enabled,last_success,last_error FROM visual_state WHERE id=1').first()),usage=state?await optional(()=>q(e,'SELECT calls FROM visual_usage WHERE day=?',new Date().toISOString().slice(0,10)).first()):null;return {bound:!!e.AI,enabled:Boolean(state?.enabled),initialized:Boolean(state),last_success:state?.last_success||null,calls_today:usage?.calls??null,account_neurons:null,note:'Этот экран не запускает AI. Расход Neurons всего аккаунта здесь неизвестен. Без активного Vision — ожидание отдельного проверенного внедрения.'};}
