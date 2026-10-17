import React,{useEffect,useRef,useState} from 'react';
export function AudienceQuality({client,onDirty}){
 const [data,setData]=useState(null),[draft,setDraft]=useState(null),[dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[versions,setVersions]=useState(null);const lock=useRef(false);
 async function load(){const r=await client.api('/api/admin/selection/quality');setData(r);setDraft(r.settings);setDirty(false);}
 useEffect(()=>{load().catch(e=>setError(e.message));},[]);
 useEffect(()=>{onDirty?.(dirty);},[dirty]);
 function edit(k,v){setDraft(d=>({...d,[k]:v}));setDirty(true);}
 async function save(){if(lock.current||!dirty)return;const confirmed=window.confirm('Применить правила качества? Исключения начнут действовать и для старой очереди. Интервал, поиск и River не изменятся.');if(!confirmed)return;lock.current=true;setBusy(true);setError('');try{await client.api('/api/admin/selection/quality','PUT',{settings:draft,revision:data.revision,confirmed:true,request_id:crypto.randomUUID()});await load();}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}}
 if(!data)return <div className="panel">{error||'Загрузка правил качества…'}</div>;
 const f=data.feedback;
 return <div className="panel"><h2>Качество и реакции аудитории</h2>{error&&<p role="alert">{error}</p>}<p>{data.note}</p><fieldset disabled={busy}>
 <label className="toggle"><span>Применять эти правила</span><input type="checkbox" checked={draft.enabled} onChange={e=>edit('enabled',e.target.checked)}/></label>
 <h3>Исключения владельца</h3><p>Выключите запрет, чтобы разрешить категорию обратно. Это отдельные группы: разрешение учебников не разрешает остальные книги. Другие категории не запрещаются.</p>
 {Object.entries(data.categories).map(([k,v])=><label className="toggle" key={k}><span>Не публиковать: {v}</span><input type="checkbox" checked={draft.excluded.includes(k)} onChange={e=>edit('excluded',e.target.checked?[...draft.excluded,k]:draft.excluded.filter(x=>x!==k))}/></label>)}
 <button type="button" className="control-button" onClick={()=>edit('excluded',Object.keys(data.categories))}>Выбрать пять исключений</button>
 <label className="toggle"><span>Мягко учитывать текущие лайки и дизлайки Legacy</span><input type="checkbox" checked={draft.feedback_enabled} onChange={e=>edit('feedback_enabled',e.target.checked)}/></label>
 <label className="toggle"><span>Приоритет одежды, обуви и аксессуаров; чередовать типы</span><input type="checkbox" checked={draft.fashion_priority} onChange={e=>edit('fashion_priority',e.target.checked)}/></label>
 </fieldset><button type="button" className="control-button primary" disabled={!dirty||busy} onClick={save}>{busy?'Сохраняем…':'Подтвердить правила качества'}</button>{dirty&&<p>Изменения пока не сохранены.</p>}
 <button type="button" className="control-button" disabled={busy||dirty} onClick={async()=>{try{setVersions((await client.api('/api/admin/config/history')).items.filter(v=>v.scope==='audience_quality'));}catch(e){setError(e.message);}}}>История правил качества</button>
 {versions?.map(v=><p key={v.id}>{new Date(v.ts*1000).toLocaleString('ru-RU')} <button type="button" disabled={busy||dirty} onClick={async()=>{if(lock.current||!window.confirm('Восстановить правила качества до изменения?'))return;lock.current=true;setBusy(true);try{await client.api('/api/admin/config/restore','POST',{id:v.id,revision:data.revision,confirmed:true,request_id:crypto.randomUUID()});await load();setVersions(null);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}}}>Вернуть предыдущие правила</button></p>)}
 <h3>Реальные реакции</h3>{!f.available?<p>Сводка временно недоступна: Legacy и запреты сохраняются. Проверьте индекс реакций.</p>:<><p>👍 {f.likes} · 👎 {f.dislikes} · положительных {f.positive_ratio===null?'нет данных':Math.round(f.positive_ratio*100)+'%'}</p><p>{f.note}</p>{f.traits.map(t=><p key={t.key}>{t.label}: 👍 {t.likes} / 👎 {t.dislikes}; {t.people} человек, {t.products} товаров. {t.reason}{t.sufficient?' · приоритет ×'+t.multiplier.toFixed(2):''}</p>)}</>}
 <h3>Почему кандидат подходит или отклонён</h3>{[...data.rejected,...data.candidates].map(p=><p key={p.pid}>{p.allowed?'✅':'⛔'} {p.title} (№{p.pid}) · {p.reason}</p>)}
 <p>River остаётся SHADOW. Стили учитываются только по сохранённому профилю актуального изображения; гипотезы и неизвестные признаки не используются. Рейтинги из других экспериментов сюда не импортируются.</p>
 </div>;
}
