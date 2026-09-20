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
    $('#outfits').innerHTML = result.outfits.length ? result.outfits.map((o,i)=>`<article class="outfit-card"><p class="eyebrow">СОЧЕТАНИЕ 0${i+1}</p><h2>${esc($('#occasion').selectedOptions[0].textContent)}</h2>${outfitCollage(o.items)}${Array.isArray(o.notes)?`<p class="fineprint">${o.notes.map(esc).join(' · ')}</p>`:''}${o.items.map(p=>itemRow(p)).join('')}<div class="outfit-total"><span>Новые вещи</span><span>${money(o.total)}</span></div><button class="primary" data-save-outfit="${i}">Сохранить образ</button></article>`).join('') : `<p class="empty">${esc(result.message)}${state.exclude.length ? '<br><button class="text-button" id="reset-replacements">Вернуть исключённые вещи</button>' : ''}</p>`;
    if(result.outfits.length)$('#outfits').insertAdjacentHTML('beforeend',`<p class="fineprint outfit-disclaimer">${esc(result.disclaimer||'Подбор по описаниям вещей, не консультация стилиста. Оттенки, посадку и размеры проверьте на WB.')}</p>`);
    return true;
  } finally {button.disabled=false; button.textContent='Подобрать образы ↗';}
}
function renderProfile() { $('#pref-budget').value = state.preferences.budget || 5000; $('#pref-occasion').value = state.preferences.occasion || 'everyday'; }
async function loadAdmin() {
  const data = await api('admin/products');
  $('#admin-products').innerHTML = data.products.map(p=>`<div class="admin-row"><strong>${esc(p.title)} · ${money(p.price)}</strong><select aria-label="Тип вещи" id="slot-${p.id}">${Object.entries(state.slots).map(([k,v])=>`<option value="${k}" ${p.slot === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select><select aria-label="Аудитория" id="audience-${p.id}">${[['women','Женская'],['men','Мужская'],['unknown','Не определена']].map(([k,v])=>`<option value="${k}" ${p.audience === k ? 'selected' : ''}>${v}</option>`).join('')}</select><label><input type="checkbox" id="enabled-${p.id}" ${p.enabled !== false ? 'checked' : ''}>Показывать</label><button class="secondary" data-admin-save="${p.id}">Сохранить</button></div>`).join('');
}
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
