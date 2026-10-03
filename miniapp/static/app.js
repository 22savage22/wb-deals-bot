'use strict';
const $ = (s) => document.querySelector(s);
const tg = window.Telegram?.WebApp;
const state = {products: [], slots: {}, saved: [], outfits: [], preferences: {}, category: 'all', folder: 'Все', anchor: null, exclude: [], suggestions: [], tab: 'finds', authenticated: false, admin: false, visibleCount: 48};
const money = (n) => new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(n) + ' ₽';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const product = (id) => state.products.find(p => p.id === Number(id)) || (state.privateProducts || []).find(p => p.id === Number(id));
const saved = (id) => state.saved.find(p => p.product_id === id);
const stale = (p) => !p.checked_at || Date.now()/1000 - p.checked_at > 48*3600;
const DISCOVERY_KEY = 'finds.discovery.v1';
const discoveryDefaults = {audience:'all', interest:'all', maxPrice:0};
let discovery = {...discoveryDefaults}, discoverySeen = false;
try {const stored=JSON.parse(localStorage.getItem(DISCOVERY_KEY)); if(stored?.version===1){ discoverySeen=true; discovery={audience:['all','women','men'].includes(stored.audience)?stored.audience:'all',interest:['all','apparel','accessories','home'].includes(stored.interest)?stored.interest:'all',maxPrice:Number.isFinite(stored.maxPrice)&&stored.maxPrice>=100&&stored.maxPrice<=1000000?stored.maxPrice:0}; }}catch(_){/* Storage can be disabled in embedded browsers. */}
const failedImages = new Set();
let feed = [], feedOffset = 0, automaticPages = 0;
function interestOf(p) {return ['bag','belt','hat','jewelry','accessory','accessories'].includes(p.slot)?'accessories':['top','bottom','dress','shoes','outer'].includes(p.slot)?'apparel':/дом|кухн|посуд|постель|полотен|декор|светильник|ваза|плед|подуш|ковр|хранени|органайзер/i.test(`${p.category} ${p.title}`)?'home':'other';}
function interleave(items) {const buckets=new Map();for(const p of items){const key=p.slot||'other';if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(p);}const result=[];while(buckets.size){for(const [key,items] of buckets){result.push(items.shift());if(!items.length)buckets.delete(key);}}return result;}
function rememberDiscovery() {discoverySeen=true;try{localStorage.setItem(DISCOVERY_KEY,JSON.stringify({version:1,...discovery}));}catch(_){/* Preferences still work for this visit. */}}
function openDiscovery() {const form=$('#discovery-form');form.elements.audience.value=discovery.audience;form.elements.interest.value=discovery.interest;$('#discovery-price').value=discovery.maxPrice||'';$('#discovery-dialog').showModal();}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4200); }
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, {...options, headers: {'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg?.initData || '', ...options.headers}});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
  return data;
}
function requireAuth() { if (state.authenticated) return true; toast('Для личных сохранений откройте приложение через Telegram-бота.'); return false; }
function image(p, className = '') {
  return p.image ? `<img class="${className}" src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="no-image"><span>◇</span><small>Фото пока нет</small></div>';
}
// Image errors are handled without inline scripts (strict content security policy).
document.addEventListener('error', (event) => { if (event.target.tagName === 'IMG') { const card=event.target.closest('#products .product-card');if(card){failedImages.add(Number(card.dataset.product));card.remove();updateFeedStatus();if(!$('#products').children.length)appendFeed();return;}const box=document.createElement('div'); box.className='no-image'; box.textContent='Фото временно недоступно'; event.target.replaceWith(box); } }, true);
function showTab(tab) {
  if (tab === 'admin' && !state.admin) return;
  state.tab = tab;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== tab);
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'saved') renderSaved();
  if (tab === 'builder') renderAnchor();
  if (tab === 'profile') renderProfile();
  if (tab === 'admin') loadAdmin().catch(e => toast(e.message));
  window.scrollTo({top: 0, behavior: 'instant'});
}
function card(p) {
  const s = saved(p.id);
  return `<article class="product-card" data-product="${p.id}"><div class="photo-wrap"><button class="photo-open" data-detail="${p.id}" aria-label="Подробнее: ${esc(p.title)}">${image(p)}</button><button class="save-button ${s ? 'selected' : ''}" data-save="${p.id}" aria-label="${s ? 'Убрать из сохранённого' : 'Сохранить'}" aria-pressed="${!!s}">${s ? '♥' : '♡'}</button>${s?.owned ? '<span class="badge">Уже есть</span>' : stale(p) ? '<span class="badge">Цена требует проверки</span>' : ''}</div><div class="price-row"><span class="price">${money(p.price)}</span><span class="rating">${p.rating ? '★ '+p.rating : ''}</span></div><p class="product-name">${esc(p.title)}</p><button class="build-link" ${p.slot === 'other' ? `data-detail="${p.id}"` : `data-build="${p.id}"`}>${p.slot === 'other' ? 'Посмотреть вещь' : 'Собрать образ'}<span>↗</span></button></article>`;
}
function renderCatalog() {
  const query = $('#search').value.toLowerCase().trim();
  const products = state.products.filter(p => p.image && !failedImages.has(p.id) && (discovery.audience==='all'||p.audience===discovery.audience||interestOf(p)==='home') && (!discovery.maxPrice||p.price<=discovery.maxPrice) && (discovery.interest==='all'||interestOf(p)===discovery.interest) && (state.category === 'all' || p.slot === state.category) && (p.title+' '+p.category).toLowerCase().includes(query));
  const sort = $('#sort').value;
  products.sort((a,b) => sort === 'price' ? a.price-b.price : sort === 'rating' ? b.rating-a.rating : b.checked_at-a.checked_at);
  feed=sort==='mix'?interleave(products):products;feedOffset=0;automaticPages=0;
  $('#products').innerHTML='';appendFeed();
  $('#edit-discovery').textContent=`${{all:'Для всех',women:'Женское',men:'Мужское'}[discovery.audience]} · ${discovery.maxPrice?'до '+money(discovery.maxPrice):'Любой бюджет'} · Настроить`;
  $('#categories').innerHTML = [['all','Все'],...Object.entries(state.slots).filter(([slot]) => state.products.some(p => p.slot === slot))].map(([id,name]) => `<button class="chip ${state.category === id ? 'active' : ''}" data-category="${id}">${esc(name)}</button>`).join('');
}
function updateFeedStatus(){const total=feed.filter(p=>!failedImages.has(p.id)).length;$('#count').textContent=`${total} вещей с фото`;$('#load-more').hidden=feedOffset>=feed.length;$('#feed-status').textContent=feedOffset>=feed.length&&total?'Вы посмотрели все находки по этим фильтрам. Можно выбрать что-то новое.':'';if(!$('#products').children.length&&feedOffset>=feed.length)$('#products').innerHTML='<div class="empty"><h2>Попробуем чуть шире?</h2><p>Пока нет вещей с фото по этим условиям. Измените бюджет или категорию.</p><button class="secondary" data-open-discovery="1">Изменить фильтры</button></div>';}
function appendFeed(){const batch=feed.slice(feedOffset,feedOffset+24);feedOffset+=batch.length;$('#products').insertAdjacentHTML('beforeend',batch.filter(p=>!failedImages.has(p.id)).map(card).join(''));updateFeedStatus();}
function updateSaveButtons(){document.querySelectorAll('[data-save]').forEach(b=>{const yes=!!saved(Number(b.dataset.save));b.classList.toggle('selected',yes);b.setAttribute('aria-pressed',String(yes));b.setAttribute('aria-label',yes?'Убрать из сохранённого':'Сохранить');b.textContent=yes?'♥':'♡';});}
function renderSaved() {
  const folders = ['Все',...new Set(state.saved.map(s => s.folder)), 'Уже есть'];
  $('#folders').innerHTML = [...new Set(folders)].map(f => `<button class="chip ${state.folder === f ? 'active' : ''}" data-folder="${esc(f)}">${esc(f)}</button>`).join('');
  const items = state.saved.filter(s => state.folder === 'Все' || (state.folder === 'Уже есть' ? s.owned : s.folder === state.folder)).map(s => product(s.product_id)).filter(Boolean);
  $('#saved-products').innerHTML = items.length ? items.map(card).join('') : `<p class="empty">${state.authenticated ? 'Сохраняйте вещи значком ♡ — они появятся здесь.' : 'Откройте приложение через Telegram, чтобы видеть свои сохранённые находки.'}</p>`;
  $('#saved-outfits').innerHTML = state.outfits.length ? state.outfits.map(o => {const items=o.ids.map(id=>product(id)).filter(Boolean);return `<article class="outfit-card"><h2>${esc(o.title)}</h2>${outfitCollage(items)}${items.map(p=>itemRow(p,false)).join('')}<button class="secondary" data-remove-outfit="${o.id}">Удалить образ</button></article>`;}).join('') : '<p class="muted">Готовые образы тоже можно сохранить.</p>';
}
async function refreshMe() {
  const me = await api('me');
  Object.assign(state, {saved: me.saved, outfits: me.outfits, privateProducts: me.products, preferences: me.preferences, admin: me.is_admin, authenticated: true});
  $('#admin-button').hidden = !state.admin;
}
async function toggleSave(id) {
  if (!requireAuth()) return;
  const s = saved(id);
  await api('saved/'+id, {method: s ? 'DELETE' : 'PUT', ...(!s ? {body: JSON.stringify({folder:'Себе', owned:false})} : {})});
  await refreshMe(); updateSaveButtons(); if (state.tab === 'saved') renderSaved();
  toast(s ? 'Удалено из сохранённого' : 'Сохранено в «Мои находки»');
  try { tg?.HapticFeedback?.notificationOccurred('success'); } catch (_) { /* older Telegram */ }
}
function openDetail(id) {
  const p = product(id); if (!p) return;
  const s = saved(id);
  const checked = p.checked_at ? new Date(p.checked_at*1000).toLocaleString('ru-RU') : 'ещё не проверялась';
  $('#product-detail').innerHTML = `${image(p,'detail-image')}<h2>${esc(p.title)}</h2><div class="price">${money(p.price)}</div><p class="fineprint">Цена проверена: ${esc(checked)}. Цена, наличие и размеры могут измениться.</p><button class="secondary" data-save-detail="${id}">${s ? '♥ Убрать из сохранённого' : '♡ Сохранить находку'}</button>${s ? `<div class="detail-controls"><label>Папка<select id="detail-folder">${[...new Set(['Себе','Дом','Подарки',s.folder])].map(f=>`<option ${s.folder === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label><label><input id="detail-owned" type="checkbox" ${s.owned ? 'checked' : ''}>Уже есть</label><button class="text-button" data-update-saved="${id}">Применить</button></div>` : ''}${p.slot !== 'other' ? `<button class="primary" data-build="${id}">Собрать образ ↗</button>` : ''}<a class="secondary" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Посмотреть на Wildberries ↗</a>`;
  if (!$('#product-dialog').open) $('#product-dialog').showModal();
}
function renderAnchor() {
  const p = product(state.anchor);
  $('#build-form').hidden = !p;
  $('#anchor').innerHTML = p ? `<div class="anchor-card">${image(p)}<div><p class="eyebrow">ВАША ОТПРАВНАЯ ТОЧКА</p><h2>${esc(p.title)}</h2><p>${money(p.price)} ${saved(p.id)?.owned ? '· Уже есть' : ''}</p><button class="text-button" data-tab="finds">Выбрать другую вещь</button></div></div>` : '<div class="empty">Начните с любой вещи в находках.<br><button class="text-button" data-tab="finds">Выбрать вещь ↗</button></div>';
}
function startBuild(id) {
  state.anchor = id; state.exclude = []; state.suggestions = [];
  $('#outfits').innerHTML = '';
  $('#budget').value = state.preferences.budget || 5000;
  $('#occasion').value = state.preferences.occasion || 'everyday';
  $('#product-dialog').close(); showTab('builder');
}
function itemRow(p, canReplace = true) {
  const owned = saved(p.id)?.owned;
  return `<div class="outfit-item">${image(p)}<div><p>${esc(p.title)}</p><strong>${owned ? 'Уже есть · 0 ₽' : money(p.price)}</strong><div class="outfit-actions">${canReplace && p.id !== state.anchor ? `<button data-replace="${p.id}">Заменить</button>` : ''}<button data-detail="${p.id}">Подробнее</button><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">На WB ↗</a></div></div></div>`;
}
function outfitCollage(items){return `<div class="outfit-collage">${items.map(p=>`<button class="collage-piece piece-${['top','bottom','dress','shoes','bag','jewelry','hat','belt'].includes(p.slot)?p.slot:'other'}" data-detail="${p.id}" aria-label="Посмотреть ${esc(p.title)}">${image(p)}<span>${esc(state.slots[p.slot]||'Деталь')}</span></button>`).join('')}</div><p class="collage-caption">Коллаж вещей, не примерка · нажмите на вещь</p>`;}
async function suggest() {
  if (!requireAuth()) return false;
  const button = $('#build-button'); button.disabled = true; button.textContent = 'Собираем сочетания…';
  try {
    const result = await api('outfits', {method:'POST',body:JSON.stringify({anchor:state.anchor,budget:Number($('#budget').value),occasion:$('#occasion').value,exclude:state.exclude})});
    state.suggestions = result.outfits;
    for(const outfit of result.outfits)for(const p of outfit.items){if(!product(p.id)){state.privateProducts=state.privateProducts||[];state.privateProducts.push(p);}}
    $('#outfits').innerHTML = result.outfits.length ? result.outfits.map((o,i)=>`<article class="outfit-card"><p class="eyebrow">СОЧЕТАНИЕ 0${i+1}</p><h2>${esc(o.label || $('#occasion').selectedOptions[0].textContent)}</h2>${outfitCollage(o.items)}${Array.isArray(o.notes)?`<p class="fineprint">${o.notes.map(esc).join(' · ')}</p>`:''}${o.items.map(p=>itemRow(p)).join('')}<div class="outfit-total"><span>Новые вещи</span><span>${money(o.total)}</span></div><button class="primary" data-save-outfit="${i}">Сохранить образ</button></article>`).join('') : `<p class="empty">${esc(result.message)}${state.exclude.length ? '<br><button class="text-button" id="reset-replacements">Вернуть исключённые вещи</button>' : ''}</p>`;
    if(result.outfits.length)$('#outfits').insertAdjacentHTML('beforeend',`<p class="fineprint outfit-disclaimer">${esc(result.disclaimer||'Подбор по описаниям вещей, не консультация стилиста. Оттенки, посадку и размеры проверьте на WB.')}</p>`);
    return true;
  } finally {button.disabled=false; button.textContent='Подобрать образы ↗';}
}
function renderProfile() { $('#pref-budget').value = state.preferences.budget || 5000; $('#pref-occasion').value = state.preferences.occasion || 'everyday'; }
async function loadAdmin() {
  const [data,schedule] = await Promise.all([api('admin/products'),api('admin/schedule')]);
  state.schedule=schedule; renderSchedule();
  $('#admin-products').innerHTML = data.products.map(p=>`<div class="admin-row"><strong>${esc(p.title)} · ${money(p.price)}</strong><select aria-label="Тип вещи" id="slot-${p.id}">${Object.entries(state.slots).map(([k,v])=>`<option value="${k}" ${p.slot === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><select aria-label="Аудитория" id="audience-${p.id}">${[['women','Женская'],['men','Мужская'],['unknown','Не определена']].map(([k,v])=>`<option value="${k}" ${p.audience === k ? 'selected' : ''}>${v}</option>`).join('')}</select><label><input type="checkbox" id="enabled-${p.id}" ${p.enabled !== false ? 'checked' : ''}>Показывать</label><button class="secondary" data-admin-save="${p.id}">Сохранить</button></div>`).join('');
}
const weekNames=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
function scheduleDate(ts) {if(!ts)return 'Ожидаем первый запуск';try{return new Intl.DateTimeFormat('ru-RU',{timeZone:state.schedule.schedule.timezone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(ts*1000));}catch(_){return 'Время пока недоступно';}}
function renderScheduleStatusBase(){
  const data=state.schedule,s=data.schedule,r=data.status||{};
  const running=r.heartbeat_stale?'Нет свежего сигнала от автопостинга':s.paused?'Публикации на паузе':!s.enabled?'Автопубликации выключены':r.post_running?'Публикуем находку':'Автопостинг включён';
  $('#schedule-dashboard').innerHTML=`<div class="schedule-status profile-card"><div class="schedule-status-title"><span class="pill">${esc(running)}</span><button type="button" class="text-button" data-schedule-refresh="1">Обновить ↻</button></div><dl class="schedule-metrics"><div><dt>Последний пост</dt><dd>${esc(scheduleDate(r.last_post))}</dd></div><div><dt>Следующий пост</dt><dd>${s.paused||!s.enabled?'Не запланирован':esc(scheduleDate(r.next_post))}</dd></div><div><dt>Товаров в очереди</dt><dd>${r.queue_size??'—'}</dd></div><div><dt>Новых сегодня</dt><dd>${r.new_today??'—'}</dd></div><div><dt>Последний поиск</dt><dd>${esc(scheduleDate(r.last_scan_attempt))}</dd></div><div><dt>Следующий поиск</dt><dd>${s.search_enabled?esc(scheduleDate(r.next_search)):'Выключен'}</dd></div></dl>${r.last_scan_error||r.error?`<p class="notice">${esc(r.last_scan_error||r.error)}</p>`:''}<p class="fineprint">Время: ${esc(s.timezone)}${r.heartbeat?' · Сигнал '+esc(scheduleDate(r.heartbeat)):''}. Изменения применятся при следующем запуске.</p>${r.next_posts?.length&&!s.paused&&s.enabled?`<div class="schedule-upcoming"><strong>Ближайшие публикации</strong><ol>${r.next_posts.slice(0,5).map(ts=>`<li>${esc(scheduleDate(ts))}</li>`).join('')}</ol></div>`:''}<div class="schedule-actions"><button type="button" class="secondary" data-schedule-action="${s.paused?'resume':'pause'}">${s.paused?'Возобновить':'Пауза'}</button><button type="button" class="secondary" data-schedule-action="post_now">Опубликовать сейчас</button><button type="button" class="secondary" data-schedule-action="search_now">Искать сейчас</button></div><p class="fineprint">Разовые команды выполняются ближайшим автоматическим запуском. Защита от дублей и лимиты действуют всегда.</p></div>`;
}
function renderScheduleStatus(){
  renderScheduleStatusBase();
  const s=state.schedule.schedule,r=state.schedule.status||{};
  $('#schedule-dashboard .schedule-metrics').insertAdjacentHTML('beforeend',`<div><dt>Постов сегодня</dt><dd>${Number.isFinite(r.posted_today)?r.posted_today:'—'}</dd></div><div><dt>Успешный поиск</dt><dd>${esc(scheduleDate(r.last_scan_success))}</dd></div><div><dt>Состояние поиска</dt><dd>${s.search_enabled?(r.scan_running?'Идёт поиск':'Ожидает запуска'):'Выключен'}</dd></div>`);
  const stopped=s.enabled&&!s.paused&&(r.heartbeat_stale||r.watchdog_overdue),reason=r.heartbeat_stale?'Нет свежего сигнала планировщика':r.watchdog_overdue?'Пост просрочен при непустой очереди':r.last_error||r.error||'';
  $('#schedule-dashboard').insertAdjacentHTML('beforeend',`<div class="profile-card"><h2>${stopped?'🔴 Автопостинг не работает':s.enabled&&!s.paused?'🟢 Scheduler':'⚪ Scheduler'}</h2><dl class="schedule-metrics"><div><dt>Последний tick</dt><dd>${esc(scheduleDate(r.last_scheduler_tick||r.heartbeat))}</dd></div><div><dt>Cron</dt><dd>${r.cron_active?'ON':r.cron_configured?'Нет свежего tick':'OFF'}</dd></div><div><dt>Autopost</dt><dd>${s.enabled&&!s.paused?'ON':'OFF'}</dd></div><div><dt>Исполнитель</dt><dd>${r.driver==='cloudflare-native'?'Cloudflare Worker':r.driver==='cloudflare'?'Cloudflare → GitHub':'GitHub Actions'}</dd></div><div><dt>Последняя попытка</dt><dd>${esc(scheduleDate(r.last_post_attempt))}</dd></div><div><dt>Подтверждённый пост</dt><dd>${esc(scheduleDate(r.last_post_success||r.last_post))}</dd></div></dl>${reason?`<p class="notice">${esc(reason)}</p>`:''}<button type="button" class="secondary" data-schedule-check="1">Проверить автопостинг</button><p class="fineprint">Проверка базы, Telegram и карточки WB без отправки поста.</p><div id="schedule-check-result" role="status" aria-live="polite"></div></div>`);
}
function renderScheduleForm(){
  renderScheduleStatus();const s=state.schedule.schedule;
  const n=(key,label,min,max)=>`<label>${label}<input name="${key}" type="number" min="${min}" max="${max}" step="1" value="${s[key]}" required></label>`;
  const check=(key,label)=>`<label class="schedule-check"><input type="checkbox" name="${key}" ${s[key]?'checked':''}>${label}</label>`;
  $('#schedule-editor').innerHTML=`<form id="schedule-form" class="schedule-form profile-card"><h2>Расписание канала</h2>${check('enabled','Автопубликации включены')}<div class="schedule-grid"><label>Режим<select name="mode"><option value="interval" ${s.mode==='interval'?'selected':''}>Каждые N минут</option><option value="times" ${s.mode==='times'?'selected':''}>В определённое время</option></select></label><label>Часовой пояс<input name="timezone" value="${esc(s.timezone)}" maxlength="80" list="schedule-timezones" required><datalist id="schedule-timezones"><option value="Europe/Moscow"><option value="Europe/Kaliningrad"><option value="Asia/Yekaterinburg"><option value="Asia/Novosibirsk"><option value="Asia/Vladivostok"></datalist></label></div><fieldset id="schedule-interval" ${s.mode==='times'?'hidden':''}><legend>Интервал публикаций</legend><div class="choice-row">${[10,15,30,60].map(v=>`<button type="button" class="chip" data-schedule-interval="${v}">${v===60?'1 час':v+' мин'}</button>`).join('')}</div>${n('post_interval_minutes','Свой интервал, минут',5,10080)}</fieldset><fieldset id="schedule-fixed" ${s.mode!=='times'?'hidden':''}><legend>Точное время</legend><div id="schedule-times">${s.post_times.map(v=>scheduleTimeRow(v)).join('')}</div><button type="button" class="text-button" data-schedule-add-time="1">+ Добавить время</button></fieldset><fieldset><legend>Дни публикаций</legend><div class="schedule-weekdays">${weekNames.map((label,i)=>`<label><input type="checkbox" name="weekday" value="${i}" ${s.weekdays.includes(i)?'checked':''}><span>${label}</span></label>`).join('')}</div><div class="choice-row"><button type="button" class="text-button" data-schedule-days="all">Каждый день</button><button type="button" class="text-button" data-schedule-days="work">Будни</button><button type="button" class="text-button" data-schedule-days="weekend">Выходные</button></div></fieldset><fieldset><legend>Часы тишины</legend>${check('quiet_enabled','Не публиковать в это время')}<div class="schedule-grid"><label>С<input type="time" name="quiet_start" value="${esc(s.quiet_start)}" required></label><label>До<input type="time" name="quiet_end" value="${esc(s.quiet_end)}" required></label></div><p class="fineprint">Например 23:00–07:00. Поиск товаров продолжает работать.</p></fieldset><fieldset><legend>Пополнение каталога</legend>${check('search_enabled','Автоматически искать новые товары')}<div class="schedule-grid">${n('search_interval_minutes','Интервал поиска, минут',5,10080)}${n('min_queue','Целевой запас товаров',1,300)}</div></fieldset><fieldset><legend>Живой ритм</legend>${check('natural_interval_enabled','Небольшое случайное смещение интервала')}${n('jitter_minutes','Отклонение, ± минут',0,120)}<p class="fineprint">Работает в режиме интервала. Точное время публикаций не смещается.</p></fieldset><fieldset><legend>Защита от слишком частых постов</legend><div class="schedule-grid">${n('min_post_gap_minutes','Минимальный перерыв, минут',5,1440)}${n('max_posts_hour','Максимум постов за час',1,12)}${n('max_posts_day','Максимум постов за день',1,288)}</div></fieldset><button type="submit" class="primary">Сохранить расписание</button><p class="fineprint">Публикации по расписанию могут задерживаться из-за запуска GitHub Actions. Ближайшие времена обновляются после сигнала работающего бота.</p></form>`;
}
function scheduleTimeRow(value='12:00'){return `<div class="schedule-time-row"><input type="time" name="post_time" aria-label="Время публикации" value="${esc(value)}" required><button type="button" class="text-button" data-schedule-remove-time="1" aria-label="Удалить время">Удалить</button></div>`;}
function renderSchedule(){
  renderScheduleForm();
  $('#schedule-interval .choice-row').innerHTML=[5,10,15,20,30,45,60,120].map(v=>`<button type="button" class="chip" data-schedule-interval="${v}">${v<60?v+' мин':v/60+' ч'}</button>`).join('');
  const searchLabel=$('#schedule-form').elements.search_interval_minutes.closest('label');
  searchLabel.insertAdjacentHTML('beforebegin',`<div class="choice-row schedule-presets">${[5,10,20,30,60,120].map(v=>`<button type="button" class="chip" data-schedule-search-interval="${v}">${v<60?v+' мин':v/60+' ч'}</button>`).join('')}</div>`);
}
document.addEventListener('change',event=>{if(event.target.closest('#schedule-form')&&event.target.name==='mode'){const fixed=event.target.value==='times';$('#schedule-fixed').hidden=!fixed;$('#schedule-interval').hidden=fixed;if(fixed&&!$('#schedule-times').children.length)$('#schedule-times').innerHTML=scheduleTimeRow();}});
document.addEventListener('submit',async event=>{if(event.target.id!=='schedule-form')return;event.preventDefault();const form=event.target,button=form.querySelector('[type="submit"]');button.disabled=true;try{const draft={...state.schedule.schedule};for(const key of ['enabled','quiet_enabled','search_enabled','natural_interval_enabled'])draft[key]=form.elements[key].checked;for(const key of ['post_interval_minutes','search_interval_minutes','min_queue','jitter_minutes','min_post_gap_minutes','max_posts_hour','max_posts_day'])draft[key]=Number(form.elements[key].value);for(const key of ['mode','timezone','quiet_start','quiet_end'])draft[key]=form.elements[key].value.trim();draft.weekdays=[...form.querySelectorAll('[name="weekday"]:checked')].map(x=>Number(x.value));draft.post_times=[...form.querySelectorAll('[name="post_time"]')].map(x=>x.value);state.schedule=await api('admin/schedule',{method:'PUT',body:JSON.stringify({schedule:draft,revision:state.schedule.revision})});renderSchedule();toast('Расписание сохранено');}catch(e){toast(e.message);}finally{button.disabled=false;}});
document.addEventListener('click', async event => {
  const b = event.target.closest('button'); if (!b || b.disabled) return;
  try {
    if (b.classList.contains('close')) { b.closest('dialog').close(); return; }
    if (b.dataset.tab) { showTab(b.dataset.tab); return; }
    if (b.dataset.category) { state.category=b.dataset.category; state.visibleCount=48; renderCatalog(); return; }
    if (b.id === 'load-more') {automaticPages=0;appendFeed();return;}
    if (b.dataset.openDiscovery) {openDiscovery();return;}
    if (b.dataset.budgetPreset!==undefined) {$('#discovery-price').value=Number(b.dataset.budgetPreset)||'';return;}
    if (b.dataset.folder) { state.folder=b.dataset.folder; renderSaved(); return; }
    if (b.dataset.detail) { openDetail(Number(b.dataset.detail)); return; }
    if (b.dataset.build) { startBuild(Number(b.dataset.build)); return; }
    if (b.dataset.scheduleInterval) {$('#schedule-form').elements.post_interval_minutes.value=b.dataset.scheduleInterval;return;}
    if (b.dataset.scheduleSearchInterval) {$('#schedule-form').elements.search_interval_minutes.value=b.dataset.scheduleSearchInterval;return;}
    if (b.dataset.scheduleDays) {document.querySelectorAll('#schedule-form [name="weekday"]').forEach(x=>{x.checked=b.dataset.scheduleDays==='all'||(b.dataset.scheduleDays==='work'?Number(x.value)<5:Number(x.value)>=5);});return;}
    if (b.dataset.scheduleAddTime) {if($('#schedule-times').children.length<24)$('#schedule-times').insertAdjacentHTML('beforeend',scheduleTimeRow());else toast('Можно добавить до 24 времён');return;}
    if (b.dataset.scheduleRemoveTime) {b.closest('.schedule-time-row').remove();return;}
    if (b.dataset.scheduleRefresh) {b.disabled=true;state.schedule=await api('admin/schedule');renderScheduleStatus();return;}
    if (b.dataset.scheduleCheck) {b.disabled=true;$('#schedule-check-result').textContent='Проверяем без публикации…';const c=await api('admin/schedule/check');$('#schedule-check-result').innerHTML=`<p>${c.ok?'🟢 Цепочка готова':'🔴 Проверка выявила проблему'}</p><dl class="schedule-metrics">${[['Cron',c.cron&&!c.heartbeat_stale?'OK':'Не подтверждён'],['D1 / очередь',String(c.queue_size)+' товаров'],['Telegram',c.telegram_auth?'OK':c.telegram_configured?'Не отвечает':'Не настроен'],['Карточка WB',c.live_card&&c.image?'OK':'Не подтверждена'],['Часовой пояс',c.timezone],['Местное время',c.current_local_time],['Тихие часы',c.quiet_hours],['Можно публиковать',c.posting_allowed?'Да':'Нет'],['Создано постов',c.telegram_posts_created]].map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;return;}
    if (b.dataset.scheduleAction) {b.disabled=true;state.schedule=await api('admin/schedule/action',{method:'POST',body:JSON.stringify({action:b.dataset.scheduleAction})});renderScheduleStatus();toast(['post_now','search_now'].includes(b.dataset.scheduleAction)?'Команда поставлена в очередь':'Настройка применена');return;}
    b.disabled = true;
    if (b.dataset.save) await toggleSave(Number(b.dataset.save));
    if (b.dataset.saveDetail) { await toggleSave(Number(b.dataset.saveDetail)); openDetail(Number(b.dataset.saveDetail)); }
    if (b.dataset.updateSaved && requireAuth()) {
      await api('saved/'+b.dataset.updateSaved,{method:'PUT',body:JSON.stringify({folder:$('#detail-folder').value,owned:$('#detail-owned').checked})});
      await refreshMe(); renderCatalog(); renderSaved(); renderAnchor(); state.suggestions=[]; $('#outfits').innerHTML=''; toast('Сохранено. Новый подбор учтёт эту вещь.');
    }
    if (b.dataset.replace) {const id=Number(b.dataset.replace); state.exclude.push(id); try {await suggest();} catch(e){state.exclude.pop();throw e;} }
    if (b.dataset.saveOutfit !== undefined && requireAuth()) {
      const outfit=state.suggestions[Number(b.dataset.saveOutfit)];
      await api('outfits/saved',{method:'POST',body:JSON.stringify({ids:outfit.items.map(p=>p.id),title:$('#occasion').selectedOptions[0].textContent})});
      await refreshMe(); toast('Образ сохранён');
    }
    if (b.dataset.removeOutfit) { await api('outfits/saved/'+b.dataset.removeOutfit,{method:'DELETE'}); await refreshMe(); renderSaved(); }
    if (b.dataset.adminSave) {
      const id=b.dataset.adminSave;
      await api('admin/products/'+id,{method:'PUT',body:JSON.stringify({slot:$('#slot-'+id).value,audience:$('#audience-'+id).value,enabled:$('#enabled-'+id).checked})});
      const catalog=await api('catalog'); state.products=catalog.products; renderCatalog(); toast('Каталог обновлён');
    }
    if (b.id === 'reset-replacements') {state.exclude=[];await suggest();}
  } catch(error) {toast(error.message);} finally {b.disabled=false;}
});
$('#search').addEventListener('input',()=>{state.visibleCount=48;renderCatalog();}); $('#sort').addEventListener('change',()=>{state.visibleCount=48;renderCatalog();});
$('.brand').onclick = event => {event.preventDefault();showTab('finds');};
$('#profile-button').onclick = () => showTab('profile');
$('#how-button').onclick = () => $('#info-dialog').showModal();
$('#admin-button').onclick = () => showTab('admin');
$('#edit-discovery').onclick=openDiscovery;
$('#discovery-dialog').addEventListener('close',()=>{if(!discoverySeen)rememberDiscovery();});
$('#skip-discovery').onclick=()=>{discovery={...discoveryDefaults};rememberDiscovery();$('#discovery-dialog').close();state.category='all';renderCatalog();};
$('#discovery-form').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;discovery={audience:form.elements.audience.value,interest:form.elements.interest.value,maxPrice:Number($('#discovery-price').value)||0};rememberDiscovery();$('#discovery-dialog').close();state.category='all';renderCatalog();};
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&state.tab==='finds'&&feedOffset<feed.length&&automaticPages<4){automaticPages++;appendFeed();}},{rootMargin:'450px'});observer.observe($('#feed-end'));}
$('#build-form').onsubmit = async event => {event.preventDefault();try{await suggest();}catch(e){toast(e.message);}};
$('#preferences-form').onsubmit = async event => {
  event.preventDefault(); if(!requireAuth()) return;
  try {await api('preferences',{method:'PUT',body:JSON.stringify({budget:Number($('#pref-budget').value),occasion:$('#pref-occasion').value})});await refreshMe();toast('Настройки сохранены');}catch(e){toast(e.message);}
};
$('#delete-account').onclick = async () => {
  if (!requireAuth() || !window.confirm('Удалить все ваши сохранённые вещи, образы и настройки? Это действие нельзя отменить.')) return;
  try {await api('me',{method:'DELETE'});await refreshMe();renderProfile();renderCatalog();state.suggestions=[];$('#outfits').innerHTML='';toast('Ваши данные удалены');}catch(e){toast(e.message);}
};
async function init() {
  try {tg?.ready();tg?.expand();}catch(_){/* standalone browser */}
  try {
    const catalog=await api('catalog'); state.products=catalog.products; state.slots=catalog.slots;renderCatalog();
    if (!catalog.synced_at || Date.now()/1000-catalog.synced_at>7200) {$('#catalog-notice').hidden=false;$('#catalog-notice').textContent=catalog.synced_at?'Каталог давно не обновлялся. Проверьте цену на WB перед покупкой.':'Каталог наполняется. Первые находки появятся после подключения бота.';}
    if(tg?.initData) {try{await refreshMe();renderCatalog();}catch(e){toast(e.message);}}
    const start=tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('tgWebAppStartParam') || '';
    const match=/^(save|look)_(\d+)$/.exec(start);
    if(match) {
      const id=Number(match[2]);
      if(product(id)) {
        if(match[1]==='look') startBuild(id);
        else {
          if(state.authenticated && !saved(id)) await toggleSave(id);
          openDetail(id);
        }
      } else toast('Товар ещё не появился в каталоге. Зайдите немного позже.');
    } else if(!discoverySeen) openDiscovery();
  } catch(e) {$('#products').innerHTML='<p class="empty">Не удалось загрузить находки. Проверьте соединение и откройте приложение заново.</p>';toast(e.message);}
}
init();
