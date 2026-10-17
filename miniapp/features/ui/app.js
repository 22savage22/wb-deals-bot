const $=id=>document.getElementById(id),adminPage=location.pathname==='/superfind';
const state={initData:'',version:0,profile:{rated:0},items:[],tab:'learn',busy:false,pending:null,superSettings:null,cursor:0};
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
function toast(text){$('toast').textContent=text;$('toast').classList.add('visible');setTimeout(()=>$('toast').classList.remove('visible'),2500);}
function busy(value){state.busy=value;document.querySelectorAll('button').forEach(b=>b.disabled=value);$('retry').disabled=false;}
async function api(path,{method='GET',data}={}){
  let response;try{response=await fetch(path,{method,headers:{'X-Telegram-Init-Data':state.initData,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(10000)});}catch{throw Object.assign(new Error('Сеть не ответила. Оценка могла сохраниться — повторим тот же запрос без дубля.'),{network:true});}
  const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error??'Не удалось выполнить действие'),{status:response.status});return result;
}
function showError(error){$('error').hidden=false;$('error-text').textContent=error.message;$('retry').hidden=!state.pending;$('error').scrollIntoView({block:'center'});}
async function write(path,method,data,onSuccess){
  if(state.busy)return;const pending={path,method,data:{...data,version:state.version,requestId:crypto.randomUUID()},onSuccess};state.pending=pending;await sendPending();
}
async function sendPending(){
  const pending=state.pending;if(!pending||state.busy)return;busy(true);$('error').hidden=true;
  try{const result=await api(pending.path,{method:pending.method,data:pending.data});state.version=result.version;if(result.profile)state.profile=result.profile;state.pending=null;await pending.onSuccess?.(result);toast('✓ Сохранено');}
  catch(error){if(error.status===409){state.pending=null;await refresh().catch(()=>{});}showError(error);}finally{busy(false);}
}
function imageCard(item,{small=false}={}){
  const card=node('article',null,'product-card'),photo=node('div',null,'photo'),image=node('img');image.src=item.image;image.alt=item.name;image.loading=small?'lazy':'eager';image.onerror=()=>{image.remove();photo.prepend(node('p','Фото временно недоступно','fine'));};photo.append(image);
  const favorite=node('button',item.favorite?'♥':'♡');favorite.setAttribute('aria-label',item.favorite?'Убрать из избранного':'В избранное');favorite.onclick=()=>write('/api/style/favorite','POST',{id:item.id,saved:!item.favorite},()=>{item.favorite=!item.favorite;favorite.textContent=item.favorite?'♥':'♡';});photo.append(favorite);card.append(photo);
  const info=node('div',null,'card-info');if(item.category)info.append(node('span',item.category,'category'));info.append(node('h2',item.name));
  if(item.price!=null)info.append(node('p',`${item.price.toLocaleString('ru')} ₽`));if(item.priceNote)info.append(node('p',item.priceNote,'fine'));
  for(const reason of item.reasons??[])info.append(node('p',reason,'reason'));
  if(item.confidence==='category_only_low')info.append(node('span','Пока только категория · низкая уверенность','badge'));
  const link=node('a','Открыть на Wildberries ↗','wb-link');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';info.append(link);card.append(info);return card;
}
function renderDeck(){
  const item=state.items[0];$('card').replaceChildren(item?imageCard(item):node('p','В текущем проверенном каталоге больше нет неоценённых подходящих вещей. Мы не повторяем старые ради количества. Попробуйте другую категорию или уберите ценовой фильтр.','empty'));
  $('actions').hidden=!item;$('skip').hidden=!item;$('progress').textContent=`${state.profile.rated??0} оценено`;
  $('deck-title').textContent=state.tab==='recommend'?'❤️ Подобрано для вас':'Знакомимся с вашим вкусом';
}
async function vote(action){const item=state.items[0];if(!item||state.busy)return;await write('/api/style/vote','POST',{id:item.id,action},()=>{state.items.shift();renderDeck();if(!state.items.length)return loadFeed();});}
async function loadFeed(){const result=await api(`/api/style/feed?mode=${state.tab==='recommend'?'recommend':'learn'}&cursor=${state.cursor++}`);state.items=result.items;state.version=result.version;renderDeck();}
function preferences(){
  const box=$('taste-summary');box.replaceChildren();const panel=node('div',null,'panel');panel.append(node('span',`${state.profile.rated??0} ваших оценок`,'pill'),node('h2',state.profile.ready?'Вкус постепенно складывается':'Начнём с нескольких вещей'),node('p',state.profile.note??''));
  for(const [key,title] of [['preferred','Чаще нравилось'],['avoided','Реже нравилось']]){panel.append(node('h2',title));const list=node('ul');for(const row of state.profile[key]??[])list.append(node('li',`${row.label} · ${row.products} разных вещей`));if(!list.children.length)list.append(node('li','Пока недостаточно подтверждённых примеров'));panel.append(list);}
  if(!state.profile.visualEvidence)panel.append(node('p','Фасоны, цвета и принты пока не подтверждены достаточными оценками. По названиям товаров мы их не угадываем.','fine'));
  panel.append(node('p','Процент точности и улучшение не заявляем: нужен отдельный независимый тест.','fine'));box.append(panel);
}
function setFilterForm(filters={}){$('group').value=filters.group??'';$('min-price').value=filters.minPrice??'';$('max-price').value=filters.maxPrice??'';$('filter-label').textContent=`${$('group').selectedOptions[0].textContent} · ${filters.maxPrice!=null?`до ${filters.maxPrice} ₽`:'без лимита'}`;}
async function showTab(tab,{refresh=false}={}){
  if(state.busy&&!refresh)return;state.tab=tab;document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $('deck').hidden=!['learn','recommend'].includes(tab);$('favorites-view').hidden=tab!=='favorites';$('preferences-view').hidden=tab!=='preferences';
  try{if(tab==='favorites'){const result=await api('/api/style/favorites');$('favorites-list').replaceChildren(...result.items.map(item=>imageCard({...item,favorite:true},{small:true})));if(!result.items.length)$('favorites-list').append(node('p','Сохраняйте вещи сердечком на фотографии.','empty'));}
    else if(tab==='preferences'){const me=await api('/api/style/me');state.profile=me;state.version=me.version;preferences();}else await loadFeed();}catch(error){showError(error);}
}
const reasons={price_not_fresh_verified:'Нет свежей подтверждённой цены',availability_unknown:'Наличие неизвестно',stock_evidence_not_fresh:'Нет свежей проверки наличия',publication_history_unverified:'Не подтверждена полная история публикаций',already_published:'Этот товар уже опубликован',verified_savings_below_threshold_or_unknown:'Нет доказанной выгоды по истории или сопоставимым товарам',reviews_below_quality_gate_or_unknown:'Недостаточно подтверждённых отзывов',price_context_or_variant_unknown:'Неизвестны вариант или условия цены'};
async function loadAdmin(){
  const result=await api('/api/admin/superfind');state.version=result.version;state.superSettings=result.settings;
  $('super-enabled').checked=result.settings.enabled;$('min-rating').value=result.settings.minRating;$('min-reviews').value=result.settings.minReviews;$('min-savings').value=result.settings.minSavings;
  const out=$('super-candidates');out.replaceChildren();
  if(!result.candidates.length)out.append(node('p','Сейчас нет подтверждённой супернаходки. Это нормальный результат строгого отбора — пост не создаётся.','empty'));
  for(const item of result.candidates){const panel=node('div',null,'panel'),img=node('img');img.src=item.image;img.alt=item.name;img.width=250;panel.append(node('span','🔥 СУПЕРНАХОДКА ДНЯ · только макет','badge'),img,node('pre',item.preview.caption.replace(/<\/?b>/g,'').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'),'caption'),node('pre',JSON.stringify(item.preview.proof,null,2),'proof'));
    for(const [action,label] of [['approve','Одобрить предпросмотр'],['reject','Отклонить']]){const b=node('button',label);b.onclick=()=>write('/api/admin/superfind/decision','POST',{id:item.id,action},loadAdmin);panel.append(b);}out.append(panel);}
  $('super-rejected').replaceChildren(...result.rejected.map(item=>{const panel=node('div',null,'panel'),photo=node('img');photo.src=item.image;photo.alt=item.name;photo.loading='lazy';photo.className='rejected-photo';panel.append(photo,node('span','Не супернаходка · данных недостаточно','badge'),node('h2',item.name),node('p',`nmId ${item.id}`,'fine'));for(const reason of item.reasons)panel.append(node('p',reasons[reason]??reason,'fine'));return panel;}));
  $('super-history').replaceChildren(...result.history.map(row=>node('p',`${new Date(row.ts).toLocaleString('ru-RU')} · ${row.pid} · ${row.decision==='approved_preview'?'Одобрен макет (не опубликован)':'Отклонён'}`,'fine')));
}
async function refresh(){if(adminPage)return loadAdmin();const me=await api('/api/style/me');state.profile=me;state.version=me.version;setFilterForm(me.filters);await showTab(state.tab,{refresh:true});}
async function start(){
  window.Telegram?.WebApp?.ready();window.Telegram?.WebApp?.expand();
  state.initData=window.Telegram?.WebApp?.initData??'';
  if(!state.initData&&window.parent!==window){
    state.initData=await new Promise((resolve,reject)=>{
      const handler=event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='style-init'&&typeof event.data.initData==='string'){clearTimeout(timer);window.removeEventListener('message',handler);resolve(event.data.initData);}};
      const timer=setTimeout(()=>{window.removeEventListener('message',handler);reject(Error('Откройте тестовую версию через кнопку Telegram-бота'));},10000);
      window.addEventListener('message',handler);window.parent.postMessage({type:'style-ready'},location.origin);
    });
  }
  if(!adminPage){
    const back=node('button','← Находки');
    // A private Telegram button can open /style directly. Preserve Telegram's
    // launch fragment on the same-origin return; never log or store initData.
    back.onclick=()=>window.parent!==window?window.parent.postMessage({type:'style-close'},location.origin):location.assign('/'+location.hash);
    document.querySelector('header').prepend(back);
    document.querySelector('.brand').onclick=e=>{e.preventDefault();window.scrollTo({top:0});};
  }
  if(!state.initData&&location.hostname==='127.0.0.1'){
    const profile=adminPage?'admin':new URL(location.href).searchParams.get('profile')??'a',response=await fetch(`/preview/session?profile=${encodeURIComponent(profile)}`),session=await response.json();state.initData=session.initData;
    if(!adminPage){$('session').hidden=false;$('demo-profile').value=profile;}
  }
  if(!state.initData)throw Error('Откройте Mini App из соответствующего Telegram-бота');
  $('style-view').hidden=adminPage;$('admin-view').hidden=!adminPage;await refresh();
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>showTab(b.dataset.tab));document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>vote(b.dataset.action));$('skip').onclick=()=>vote('skip');$('retry').onclick=sendPending;
$('demo-profile').onchange=()=>{const u=new URL(location.href);u.searchParams.set('profile',$('demo-profile').value);location.href=u;};
$('filters-form').onsubmit=e=>{e.preventDefault();const filters={group:$('group').value};for(const [key,id] of [['minPrice','min-price'],['maxPrice','max-price']])if($(id).value!=='')filters[key]=Number($(id).value);write('/api/style/filters','PUT',{filters},async()=>{setFilterForm(filters);await loadFeed();});};
$('reset').onclick=()=>{if(confirm('Удалить только ваши оценки, фильтры и профиль вкуса? Избранное останется.'))write('/api/style/me','DELETE',{},async()=>{setFilterForm({});preferences();await loadFeed();});};
const eraseAll=node('button','Удалить также избранное «Моего стиля»','danger');$('reset').after(eraseAll);eraseAll.onclick=()=>{if(confirm('Удалить все ваши оценки, предпочтения, фильтры и избранное «Моего стиля»?'))write('/api/style/history','DELETE',{},async()=>{setFilterForm({});preferences();await loadFeed();});};
$('super-settings').onsubmit=e=>{e.preventDefault();const settings={...state.superSettings,enabled:$('super-enabled').checked,minRating:Number($('min-rating').value),minReviews:Number($('min-reviews').value),minSavings:Number($('min-savings').value)};write('/api/admin/superfind/settings','PUT',{settings},loadAdmin);};
$('refresh-super').onclick=async()=>{
  if(state.busy)return;busy(true);$('error').hidden=true;
  const requestId=sessionStorage.getItem('super-refresh-pending')??crypto.randomUUID();sessionStorage.setItem('super-refresh-pending',requestId);
  try{await api('/api/admin/superfind/refresh',{method:'POST',data:{requestId}});$('job-status').textContent='Проверка запущена. Можно пользоваться интерфейсом.';
    const started=Date.now();const poll=async()=>{try{const job=await api(`/api/admin/superfind/job?id=${requestId}`);if(['done','error'].includes(job.status)){sessionStorage.removeItem('super-refresh-pending');$('job-status').textContent=job.status==='done'?`Проверено ${job.scanned} · прошло ${job.eligible} · Telegram-публикаций 0`:job.error;await loadAdmin();}else if(Date.now()-started<30000)setTimeout(poll,1000);else $('job-status').textContent='Проверка ещё не завершилась. Нажмите «Проверить кандидатов» для проверки той же задачи; повторного запуска не будет.';}catch(error){showError(error);}};setTimeout(poll,400);
  }catch(error){showError(error);}finally{busy(false);}
};
start().catch(showError);
