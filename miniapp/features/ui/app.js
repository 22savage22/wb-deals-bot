const $=id=>document.getElementById(id),adminPage=location.pathname==='/superfind';
// The staged HTML is unchanged. Only the copied public production shell carries
// this marker; it changes labels, never access control or Telegram verification.
if(!adminPage&&document.documentElement.dataset.styleRuntime==='public'){
  document.querySelector('header .pill')?.remove();document.querySelector('.preview-note')?.remove();
}
const state={initData:'',version:0,profile:{rated:0},items:[],tab:'learn',busy:false,loading:false,loaded:false,pending:null,retry:null,superSettings:null,cursor:0,filtersConfigured:false,emptyReason:null};
// Existing subscribers may have ratings from before explicit filter setup.
// Their empty filters mean all/unbounded, not a reason to write defaults.
const needsOnboarding=()=>!state.filtersConfigured&&!(state.profile.rated>0||state.profile.seen>0);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};
let toastTimer;
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.add('visible');toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3000);}
function controls(){
  const locked=state.busy||state.loading||!!state.pending||!state.loaded;
  document.querySelectorAll('button,input,select').forEach(el=>{el.disabled=locked&&!el.classList.contains('back-button');});
  $('retry').disabled=state.busy||state.loading;
  $('operation-status').hidden=!(state.busy||state.loading);
  $('operation-status').textContent=state.busy?'Сохраняем…':state.loading?'Загружаем…':'';
  document.querySelector('main').setAttribute('aria-busy',String(state.busy||state.loading));
}
function busy(value){state.busy=value;controls();}
async function api(path,{method='GET',data}={}){
  let response;try{response=await fetch(path,{method,cache:'no-store',headers:{'X-Telegram-Init-Data':state.initData,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(10000)});}catch{throw Object.assign(new Error(method==='GET'?'Не удалось загрузить данные. Проверьте интернет и попробуйте ещё раз.':'Нет подтверждения сохранения. Не нажимайте оценку заново — «Повторить безопасно» проверит тот же запрос без дубля.'),{network:true});}
  let result;try{result=await response.json();}catch{throw Object.assign(new Error('Сервер вернул неполный ответ. Повторите запрос безопасно.'),{network:true,status:response.status});}
  if(!response.ok)throw Object.assign(new Error(response.status===401?'Срок входа истёк. Закройте приложение полностью и снова откройте его кнопкой Telegram-бота.':response.status===403?'Этот раздел недоступен для вашего аккаунта.':response.status===429?'Слишком много запросов. Подождите немного и повторите.':result.error??'Не удалось выполнить действие'),{status:response.status});return result;
}
function showError(error,retry=state.pending?sendPending:null){state.retry=retry;$('error').hidden=false;$('error-text').textContent=error.message;$('retry').hidden=!retry;$('error').scrollIntoView({block:'nearest',behavior:'smooth'});}
async function readAction(action){
  if(state.busy||state.loading||state.pending)return;state.loading=true;controls();$('error').hidden=true;
  try{await action();}catch(error){showError(error,()=>readAction(action));}finally{state.loading=false;controls();}
}
async function write(path,method,data,onSuccess){
  if(state.busy||state.loading||state.pending||!state.loaded)return;const pending={path,method,data:{...data,version:state.version,requestId:crypto.randomUUID()},onSuccess};state.pending=pending;await sendPending();
}
async function sendPending(){
  const pending=state.pending;if(!pending||state.busy||state.loading)return;busy(true);$('error').hidden=true;let committed=false;
  try{const result=await api(pending.path,{method:pending.method,data:pending.data});state.version=result.version;if(result.profile){state.profile=result.profile;state.filtersConfigured=result.profile.filtersConfigured??state.filtersConfigured;}state.pending=null;state.retry=null;committed=true;await pending.onSuccess?.(result);toast('✓ Сохранено');}
  catch(error){
    if(committed){showError(Error('Изменение сохранено, но экран не обновился. Загрузите его ещё раз.'),()=>readAction(refresh));}
    else if(error.status===409){state.pending=null;let refreshed=true;try{await refresh();}catch{refreshed=false;}showError(Error(`${error.message}. ${refreshed?'Мы загрузили актуальный профиль — повторите действие, если оно ещё нужно.':'Сначала обновите профиль.'}`),()=>readAction(refresh));}
    else if(error.status>=400&&error.status<500&&!error.network){state.pending=null;showError(error,error.status===401||error.status===403?null:()=>readAction(refresh));}
    else showError(error,sendPending);
  }finally{busy(false);}
}
function imageCard(item,{small=false}={}){
  const card=node('article',null,'product-card'),photo=node('div',null,'photo'),image=node('img');image.src=item.image;image.alt=item.name;image.loading=small?'lazy':'eager';image.onerror=()=>{image.remove();photo.prepend(node('p','Фото временно недоступно','fine'));};photo.append(image);
  const favorite=node('button',item.favorite?'♥':'♡');favorite.setAttribute('aria-label',item.favorite?'Убрать из избранного':'В избранное');favorite.setAttribute('aria-pressed',String(!!item.favorite));favorite.onclick=()=>write('/api/style/favorite','POST',{id:item.id,saved:!item.favorite},async()=>{item.favorite=!item.favorite;favorite.textContent=item.favorite?'♥':'♡';favorite.setAttribute('aria-label',item.favorite?'Убрать из избранного':'В избранное');favorite.setAttribute('aria-pressed',String(item.favorite));if(state.tab==='favorites')await showTab('favorites',{refresh:true});});photo.append(favorite);card.append(photo);
  const info=node('div',null,'card-info');if(item.category)info.append(node('span',item.category,'category'));info.append(node('h2',item.name));
  if(Number.isFinite(item.price)&&item.price>0&&item.priceConfirmed===true)info.append(node('p',`${item.price.toLocaleString('ru')} ₽`,'product-price'));
  else info.append(node('p','Цену и наличие уточните на WB','price-unknown'));
  const details=node('details',null,'product-details');details.append(node('summary',small?'О товаре':'Почему эта вещь?'));if(item.priceNote)details.append(node('p',item.priceNote,'fine'));
  if(item.priceObservedAt)details.append(node('p',`Проверка цены: ${new Date(item.priceObservedAt).toLocaleString('ru-RU')}`,'fine'));
  const quality=item.qualityEvidence;if(quality?.rating!=null||quality?.reviews!=null){details.append(node('p',[quality.rating!=null?`Рейтинг ${quality.rating}`:null,quality.reviews!=null?`Отзывов ${quality.reviews}`:null].filter(Boolean).join(' · '),'fine'));if(quality.status!=='fresh_verified')details.append(node('p','Сохранённые сведения о качестве, не свежая проверка.','fine'));if(quality.note)details.append(node('p',quality.note,'fine'));}
  for(const reason of item.reasons??[])details.append(node('p',reason,'reason'));
  if(item.confidence==='category_only_low')details.append(node('span','Пока только категория · низкая уверенность','badge'));
  else if(item.confidence==='limited_visual_evidence')details.append(node('span','Есть подтверждённые признаки · вывод предварительный','badge'));
  else details.append(node('p',item.exploration?'Немного нового: пробуем другое направление, это не уверенный прогноз.':'Пока знакомимся: это не точный прогноз вашего вкуса.','fine'));info.append(details);
  const link=node('a','Открыть на Wildberries ↗','wb-link');link.href=item.url;link.target='_blank';link.rel='noopener noreferrer';info.append(link);card.append(info);return card;
}
function renderDeck(){
  const item=state.items[0];
  if(item)$('card').replaceChildren(imageCard(item));else{
    const empty=node('div',null,'empty');empty.append(node('h2',needsOnboarding()?'Начните с ваших интересов':state.emptyReason==='fresh_price_evidence_unavailable'?'Нет подтверждённых цен под этот бюджет':state.emptyReason==='audience_evidence_unavailable'?'Для выбранного раздела пока мало данных':'Новых подходящих вещей пока нет'),node('p',needsOnboarding()?'Выберите, что вам интересно, и нажмите «Сохранить и смотреть». Настройки не сохранятся без вашего действия.':state.emptyReason==='fresh_price_evidence_unavailable'?'Не будем подменять свежую цену исторической. Можно убрать бюджет и оценивать стиль по фотографиям; цену вы увидите на Wildberries.':state.emptyReason==='audience_evidence_unavailable'?'В этой подборке не хватает подтверждённых данных «женское / мужское / унисекс». Мы не угадываем их по названию или внешности модели. Можно временно выбрать «Для всех».':'Все подходящие фото из текущей подборки уже оценены или не подходят под ваши фильтры. Старые вещи ради количества не повторяем.'));
    const edit=node('button',needsOnboarding()?'Выбрать интересы':'Изменить интересы и бюджет','primary');edit.onclick=openFilters;empty.append(edit);$('card').replaceChildren(empty);
  }
  $('actions').hidden=!item;$('skip').hidden=!item;$('progress').textContent=`${state.profile.rated??0} оценено`;
  $('deck-title').textContent=state.tab==='recommend'?'❤️ Подобрано для вас':'Знакомимся с вашим вкусом';
  $('style-steps').textContent=state.tab==='recommend'?'Только ещё не оценённые вами вещи. Подбор учитывает ваши реакции, но не обещает идеальное попадание.':'Нравится — учит подбор. Больше такого — сильнее учитывает пример. «Не показывать похожее» исключает близкие подтверждённые фасоны, а не целую категорию.';controls();
}
async function vote(action){const item=state.items[0];if(!item||state.busy)return;await write('/api/style/vote','POST',{id:item.id,action},()=>{state.items.shift();renderDeck();if(!state.items.length)return loadFeed();});}
async function loadFeed(){state.items=[];if(needsOnboarding()){renderDeck();return;}$('card').replaceChildren(node('p','Ищем ещё не оценённые вами вещи…','empty'));$('actions').hidden=true;$('skip').hidden=true;const result=await api(`/api/style/feed?mode=${state.tab==='recommend'?'recommend':'learn'}&cursor=${state.cursor++}`);state.items=result.items;state.emptyReason=result.emptyReason;state.version=result.version;renderDeck();}
function preferences(){
  const box=$('taste-summary');box.replaceChildren();const panel=node('div',null,'panel');panel.append(node('span',`${state.profile.rated??0} ваших оценок`,'pill'),node('h2',state.profile.ready?'Вкус постепенно складывается':'Начнём с нескольких вещей'),node('p',state.profile.note??''));
  for(const [key,title] of [['preferred','Чаще нравилось'],['avoided','Реже нравилось']]){panel.append(node('h2',title));const list=node('ul');for(const row of state.profile[key]??[])list.append(node('li',`${row.label} · ${row.products} разных вещей`));if(!list.children.length)list.append(node('li','Пока недостаточно подтверждённых примеров'));panel.append(list);}
  if(!state.profile.visualEvidence)panel.append(node('p','Фасоны, цвета и принты пока не подтверждены достаточными оценками. По названиям товаров мы их не угадываем.','fine'));
  panel.append(node('p','Процент точности и улучшение не заявляем: нужен отдельный независимый тест.','fine'));const edit=node('button','Изменить интересы и бюджет','primary');edit.onclick=openFilters;panel.append(edit);box.append(panel);
}
const groupLabels={clothing:'Одежда',shoes:'Обувь',bags:'Сумки',accessories:'Аксессуары'},audienceLabels={all:'Для всех',women:'Женское',men:'Мужское',neutral:'Унисекс'};
function openFilters(){$('filters-panel').open=true;$('filters-panel').scrollIntoView({block:'start',behavior:'smooth'});}
function setFilterForm(filters={}){
  const groups=filters.groups??(filters.group?[filters.group]:[]),audience=filters.audience??'all';
  document.querySelectorAll('[name="audience"]').forEach(input=>{input.checked=input.value===audience;});document.querySelectorAll('[name="groups"]').forEach(input=>{input.checked=groups.includes(input.value);});
  $('min-price').value=filters.minPrice??'';$('max-price').value=filters.maxPrice??'';
  const budget=filters.minPrice!=null&&filters.maxPrice!=null?`${filters.minPrice}–${filters.maxPrice} ₽`:filters.maxPrice!=null?`до ${filters.maxPrice} ₽`:filters.minPrice!=null?`от ${filters.minPrice} ₽`:'без лимита';
  $('filter-label').textContent=`${audienceLabels[audience]??'Для всех'} · ${groups.length?groups.map(group=>groupLabels[group]).join(', '):'Все вещи'} · ${budget}`;
  $('onboarding-copy').hidden=!needsOnboarding();$('apply-filters').textContent=needsOnboarding()?'Сохранить и смотреть':'Сохранить изменения';if(needsOnboarding())$('filters-panel').open=true;
}
async function showTab(tab,{refresh=false}={}){
  if((state.busy||state.pending)&&!refresh)return;state.tab=tab;document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});
  $('deck').hidden=!['learn','recommend'].includes(tab);$('favorites-view').hidden=tab!=='favorites';$('preferences-view').hidden=tab!=='preferences';
  if(tab==='favorites'){const result=await api('/api/style/favorites');$('favorites-list').replaceChildren(...result.items.map(item=>imageCard({...item,favorite:true},{small:true})));if(!result.items.length)$('favorites-list').append(node('p','Здесь будут ваши сохранённые вещи. Нажимайте сердечко на фотографии — оценки и избранное работают отдельно.','empty'));}
  else if(tab==='preferences'){const me=await api('/api/style/me');state.profile=me;state.version=me.version;state.filtersConfigured=me.filtersConfigured??Object.keys(me.filters??{}).length>0;setFilterForm(me.filters);preferences();}else await loadFeed();controls();
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
async function refresh(){if(adminPage){await loadAdmin();state.loaded=true;return;}const me=await api('/api/style/me');state.profile=me;state.version=me.version;state.filtersConfigured=me.filtersConfigured??Object.keys(me.filters??{}).length>0;state.loaded=true;setFilterForm(me.filters);await showTab(state.tab,{refresh:true});}
async function start(){
  controls();
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
    const back=node('button','← Находки','back-button');
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
  $('style-view').hidden=adminPage;$('admin-view').hidden=!adminPage;await refresh();controls();
}
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>readAction(()=>showTab(b.dataset.tab)));document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>vote(b.dataset.action));$('skip').onclick=()=>vote('skip');$('retry').onclick=()=>state.retry?.();
$('demo-profile').onchange=()=>{const u=new URL(location.href);u.searchParams.set('profile',$('demo-profile').value);location.href=u;};
document.querySelectorAll('[data-budget]').forEach(button=>button.onclick=()=>{$('max-price').value=button.dataset.budget;$('min-price').value='';});
$('filters-form').onsubmit=e=>{
  e.preventDefault();const filters={audience:document.querySelector('[name="audience"]:checked')?.value??'all',groups:[...document.querySelectorAll('[name="groups"]:checked')].map(input=>input.value)};
  for(const [key,id] of [['minPrice','min-price'],['maxPrice','max-price']])if($(id).value!=='')filters[key]=Number($(id).value);
  if(filters.minPrice!=null&&filters.maxPrice!=null&&filters.minPrice>filters.maxPrice){showError(Error('Цена «от» не может быть больше цены «до».'));return;}
  write('/api/style/filters','PUT',{filters},async()=>{state.filtersConfigured=true;setFilterForm(state.profile.filters??filters);$('filters-panel').open=false;await showTab(['learn','recommend'].includes(state.tab)?state.tab:'learn',{refresh:true});$('deck').scrollIntoView({block:'start',behavior:'smooth'});});
};
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
function connectionStatus(){const offline=navigator.onLine===false;$('connection-status').hidden=!offline;$('connection-status').textContent=offline?'Вы без интернета. Уже сохранённые оценки не потеряются. Для новых действий восстановите соединение.':'';}
window.addEventListener('offline',connectionStatus);window.addEventListener('online',()=>{connectionStatus();if(state.pending)toast('Интернет вернулся. Нажмите «Повторить безопасно», чтобы подтвердить сохранение.');});connectionStatus();
start().catch(error=>{controls();showError(error,state.initData?()=>readAction(refresh):null);});
