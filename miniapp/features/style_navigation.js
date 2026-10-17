// Shared overlay for copied assets. Production is enabled only by the server
// flag; staging keeps its explicit preview notice. Neither is an identity gate.
(()=>{
  const publicRelease=globalThis.__WB_STYLE_ENABLED__===true;
  const tg=window.Telegram?.WebApp,button=document.createElement('button');button.className='filter-summary secondary';button.textContent=publicRelease?'❤️ Мой стиль':'❤️ Мой стиль · тест';button.id='open-my-style';button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','my-style-frame');
  document.getElementById('edit-discovery')?.before(button);
  if(!publicRelease){const notice=document.createElement('p');notice.className='notice';notice.textContent='Отдельная тестовая версия. Сохранения здесь не меняют ваш профиль в основном приложении. Цены примеров не подтверждены сейчас.';document.querySelector('main')?.prepend(notice);}
  let frame,previousOverflow='',backWasVisible=false;
  const close=()=>{if(!frame)return;frame.remove();frame=null;document.body.style.overflow=previousOverflow;button.setAttribute('aria-expanded','false');if(!backWasVisible)tg?.BackButton?.hide();button.focus({preventScroll:true});};
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame?.contentWindow)return;
    if(event.data?.type==='style-ready')frame.contentWindow.postMessage({type:'style-init',initData:tg?.initData??''},location.origin);
    if(event.data?.type==='style-close')close();
  });
  tg?.BackButton?.onClick(close);
  button.onclick=()=>{if(frame)return;previousOverflow=document.body.style.overflow;backWasVisible=!!tg?.BackButton?.isVisible;frame=document.createElement('iframe');frame.id='my-style-frame';frame.src='/style';frame.title='Мой стиль';frame.className='style-overlay';document.body.append(frame);document.body.style.overflow='hidden';button.setAttribute('aria-expanded','true');tg?.BackButton?.show();frame.focus();};
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&frame)close();});
})();
