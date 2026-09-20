// Dependency-free catalogue and bounded outfit logic shared by Worker and tests.
export const SLOTS = {dress:'Платье',top:'Верх',bottom:'Низ',shoes:'Обувь',bag:'Сумка',jewelry:'Украшения',belt:'Ремень',hat:'Головной убор',outer:'Верхняя одежда',other:'Другое'};
export const OCCASIONS = {everyday:'На каждый день',office:'В офис',evening:'На вечер'};
const MARKERS = {belt:['ремень','ремни','пояс'],dress:['плать','сарафан'],outer:['куртк','пальто','пуховик','тренч','плащ'],bottom:['юбк','джинс','брюк','шорт','леггин'],shoes:['кроссов','кед','туфл','ботин','сапог','лофер','босонож','балетк'],bag:['сумк','рюкзак','клатч'],jewelry:['серьг','украшен','кольц','брасл','ожерел','кулон','колье','чокер','цепоч','брошь','подвеск'],hat:['кепк','шапк','шляп','панам','бейсбол'],top:['футбол','блуз','рубаш','топ','свитер','кардиган','джемпер','худи','кофт','жакет','свитшот']};
export const integer = x => Number.isSafeInteger(x) && x > 0;
// Conservative text signals, not image recognition or a promise of fit.
const UNSUITABLE = /детск|девоч|мальчик|малыш|кукл|игруш|постель|подуш|штор|ковр|коврик|чехол|для мебели|для дома|домашн|пижам|ночнуш|бель[её]|бюстгальтер|трус|купаль|плавк|карнавал|косплей|костюмирован|униформ|спецодеж|медицин/;
export function style(p) {
  const text=(p.title+' '+(p.category||'')).toLowerCase();
  const colors=[['neutral',/черн|чёрн|бел[аыо]|беж|сер[аыо]|молоч|кремов|коричнев|темно-син|тёмно-син/],['red',/красн|бордов/],['pink',/розов/],['blue',/голуб|син[ияе]/],['green',/зел[её]н|изумруд/],['yellow',/ж[её]лт|оранж/],['purple',/фиолет|сирен/]];
  return {eligible:!UNSUITABLE.test(text),sport:/спортив|бегов|фитнес|трениров|леггин|худи|свитшот/.test(text),sneakers:/кроссов|кеды/.test(text),formal:/вечерн|коктейл|торжеств|атлас|пайет|смокинг/.test(text),summer:/летн|босонож|сандал|шорт|сарафан/.test(text),winter:/зимн|утеплен|утеплён|пухов|мехов/.test(text),color:colors.filter(([,re])=>re.test(text)).map(([c])=>c).filter(c=>c!=='neutral')};
}
function compatible(items,p,signals,occasion) {
  const b=signals.get(p.id);
  if((occasion==='office'||occasion==='evening')&&b.sport) return false;
  if(occasion==='evening'&&b.sneakers) return false;
  const accents=new Set(b.color);
  for(const a of items) {
    const s=signals.get(a.id);
    if(a.audience!=='unknown'&&p.audience!=='unknown'&&a.audience!==p.audience) return false;
    if((s.formal&&(b.sport||b.sneakers))||((s.sport||s.sneakers)&&b.formal)||(s.winter&&b.summer)||(s.summer&&b.winter)) return false;
    for(const c of s.color) accents.add(c);
  }
  return accents.size<=1;
}
export function safeImage(value) {
  if (typeof value !== 'string' || value.length > 1000) return '';
  try {const u=new URL(value);return u.protocol==='https:' && /^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname) && !u.username && !u.password && !u.port ? u.href : '';} catch {return '';}
}
export function normalize(raw) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) throw new Error('Некорректный товар');
  const id=Number(raw.id || raw.pid), price=Number(raw.price || raw.product);
  const title=String(raw.title || '').trim().slice(0,200), category=String(raw.category || raw.cat || raw.query || '').slice(0,100);
  if(!integer(id) || id>=1e12 || !Number.isFinite(price) || price<=0 || price>1e7 || !title) throw new Error('Некорректный товар');
  const detect=text=>Object.entries(MARKERS).find(([,markers])=>markers.some(m=>text.toLowerCase().includes(m)))?.[0];
  const text=(title+' '+category).toLowerCase(), rating=Number(raw.rating || 0), checked=Number(raw.checked_at || raw.ts || raw.queued_ts || 0);
  if (!Number.isSafeInteger(checked) || checked<0) throw new Error('Некорректная дата проверки');
  return {id,title,price:Math.round(price*100)/100,category,image:safeImage(raw.image),slot:UNSUITABLE.test(text)?'other':detect(category)||detect(title)||'other',audience:text.includes('мужск')&&!text.includes('женск')?'men':text.includes('женск')?'women':'unknown',rating:Number.isFinite(rating)?Math.min(5,Math.max(0,rating)):0,checked_at:checked,url:`https://www.wildberries.ru/catalog/${id}/detail.aspx`};
}
function balanced(rows,quality,cheap,key,best=8,affordable=4) {
  const seen=new Set();
  return [...rows.toSorted(quality).slice(0,best),...rows.toSorted(cheap).slice(0,affordable)].filter(row=>{
    const id=key(row);if(seen.has(id))return false;seen.add(id);return true;
  });
}
export function build(products,anchorId,budget,occasion='everyday',ownedIds=[],excludedIds=[],now=Date.now()/1000) {
  if (!Object.hasOwn(OCCASIONS,occasion)) throw new Error('Неизвестный повод');
  const owned=new Set(ownedIds), excluded=new Set(excludedIds);
  const signals=new Map();
  const fresh=products.filter(p=>{
    if(p.enabled===false||excluded.has(p.id)||now-p.checked_at<0||now-p.checked_at>172800||!safeImage(p.image)) return false;
    const s=style(p);signals.set(p.id,s);return s.eligible;
  });
  const anchor=fresh.find(p=>p.id===anchorId);
  if(!anchor) throw new Error('Для подбора нужна вещь с фото и ценой, проверенной за последние 48 часов');
  if(anchor.slot==='other') throw new Error('Выберите одежду, обувь или аксессуар для образа');
  const cost=p=>owned.has(p.id)?0:Math.round(p.price*100), ceiling=budget*100;
  if(cost(anchor)>ceiling) return [];
  if(!compatible([],anchor,signals,occasion)) return [];
  const words={office:['рубаш','блуз','лофер','жакет','брюк'],evening:['плать','серьг','клатч','туфл'],everyday:['джинс','футбол','кроссов','кед']}[occasion];
  const scores=new Map(fresh.map(p=>[p.id,p.rating+2*words.filter(w=>p.title.toLowerCase().includes(w)).length]));
  const score=p=>scores.get(p.id), bySlot=Object.fromEntries(Object.keys(SLOTS).map(s=>[s,[]]));
  for(const p of fresh) if(p.id!==anchorId&&cost(anchor)+cost(p)<=ceiling&&compatible([anchor],p,signals,occasion)) bySlot[p.slot]?.push(p);
  for(const slot of Object.keys(bySlot)) bySlot[slot]=balanced(bySlot[slot],(a,b)=>score(b)-score(a)||cost(a)-cost(b)||a.id-b.id,(a,b)=>cost(a)-cost(b)||score(b)-score(a)||a.id-b.id,p=>p.id);
  let candidates=[];
  for(const pattern of [['dress','shoes'],['top','bottom','shoes']]) {
    if(['dress','top','bottom'].includes(anchor.slot)&&!pattern.includes(anchor.slot)) continue;
    let beam=[{items:[anchor],total:cost(anchor),score:score(anchor)}];
    for(const slot of pattern.filter(s=>s!==anchor.slot)) {
      const next=[];
      for(const b of beam) for(const p of bySlot[slot]) if(b.total+cost(p)<=ceiling&&compatible(b.items,p,signals,occasion)) next.push({items:[...b.items,p],total:b.total+cost(p),score:b.score+score(p)});
      beam=balanced(next,(a,b)=>b.score-a.score||a.total-b.total,(a,b)=>a.total-b.total||b.score-a.score,b=>b.items.map(p=>p.id).join(','),24,8);
    }
    candidates.push(...beam);
  }
  const quality=(a,b)=>b.score/b.items.length-a.score/a.items.length||a.total-b.total;
  const core=b=>b.items.filter(p=>p.id!==anchorId&&['dress','top','bottom','shoes'].includes(p.slot)).map(p=>p.id).sort((a,b)=>a-b);
  const selected=[],result=[];
  while(candidates.length&&result.length<3) {
    const index=result.length;
    const distance=b=>{
      const ids=new Set(core(b));
      return Math.min(...selected.map(s=>{
        const union=new Set([...ids,...s]);let shared=0;for(const id of ids)if(s.includes(id))shared++;
        return (union.size-shared)/Math.max(1,union.size);
      }));
    };
    candidates.sort(index===0?quality:index===1?(a,b)=>a.total-b.total||quality(a,b):(a,b)=>distance(b)-distance(a)||quality(a,b));
    let b=candidates[0];selected.push(core(b));
    const signature=core(b).join(',');candidates=candidates.filter(c=>core(c).join(',')!==signature);
    // Keep the budget choice free of optional extras.
    if(index!==1)for(const slot of ['bag','jewelry']) {
      if(b.items.some(p=>p.slot===slot))continue;
      const extra=bySlot[slot].find(p=>b.total+cost(p)<=ceiling&&compatible(b.items,p,signals,occasion));
      if(extra)b={items:[...b.items,extra],total:b.total+cost(extra),score:b.score+score(extra)};
    }
    const label=index===0?'Основной образ':index===1&&b.total<Math.round(result[0].total*100)?'Экономнее':'Другой вариант';
    const notes=['Полный комплект в пределах бюджета; цены проверены за последние 48 часов.','Явные конфликты стиля, сезона и цветов отсеяны по описаниям.'];
    if(index===1)notes.push('Без дополнительных аксессуаров: только основа образа и выбранная вещь.');
    if(b.items.some(p=>owned.has(p.id)))notes.push('Вещи с отметкой «Уже есть» не входят в сумму новых покупок.');
    result.push({items:b.items,total:b.total/100,occasion,label,owned:b.items.filter(p=>owned.has(p.id)).map(p=>p.id),notes,disclaimer:'Коллаж реальных товаров, не виртуальная примерка. Оттенки, посадку и размеры проверьте в карточках.'});
  }
  return result;
}
