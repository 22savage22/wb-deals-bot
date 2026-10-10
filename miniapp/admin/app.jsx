import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppRoot,Button,Input,Switch,Placeholder,Spinner} from '@telegram-apps/telegram-ui';
import '@telegram-apps/telegram-ui/dist/styles.css';
import './style.css';
import {createClient} from './client.mjs';
import {days,stamp,queueHealth,searchState,mainProblem,insightText,visualErrorText} from './view.mjs';
import {visualLabel} from '../cloudflare/visual_features.mjs';
import {QueryManager} from './query-manager.jsx';
import {SelectionManager} from './selection-manager.jsx';
const tg=window.Telegram?.WebApp,client=createClient(tg?.initData||'');
const pages=[['home','⌂','Главная'],['schedule','◷','Расписание'],['search','⌕','Поиск WB'],['selection','◎','Подбор'],['learn','✦','Обучение'],['queue','▦','Очередь'],['diag','⚙','Диагностика']];
function Panel({title,description,children}){return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{description&&<p>{description}</p>}</div>{children}</section>;}
function Metric({label,value,note,tone}){return <div className={'metric '+(tone||'')}><span>{label}</span><strong>{value}</strong>{note&&<small>{note}</small>}</div>;}
function Toggle({label,value,onChange}){return <label className="toggle"><span>{label}</span><Switch checked={value} onChange={e=>onChange(e.target.checked)}/></label>;}
function Field({header,...props}){return <div className="field"><label>{header}<Input aria-label={header} {...props}/></label></div>;}
function App(){
  const [controlDirty,setControlDirty]=useState(false);
  const [screen,setScreen]=useState('home'),[data,setData]=useState(null),[schedule,setSchedule]=useState(null),[learning,setLearning]=useState(null),[diagnostic,setDiagnostic]=useState(null),[queue,setQueue]=useState(null);
  const [busy,setBusy]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState(''),[changed,setChanged]=useState(false),[preview,setPreview]=useState(null),[appearance,setAppearance]=useState(tg?.colorScheme||'light'),[learningChanged,setLearningChanged]=useState(false);
  const lock=useRef(false),dirty=useRef(false),baseRevision=useRef(null),mounted=useRef(true),pageRef=useRef('home'),dataRef=useRef(null),requestEpoch=useRef(0);
  let zone=(screen==='schedule'||screen==='search'?schedule?.timezone:data?.schedule.timezone)||'Europe/Moscow';try{new Intl.DateTimeFormat('ru-RU',{timeZone:zone});}catch{zone=data?.schedule.timezone||'Europe/Moscow';}
  const live=data?.schedule||{},status=data?.status||{},search=data?searchState(live,status):{},health=queueHealth(status.queue_size||0);
  async function refresh(){
    const result=await client.api('/api/admin/overview');if(!mounted.current)return;
    setData(result);dataRef.current=result;
    if(!dirty.current){baseRevision.current=result.revision;setSchedule(result.schedule);}
    return result;
  }
  async function loadPage(page){if(page==='learn')setLearning(await client.api('/api/admin/learning'));if(page==='diag')setDiagnostic(await client.api('/api/admin/diagnostics'));if(page==='queue')setQueue(await client.api('/api/admin/queue'));}
  useEffect(()=>{
    tg?.ready();tg?.expand();mounted.current=true;
    const theme=()=>setAppearance(tg?.colorScheme||'light');tg?.onEvent?.('themeChanged',theme);
    if(!tg?.initData){setError('Откройте /admin в WBmarket. Управление доступно только владельцу.');return;}
    client.api('/api/admin/session','POST',{}).then(refresh).catch(e=>setError(e.message));
    let lastRefresh=Date.now();
    const timer=setInterval(()=>{
      const operations=dataRef.current?.operations,checking=dataRef.current?.status.admin_check_state==='running';
      const gap=operations?.post||operations?.search||checking?10000:60000;
      if(document.visibilityState==='visible'&&!lock.current&&Date.now()-lastRefresh>=gap){lastRefresh=Date.now();refresh().catch(()=>setError('Нет связи. Настройки не изменены. Повторите после восстановления сети.'));}
    },5000);
    const visible=()=>{if(document.visibilityState==='visible'&&!lock.current)refresh().catch(()=>{});};document.addEventListener('visibilitychange',visible);
    return()=>{mounted.current=false;clearInterval(timer);tg?.offEvent?.('themeChanged',theme);document.removeEventListener('visibilitychange',visible);};
  },[]);
  useEffect(()=>{
    if(!changed||!schedule)return;
    const version=++requestEpoch.current;
    const timer=setTimeout(()=>client.api('/api/admin/schedule/preview','POST',{schedule}).then(r=>{if(version===requestEpoch.current)setPreview({time:r.next_post});}).catch(e=>{if(version===requestEpoch.current)setPreview({error:e.message});}),650);
    return()=>{clearTimeout(timer);requestEpoch.current++;};
  },[schedule,changed]);
  async function run(name,operation,success){
    if(lock.current)return;lock.current=true;setBusy(name);setError('');setMessage('');
    try{const result=await operation();setMessage(name==='load'?'':success||'✅ Заявка принята. Cron выполнит её отдельно с учётом расписания и ограничений.');await refresh();return result;}
    catch(e){setError(e.status===409?e.message+' Ваши несохранённые изменения сохранены на экране.':e.name==='TimeoutError'?'Ответ задержался. Повтор безопасен — заявка не задублируется.':e instanceof TypeError?'Нет связи. Повторите после восстановления сети.':e.message);}
    finally{lock.current=false;setBusy('');}
  }
  function change(key,value){if(!schedule)return;dirty.current=true;setChanged(true);setSchedule(s=>({...s,[key]:value}));setPreview(null);}
  async function save(){
    if(!dirty.current||!Number.isInteger(baseRevision.current))return;
    await client.api('/api/admin/schedule','PUT',{schedule,revision:baseRevision.current});dirty.current=false;setChanged(false);setPreview(null);
  }
  function discard(){dirty.current=false;setChanged(false);setPreview(null);baseRevision.current=data.revision;setSchedule(data.schedule);}
  async function open(page){
    if(lock.current)return;
    if(controlDirty&&page!==screen)return setError('Сначала сохраните или отмените изменения в текущем разделе.');
    if(learningChanged&&page!==screen)return setError('Сначала сохраните изменения экспериментов.');
    setScreen(page);pageRef.current=page;setError('');setMessage('');
    if(['learn','diag','queue'].includes(page))await run('load',()=>loadPage(page),'');
    setMessage('');
  }
  const action=value=>run(value,()=>client.action(value));
  const confirm=(text,fn)=>tg?.showConfirm?tg.showConfirm(text,ok=>{if(ok)fn();}):window.confirm(text)&&fn();
  const button=(label,fn,{mode='filled',disabled=false}={})=><Button size="l" mode={mode} stretched disabled={!!busy||disabled} onClick={fn}>{label}</Button>;
  const presets=(key,values)=><div className="presets">{values.map(n=><Button key={n} mode={schedule[key]===n?'filled':'gray'} aria-pressed={schedule[key]===n} disabled={!!busy} onClick={()=>change(key,n)}>{n===60?'1 час':n+' мин'}</Button>)}</div>;
  const saveBar=<div className="savebar">{button('Сохранить',()=>run('save',save,'✅ Расписание сохранено. Следующее время пересчитано.'),{disabled:!changed})}{changed&&button('Отменить изменения',discard,{mode:'plain'})}<p>{changed?'Изменения пока только на экране. Нажмите «Сохранить».':'Загружены действующие настройки из D1. Ничего не перезаписываем.'}</p></div>;
  const latest=status.last_search_add_receipt||status.search_receipt||{};
  const nextPreview=changed?preview?.time:status.next_post;
  const votes=learning?.current_votes;
  const positive=learning?.insights?.filter(x=>x.rate>=.65)||[],negative=learning?.insights?.filter(x=>x.rate<=.35)||[];
  const insightCards=items=>items.map((i,index)=>{const text=insightText(i);return <article className="observation" key={index}><strong>{text.title}</strong><p>{text.description}</p><small>{text.detail}</small></article>;});
  if(!data)return <AppRoot appearance={appearance}><main><Placeholder header="Управление каналом" description={error||'Загружаем ваши настройки…'}>{!error&&<Spinner size="l"/>}</Placeholder>{error&&button('Повторить',()=>run('load',refresh))}</main></AppRoot>;
  return <AppRoot appearance={appearance}><main aria-busy={!!busy}><fieldset className="ui-controls" disabled={!!busy}><header className="top"><div><span className="eyebrow">WBmarket · только для вас</span><h1>Управление каналом</h1></div><span className="avatar">W</span></header>
    <nav aria-label="Разделы управления">{pages.map(([p,icon,label])=><button key={p} aria-current={screen===p?'page':undefined} onClick={()=>open(p)} disabled={!!busy}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
    {error&&<div role="alert" className="notice red">{error}</div>}{message&&<div role="status" className="notice green">{message}</div>}{busy&&<div role="status" className="progress"><Spinner size="s"/>{busy==='load'?'Загружаем…':busy==='save'?'Сохраняем…':'Подтверждаем запуск…'}</div>}
    {screen==='home'&&<>
      <section className={'hero '+(live.paused||!live.enabled?'muted':mainProblem(status)?'red':'green')}>
        <span className="eyebrow">Автопостинг</span><h2>{live.paused||!live.enabled?'⏸ Публикации на паузе':mainProblem(status)?'🔴 Требуется внимание':'🟢 Канал работает'}</h2>
        <p>{mainProblem(status)||'Посты выходят без вашего компьютера.'}</p><strong className="interval">{live.mode==='interval'?live.post_interval_minutes+' мин':'По заданным часам'}<small>текущее расписание</small></strong>
      </section>
      <div className="metrics"><Metric label="Последний пост" value={stamp(status.last_post_success,zone)}/><Metric label="Следующий пост" value={status.next_post?stamp(status.next_post,zone):'На паузе'}/><Metric label="Очередь товаров" value={(status.queue_size??0)+' / '+live.min_queue} note={health.label} tone={health.tone}/><Metric label="Добавлено в последнем поиске" value={latest.added??status.last_scan_added??'—'} note={stamp(status.last_search_success||status.last_scan_success,zone)}/></div>
      <div className="queue-meter"><div style={{width:Math.min(100,(status.queue_size||0)/live.min_queue*100)+'%'}} className={health.tone}/></div>
      <div className="actions">{button(live.paused?'▶ Продолжить':'⏸ Пауза',()=>action(live.paused?'resume':'pause'),{mode:'gray',disabled:!live.enabled})}{button('📤 Опубликовать сейчас',()=>confirm('Опубликовать один товар? Тихие часы и лимиты сохраняются.',()=>action('post_now')),{disabled:!!data.operations.post})}{button('🔍 Найти товары сейчас',()=>action('search_now'),{disabled:!!data.operations.search||status.search_retry_at>Date.now()/1000})}{button('▦ Посмотреть очередь',()=>open('queue'),{mode:'gray'})}</div>
      {(data.operations.post||data.operations.search)&&<div className="notice yellow">Заявка ожидает Cron. Повторное нажатие не создаёт вторую задачу.</div>}
      {status.admin_product_result&&<div className="notice muted">{status.admin_product_result}</div>}
      {search.tone!=='green'&&<div className={'notice '+search.tone}><strong>{search.title}</strong><p>{search.detail||'Можно включить на экране «Поиск WB».'}</p></div>}
      <p className="subtle">Последний поиск WB: {stamp(status.last_search_success||status.last_scan_success,zone)}</p>
    </>}
    {screen==='selection'&&<SelectionManager client={client} onDirty={setControlDirty}/>}
    {screen==='schedule'&&<>
      <Panel title="Расписание публикаций" description="Настройте удобный ритм. Изменения применяются только после сохранения.">
        <Toggle label="Автопостинг включён" value={schedule.enabled} onChange={v=>change('enabled',v)}/>
        <div className="segments">{button('Через интервал',()=>change('mode','interval'),{mode:schedule.mode==='interval'?'filled':'gray'})}{button('По времени',()=>change('mode','times'),{mode:schedule.mode==='times'?'filled':'gray'})}</div>
        {schedule.mode==='interval'?<>{presets('post_interval_minutes',[5,10,20,30])}<Field type="number" min="5" max="10080" header="Свой интервал, минут" value={schedule.post_interval_minutes} onChange={e=>change('post_interval_minutes',Number(e.target.value))}/></>:<div className="times">{schedule.post_times.map((time,i)=><label key={i}><input aria-label={'Время публикации '+(i+1)} type="time" value={time} onChange={e=>change('post_times',schedule.post_times.map((t,j)=>j===i?e.target.value:t))}/><button aria-label="Удалить время" onClick={()=>change('post_times',schedule.post_times.filter((_,j)=>j!==i))}>×</button></label>)}{button('+ Добавить время',()=>change('post_times',[...schedule.post_times,'08:00']),{mode:'gray',disabled:schedule.post_times.length>=24})}</div>}
        <h3>Дни недели</h3><div className="presets days">{days.map((label,i)=><Button key={i} aria-pressed={schedule.weekdays.includes(i)} mode={schedule.weekdays.includes(i)?'filled':'gray'} disabled={!!busy} onClick={()=>change('weekdays',schedule.weekdays.includes(i)?schedule.weekdays.filter(d=>d!==i):[...schedule.weekdays,i])}>{label}</Button>)}</div>
        <Toggle label="Не публиковать в тихие часы" value={schedule.quiet_enabled} onChange={v=>change('quiet_enabled',v)}/>
        {schedule.quiet_enabled&&<div className="times"><label>С <input type="time" value={schedule.quiet_start} onChange={e=>change('quiet_start',e.target.value)}/></label><label>До <input type="time" value={schedule.quiet_end} onChange={e=>change('quiet_end',e.target.value)}/></label></div>}
        <Field header="Часовой пояс" value={schedule.timezone} onChange={e=>change('timezone',e.target.value)}/>
        <div className="preview"><span>{changed?'Предпросмотр, не сохранено':'Ближайший пост'}</span><strong>{preview?.error||nextPreview?preview?.error||stamp(nextPreview,zone):changed?'Пересчитываем…':'На паузе'}</strong></div>
      </Panel>
      <details className="panel"><summary>Дополнительно</summary>{[['max_posts_hour','Постов в час, максимум'],['max_posts_day','Постов в сутки, максимум'],['min_post_gap_minutes','Безопасный промежуток, минут']].map(([key,label])=><Field key={key} type="number" header={label} value={schedule[key]} onChange={e=>change(key,Number(e.target.value))}/>)}<Toggle label="Небольшой разброс интервала" value={schedule.natural_interval_enabled} onChange={v=>change('natural_interval_enabled',v)}/>{schedule.natural_interval_enabled&&<Field type="number" header="Разброс, минут" value={schedule.jitter_minutes} onChange={e=>change('jitter_minutes',Number(e.target.value))}/>}</details>{saveBar}
    </>}
    {screen==='search'&&<>
      <QueryManager client={client} zone={zone} onDirty={setControlDirty}/>
      <section className={'hero compact '+search.tone}><h2>🔍 {search.title}</h2><p>{search.detail}</p></section>
      <div className="metrics"><Metric label="Последний поиск" value={stamp(status.last_search_success||status.last_scan_success,zone)}/><Metric label="Следующий поиск" value={schedule.search_enabled?stamp(status.next_search,zone):'На паузе'}/><Metric label="Найдено" value={latest.found??status.last_scan_found??'—'}/><Metric label="Новых в очереди" value={latest.added??status.last_scan_added??'—'}/></div>
      <Panel title="Пополнение запаса" description={'Сейчас '+status.queue_size+' товаров. Во время ожидания WB продолжаем публиковать из очереди.'}>
        <Toggle label="Искать новые товары" value={schedule.search_enabled} onChange={v=>change('search_enabled',v)}/>{presets('search_interval_minutes',[10,20,30,60])}
        <Field header="Свой интервал поиска, минут" type="number" min="5" max="10080" value={schedule.search_interval_minutes} onChange={e=>change('search_interval_minutes',Number(e.target.value))}/>
        <Field header="Целевой запас товаров" type="number" min="1" max="300" value={schedule.min_queue} onChange={e=>change('min_queue',Number(e.target.value))}/>
        <p className="subtle">Если выдача без подходящих товаров — вращаем тему не чаще раза в 5 минут. Ограничение WB всегда имеет приоритет.</p>
      </Panel>{saveBar}{button('🔍 Найти товары сейчас',()=>action('search_now'),{disabled:!!data.operations.search||status.search_retry_at>Date.now()/1000})}
    </>}
    {screen==='learn'&&(learning?<>
      <section className="hero purple compact"><span className="eyebrow">River · наблюдение без влияния</span><h2>🧠 {learning.trained_events?'Обучение работает':'Собираем реакции'}</h2><p>Режим: {learning.config.mode}. Реальные публикации выбирает Legacy. Новую модель не включаем.</p></section>
      <div className="metrics"><Metric label="Реакций в канале сейчас" value={votes?votes.likes+votes.dislikes+votes.bought:'Уточняем'} note="Текущие счётчики без накрутки"/><Metric label="Сигналов сегодня · МСК" value={learning.today_reactions} note="Включая смену голоса"/><Metric label="Последняя реакция получена" value={stamp(learning.last_feedback,zone)}/><Metric label="Последнее обновление River" value={stamp(learning.model_updated_at,zone)}/><Metric label="Следующее обновление · план" value={stamp(learning.next_training,zone)} note="GitHub может задержать запуск"/></div>
      {learning.training_delayed&&<div className="notice yellow">Обучение задержалось. Автопостинг продолжает работать с Legacy.</div>}
      <Panel title="Что нравится аудитории визуально" description="Только подтверждённые фото-признаки и реальные реакции. Не выводим предпочтения из названия товара.">
        {learning.visual?.insights?.filter(i=>i.direction!=='insufficient').length?learning.visual.insights.filter(i=>i.direction!=='insufficient').map(i=><article className="observation" key={i.key}><strong>{i.direction==='positive'?'↑':'↓'} {i.label}</strong><p>Наблюдений: {i.observations} · товаров: {i.products} · 👍 {i.likes} · 👎 {i.dislikes} · 🛒 {i.bought}</p><small>95% интервал доли лайков: {Math.round(i.interval[0]*100)}–{Math.round(i.interval[1]*100)}%. Это наблюдение, не рост продаж.</small></article>):<p>Недостаточно данных: нужны минимум20 реальных наблюдений и5 разных товаров для признака.</p>}
        <p className="subtle">Анализ фото: {learning.visual?.enabled?'включён, отдельная очередь':'ожидает проверку/включение'} · попыток сегодня {learning.visual?.calls_today||0}/{learning.visual?.daily_call_limit||40}. Пропущенный анализ не мешает публикациям.</p>
        {learning.visual?.last_error&&<div className="notice yellow">{visualErrorText(learning.visual.last_error)}</div>}
        <details><summary>Посмотреть реальные visual profiles</summary>{learning.visual?.examples?.length?learning.visual.examples.map(p=><article className="observation" key={p.pid}>{p.images?.[0]?.url&&<img src={p.images[0].url} alt={p.title} loading="lazy" style={{width:120,height:160,objectFit:'contain'}}/>}<strong>{p.title} · nmId{p.pid}</strong>{Object.entries(p.fields).map(([k,f])=><p key={k}>{visualLabel('visual.'+k+'='+f.value)} · уверенность модели {Math.round(f.confidence*100)}%<small>{f.evidence}</small></p>)}<small>Не определено: {p.unknown.join(', ')}. Состав материала по фото не утверждаем.</small></article>):<p>Профили ещё не получены.</p>}</details>
      </Panel>
      <div className="reactions"><span>👍 {votes?.likes??'—'}</span><span>👎 {votes?.dislikes??'—'}</span><span>🛒 Купил {votes?.bought??'—'}</span></div>
      {!learning.backfill_complete&&<div className="notice yellow">Подгружаем старые сигналы небольшими порциями. Итоги пока неполные.</div>}
      <Panel title="Что бот понял" description="Показываем наблюдения только от 10 реальных сигналов, без выдуманного роста продаж.">{positive.length?insightCards(positive):<p>Пока недостаточно данных о предпочтениях.</p>}<details><summary>Что получает меньше поддержки</summary>{negative.length?insightCards(negative):<p>Уверенного отрицательного сигнала пока нет.</p>}</details><p className="subtle">{learning.insight_note}</p></Panel>
      <Panel title="Legacy и River" description={learning.comparison.explanation}>
        <div className="metrics"><Metric label="Наблюдений для сравнения" value={learning.comparison.samples}/><Metric label="С подробной оценкой" value={learning.comparison.paired_observations}/></div>
        <div className="comparison"><article><h3>Legacy</h3><p>Действующий алгоритм</p><strong>{learning.comparison.legacy_mean==null?'—':Math.round(learning.comparison.legacy_mean*100)+'%'}</strong><small>Средний прогноз позитивной реакции</small></article><article><h3>River</h3><p>Только SHADOW</p><strong>{learning.comparison.river_mean==null?'—':Math.round(learning.comparison.river_mean*100)+'%'}</strong><small>Средний прогноз на тех же товарах</small></article></div>
        <p>Реальный feedback оценённой выборки: 👍 {learning.comparison.positive??'—'} · 👎 {learning.comparison.negative??'—'}</p>
        <div className="reactions"><span>River точнее: {learning.comparison.wins??'—'}</span><span>Хуже: {learning.comparison.losses??'—'}</span><span>Ничья: {learning.comparison.ties??'—'}</span></div>
        {learning.comparison.last_observation&&<p className="subtle">Последнее наблюдение: nmId {learning.comparison.last_observation.pid}, результат {learning.comparison.last_observation.actual==='like'?'👍':'👎'}. Прогноз Legacy {Math.round(learning.comparison.last_observation.legacy*100)}%, River {Math.round(learning.comparison.last_observation.river*100)}%.</p>}
        {learning.comparison.sufficient?<p>Ошибка прогноза: Legacy {learning.comparison.legacy_brier.toFixed(3)} · River {learning.comparison.river_brier.toFixed(3)}. Меньше — лучше. Это не uplift продаж.</p>:<div className="notice muted">Пока мало данных. Для вывода нужны 200 наблюдений, 20 товаров и 7 дней. Старым данным без подробной оценки не приписываем победы.</div>}
        <p className="subtle">Legacy fallback активен. Переключение модели требует отдельного разрешения.</p>
      </Panel>
      <Panel title="Эксперименты" description="Часть товаров — новые темы для изучения интересов аудитории."><label className="range-label"><strong>{learning.config.exploration_percent}%</strong><input aria-label="Эксперименты" type="range" min="0" max="30" value={learning.config.exploration_percent} onChange={e=>{setLearningChanged(true);setLearning({...learning,config:{...learning.config,exploration_percent:Number(e.target.value)}});}}/><span>0% — знакомые темы · 30% — больше нового</span></label><p>В SHADOW эта настройка влияет только на исследование тем в текущем Legacy-поиске, не передаёт выбор публикаций River.</p>{button('Сохранить эксперименты',()=>run('save',async()=>{await client.api('/api/admin/learning','PUT',learning.config);setLearningChanged(false);await loadPage('learn');},'✅ Эксперименты сохранены. River остаётся в SHADOW.'),{disabled:!learningChanged})}</Panel>
    </>:<p>Загружаем реальные сигналы…</p>)}
    {screen==='queue'&&(queue?<>
      <Panel title={'В запасе '+status.queue_size+' товаров'} description={queue.note}><span className={'badge '+health.tone}>{health.label}</span></Panel>
      {queue.items.length?queue.items.map(p=><article className="product-card" key={p.pid}><div className="product-summary">{p.image?<img src={p.image} alt="" loading="lazy" onError={e=>{e.target.style.display='none';}}/>:<span className="photo-empty">▦</span>}<div><span className="eyebrow">{p.category}</span><h2>{p.title}</h2><strong className="price">{p.price?.toLocaleString('ru-RU')} ₽</strong><small>nmId {p.pid}</small></div></div><p>{p.reason}</p>{p.retry_at>Date.now()/1000&&<div className="notice yellow">Ожидает повторной проверки. Не отправим непроверенный товар.</div>}<div className="product-actions">{button('Опубликовать',()=>confirm('Опубликовать именно «'+p.title+'»? Cron повторно проверит товар.',()=>run('queue-post',()=>client.action('post',{pid:p.pid}))),{disabled:!!data.operations.post})}{button('Пропустить',()=>run('queue-skip',async()=>{await client.action('skip',{pid:p.pid});await loadPage('queue');},'✅ Товар пропущен.'),{mode:'gray'})}{button('Удалить из очереди',()=>confirm('Убрать товар из запаса? История и защита от дублей сохранятся.',()=>run('queue-delete',async()=>{await client.action('delete',{pid:p.pid});await loadPage('queue');},'✅ Удалено только из очереди.')),{mode:'plain'})}<a href={p.url} target="_blank" rel="noopener noreferrer">Открыть WB ↗</a></div></article>):<Panel title="На этой странице нет товаров"><p>Поиск пополнит запас автоматически.</p></Panel>}
      <div className="actions">{button('В начало',()=>run('load',()=>loadPage('queue'),''),{mode:'gray'})}{queue.next_cursor&&button('Следующие товары →',()=>run('load',async()=>setQueue(await client.api('/api/admin/queue?cursor='+encodeURIComponent(queue.next_cursor))),''),{mode:'gray'})}</div>
    </>:<p>Загрузка очереди…</p>)}
    {screen==='diag'&&(diagnostic?<>
      <Panel title="Диагностика" description="Технические детали отдельно от главного экрана.">
        {[['Worker',diagnostic.worker],['Cloudflare Cron',status.cron_active],['D1',diagnostic.d1],['Telegram',diagnostic.telegram],['WB source',diagnostic.wb_source]].map(([name,ok])=><div className="diag-row" key={name}><span>{name}</span><strong>{ok?'🟢 OK':'🟠 Проверить'}</strong></div>)}
        <div className="diag-row"><span>Очередь</span><strong>{status.queue_size}</strong></div><div className="diag-row"><span>Webhook: последний callback</span><strong>{stamp(diagnostic.webhook?.ts,zone)}</strong></div><div className="diag-row"><span>Последний heartbeat</span><strong>{stamp(status.last_automatic_tick||diagnostic.heartbeat,zone)}</strong></div><div className="diag-row"><span>Backoff WB до</span><strong>{status.search_retry_at>Date.now()/1000?stamp(status.search_retry_at,zone):'Нет'}</strong></div>
        <div className="notice muted">Последняя ошибка: {diagnostic.last_error||'Нет'}</div>
        <h3>D1 сегодня</h3>{diagnostic.budget.map(r=><div className="diag-row" key={r.lane}><span>{r.lane}</span><strong>{r.reads.toLocaleString('ru-RU')} чтений / {r.writes.toLocaleString('ru-RU')} записей</strong></div>)}<p className="subtle">{diagnostic.budget_note}. Автообновление главного экрана — раз в минуту только пока он открыт.</p>
      </Panel>
      {status.admin_check_state==='running'&&<div className="notice yellow">Проверка выполняется отдельно. Новых постов не создаёт.</div>}
      {status.admin_check_state==='complete'&&<div className={'notice '+(status.admin_check_result?.ok?'green':'orange')}>{status.admin_check_result?.ok?'✅ Цепочка проверена без лишних постов.':status.admin_check_result?.error||'Проверьте товар, Cron и Telegram.'}</div>}
      {button('Проверить автопостинг',()=>action('check'),{disabled:status.admin_check_state==='running'&&status.admin_check_until>Date.now()/1000})}
    </>:<p>Загрузка диагностики…</p>)}
    <footer>Только владелец · настройки на сервере · ПК не нужен</footer></fieldset>
  </main></AppRoot>;
}
createRoot(document.getElementById('root')).render(<App/>);
