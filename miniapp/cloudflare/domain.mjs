// Dependency-free catalogue and bounded outfit logic shared by Worker and tests.
export const SLOTS = {dress:'Платье',top:'Верх',bottom:'Низ',shoes:'Обувь',bag:'Сумка',jewelry:'Украшения',belt:'Ремень',hat:'Головной убор',outer:'Верхняя одежда',other:'Другое'};
export const OCCASIONS = {everyday:'На каждый день',office:'В офис',evening:'На вечер'};
const MARKERS = {belt:['ремень','ремни','пояс'],dress:['плать','сарафан'],outer:['куртк','пальто','пуховик','тренч','плащ'],bottom:['юбк','джинс','брюк','шорт','леггин'],shoes:['кроссов','кед','туфл','ботин','сапог','лофер','босонож','балетк'],bag:['сумк','рюкзак','клатч'],jewelry:['серьг','украшен','кольц','брасл','ожерел','кулон','колье','чокер','цепоч','брошь','подвеск'],hat:['кепк','шапк','шляп','панам','бейсбол'],top:['футбол','блуз','рубаш','топ','свитер','кардиган','джемпер','худи','кофт','жакет','свитшот']};
export const integer = x => Number.isSafeInteger(x) && x > 0;
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
  return {id,title,price:Math.round(price*100)/100,category,image:safeImage(raw.image),slot:detect(category)||detect(title)||'other',audience:text.includes('мужск')&&!text.includes('женск')?'men':text.includes('женск')?'women':'unknown',rating:Number.isFinite(rating)?Math.min(5,Math.max(0,rating)):0,checked_at:checked,url:`https://www.wildberries.ru/catalog/${id}/detail.aspx`};
}
export function build(products,anchorId,budget,occasion='everyday',ownedIds=[],excludedIds=[],now=Date.now()/1000) {
  if (!Object.hasOwn(OCCASIONS,occasion)) throw new Error('Неизвестный повод');
  const owned=new Set(ownedIds), excluded=new Set(excludedIds);
  const fresh=products.filter(p=>p.enabled!==false&&!excluded.has(p.id)&&now-p.checked_at>=0&&now-p.checked_at<=172800);
  const anchor=fresh.find(p=>p.id===anchorId);
  if(!anchor) throw new Error('Цена этой вещи устарела или товар недоступен для подбора');
  if(anchor.slot==='other') throw new Error('Выберите одежду, обувь или аксессуар для образа');
  const cost=p=>owned.has(p.id)?0:Math.round(p.price*100), ceiling=budget*100;
  if(cost(anchor)>ceiling) return [];
  const words={office:['рубаш','блуз','лофер','жакет','брюк'],evening:['плать','серьг','клатч','туфл'],everyday:['джинс','футбол','кроссов','кед']}[occasion];
  const scores=new Map(fresh.map(p=>[p.id,p.rating+2*words.filter(w=>p.title.toLowerCase().includes(w)).length]));
  const score=p=>scores.get(p.id), bySlot=Object.fromEntries(Object.keys(SLOTS).map(s=>[s,[]]));
  for(const p of fresh) if(p.id!==anchorId&&(anchor.audience==='unknown'||p.audience===anchor.audience||p.audience==='unknown')) bySlot[p.slot]?.push(p);
  for(const slot of Object.keys(bySlot)) bySlot[slot]=bySlot[slot].sort((a,b)=>score(b)-score(a)||cost(a)-cost(b)||a.id-b.id).slice(0,12);
  const candidates=[];
  for(const pattern of [['dress','shoes'],['top','bottom','shoes']]) {
    if(['dress','top','bottom'].includes(anchor.slot)&&!pattern.includes(anchor.slot)) continue;
    let beam=[{items:[anchor],total:cost(anchor),score:score(anchor)}];
    for(const slot of pattern.filter(s=>s!==anchor.slot)) {
      const next=[];
      for(const b of beam) for(const p of bySlot[slot]) if(b.total+cost(p)<=ceiling) next.push({items:[...b.items,p],total:b.total+cost(p),score:b.score+score(p)});
      beam=next.sort((a,b)=>b.score-a.score||a.total-b.total).slice(0,32);
    }
    for(let b of beam) {
      for(const slot of ['bag','jewelry']) {
        if(b.items.some(p=>p.slot===slot)) continue;
        const extra=bySlot[slot].find(p=>b.total+cost(p)<=ceiling);
        if(extra) b={items:[...b.items,extra],total:b.total+cost(extra),score:b.score+score(extra)};
      }
      candidates.push(b);
    }
  }
  candidates.sort((a,b)=>b.score/b.items.length-a.score/a.items.length||a.total-b.total);
  const signatures=new Set(), result=[];
  for(const b of candidates) {
    const signature=b.items.filter(p=>['dress','top','bottom','shoes'].includes(p.slot)).map(p=>p.id).sort((a,b)=>a-b).join(',');
    if(signatures.has(signature)) continue;
    signatures.add(signature);result.push({items:b.items,total:b.total/100,occasion,owned:b.items.filter(p=>owned.has(p.id)).map(p=>p.id)});
    if(result.length===3) break;
  }
  return result;
}
