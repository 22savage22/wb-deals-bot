import React,{useEffect,useRef,useState} from 'react';
import './superfind-preview.css';

// The feature flag controls visibility only. Every API still verifies the
// main bot's Telegram signature and owner ID on the server independently.
export function acceptsSuperfindHandshake(event,frameWindow,origin){
  return !!frameWindow&&event.origin===origin&&event.source===frameWindow&&event.data?.type==='style-ready';
}

export default function SuperfindPreview({initData,onClose}){
  const frame=useRef(null),[attempt,setAttempt]=useState(0),[status,setStatus]=useState('loading');
  const enabled=globalThis.__WB_SUPERFIND_PREVIEW__===true;
  useEffect(()=>{
    if(!enabled)return;
    setStatus(initData?'loading':'no_session');
    if(!initData)return;
    const receive=event=>{
      if(!acceptsSuperfindHandshake(event,frame.current?.contentWindow,location.origin))return;
      // Never use '*', URL parameters, browser storage, or an asserted user ID.
      // Only this same-origin child receives the in-memory main-bot initData.
      event.source.postMessage({type:'style-init',initData},location.origin);
      clearTimeout(timer);setStatus('ready');
    };
    const timer=setTimeout(()=>setStatus('error'),12000);
    window.addEventListener('message',receive);
    return()=>{clearTimeout(timer);window.removeEventListener('message',receive);};
  },[enabled,initData,attempt]);
  if(!enabled)return null;
  const retry=()=>{setStatus('loading');setAttempt(value=>value+1);};
  return <section className="superfind-owner-preview" aria-label="Супернаходка дня · предпросмотр">
    <div className="superfind-owner-heading"><div><span className="eyebrow">Только владелец · без публикаций</span><h2>🔥 Супернаходка дня</h2></div><button type="button" className="superfind-owner-close" onClick={onClose} aria-label="Закрыть предпросмотр супернаходки">← Назад</button></div>
    <p className="subtle">Здесь тот же защищённый предпросмотр: пороги, кандидаты и решения не дублируются. Одобрение не отправляет пост. Если свежие цена, наличие или выгода не подтверждены, ждём данных — непроверенные скидки не публикуем.</p>
    {status==='loading'&&<p className="notice muted" role="status">Открываем защищённый предпросмотр…</p>}
    {status==='no_session'&&<p className="notice red" role="alert">Нет Telegram-сессии WBmarket. Полностью закройте приложение и снова откройте /admin в административном боте.</p>}
    {status==='error'&&<div className="notice red" role="alert"><p>Предпросмотр не ответил. Настройки канала не изменены. Можно повторить загрузку или вернуться назад.</p><button type="button" className="superfind-owner-retry" onClick={retry}>Повторить загрузку</button></div>}
    {initData&&<iframe key={attempt} ref={frame} src="/superfind" title="Защищённый предпросмотр супернаходок" className="superfind-owner-frame" onError={()=>setStatus('error')} referrerPolicy="same-origin"/>}
  </section>;
}
