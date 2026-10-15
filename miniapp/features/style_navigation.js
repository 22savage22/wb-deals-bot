// Staging-only overlay added to COPIED public assets, never the production UI.
(()=>{
  const tg=window.Telegram?.WebApp,button=document.createElement('button');button.className='filter-summary secondary';button.textContent='❤️ Мой стиль · тест';button.id='open-my-style';
  document.getElementById('edit-discovery')?.before(button);
  const notice=document.createElement('p');notice.className='notice';notice.textContent='Отдельная тестовая версия. Сохранения здесь не меняют ваш профиль в основном приложении. Цены примеров не подтверждены сейчас.';document.querySelector('main')?.prepend(notice);
  let frame;
  const close=()=>{frame?.remove();frame=null;tg?.BackButton?.hide();};
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame?.contentWindow)return;
    if(event.data?.type==='style-ready')frame.contentWindow.postMessage({type:'style-init',initData:tg?.initData??''},location.origin);
    if(event.data?.type==='style-close')close();
  });
  tg?.BackButton?.onClick(close);
  button.onclick=()=>{if(frame)return;frame=document.createElement('iframe');frame.src='/style';frame.title='Мой стиль';frame.className='style-overlay';document.body.append(frame);tg?.BackButton?.show();};
})();
