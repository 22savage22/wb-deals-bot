// Deterministic metadata rules. No model calls or inferred visual attributes.
export const GROUPS=['clothes','shoes','accessories','other'];
export const fold=s=>String(s||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').trim();
export function productGroup(p){const s=fold([p.category,p.title].join(' '));return /кроссов|кед[ыа ]|ботин|сапог|туфл|босонож|сандал|обув/.test(s)?'shoes':/сумк|рюкзак|кошелек|ремень|ремни|серьг|браслет|кепк|шапк|украшен|очк|кольцо|кольца/.test(s)?'accessories':/футбол|худи|джинс|плать|юбк|блуз|куртк|пальто|свитер|джемпер|брюк|шорт|рубаш|толстов|одежд/.test(s)?'clothes':'other';}
export function audience(p){const s=fold([p.title,p.category].join(' '));return /детск|девоч|мальчик/.test(s)?'children':/унисекс/.test(s)?'unisex':/женск/.test(s)?'women':/мужск/.test(s)?'men':'unknown';}
export function selectionSettings(p){return {min_price:0,max_price:Number(p.max_price||0),min_rating:Number(p.min_rating??4.3),min_feedbacks:Number(p.min_feedbacks??20),included_categories:[],excluded_categories:[],allowed_brands:[],excluded_brands:[],blocked_words:p.blocked_words||[],blacklist:p.blacklist||[],audiences:[],include_unknown_audience:true,diversity_enabled:false,weights:{clothes:25,shoes:25,accessories:25,other:25},max_consecutive:2,similar_window:0,...p.selection};}
export function validateSelection(v){
  if(!v||typeof v!=='object')throw Error('Заполните настройки подбора');const r={};
  for(const [k,max] of Object.entries({min_price:10000000,max_price:10000000,min_rating:5,min_feedbacks:10000000,max_consecutive:20,similar_window:50})){if(typeof v[k]!=='number'||!Number.isFinite(v[k])||v[k]<0||v[k]>max||(k!=='min_rating'&&!Number.isInteger(v[k]))||k==='max_consecutive'&&v[k]<1)throw Error('Проверьте числовые ограничения');r[k]=v[k];}
  if(r.max_price&&r.min_price>r.max_price)throw Error('Минимальная цена выше максимальной');
  for(const k of ['included_categories','excluded_categories','allowed_brands','excluded_brands','blocked_words','blacklist','audiences']){if(!Array.isArray(v[k])||v[k].length>200||v[k].some(s=>typeof s!=='string'||!s.trim()||s.length>100||/[\u0000-\u001f]/.test(s)))throw Error('Списки: до 200 значений, каждое до 100 символов');r[k]=[...new Set(v[k].map(fold))];}
  if(r.audiences.some(a=>!['women','men','children','unisex'].includes(a)))throw Error('Неизвестная аудитория');
  for(const k of ['include_unknown_audience','diversity_enabled']){if(typeof v[k]!=='boolean')throw Error('Проверьте переключатели');r[k]=v[k];}
  r.weights={};for(const k of GROUPS){if(!Number.isInteger(v.weights?.[k])||v.weights[k]<0||v.weights[k]>100)throw Error('Доли категорий: от 0 до 100%');r.weights[k]=v.weights[k];}if(Object.values(r.weights).reduce((a,b)=>a+b,0)!==100)throw Error('Сумма долей должна быть 100%');return r;
}
export function selectionReason(p,policy){
  if(!policy.selection)return null;const s=selectionSettings(policy),text=fold(p.title+' '+p.category),cat=fold(p.category),brand=fold(p.brand),price=Number(p.product||p.price||0),a=audience(p);
  if(price<s.min_price||s.max_price&&price>s.max_price)return 'Цена вне диапазона';
  if(Number(p.rating||0)<s.min_rating||Number(p.feedbacks||0)<s.min_feedbacks)return 'Недостаточно рейтинга или отзывов';
  if(s.included_categories.length&&!s.included_categories.some(x=>cat===x))return 'Категория не включена';
  if(s.excluded_categories.includes(cat))return 'Категория исключена';
  if(s.allowed_brands.length&&!s.allowed_brands.includes(brand)||s.excluded_brands.includes(brand))return 'Ограничение бренда';
  if(s.blacklist.some(x=>x===String(p.id)||brand.includes(x))||s.blocked_words.some(x=>text.includes(x)))return 'Слово или артикул исключён';
  if(s.audiences.length&&(a==='unknown'?!s.include_unknown_audience:!s.audiences.includes(a)))return 'Аудитория не подходит';return null;
}
const words=p=>new Set(fold(p.title).split(/[^\p{L}\p{N}]+/u).filter(x=>x.length>2));
export function similarity(a,b){
  const type=p=>fold(p.category),pack=p=>fold(p.title).match(/\b(\d+)\s*(?:шт|pcs)/)?.[1],dimensions=p=>fold(p.title).match(/\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?(?:\s*[xх×]\s*\d+(?:[.,]\d+)?)?/u)?.[0]?.replace(/\s/g,'').replace(/[х×]/g,'x');
  if(type(a)!==type(b)||pack(a)&&pack(b)&&pack(a)!==pack(b)||dimensions(a)&&dimensions(b)&&dimensions(a)!==dimensions(b))return {score:0,reasons:[]};
  const aw=words(a),bw=words(b),common=[...aw].filter(x=>bw.has(x)),union=new Set([...aw,...bw]);
  let score=union.size?common.length/union.size:0;const reasons=['Одинаковая категория WB'];if(common.length)reasons.push('Совпадают слова: '+common.slice(0,5).join(', '));if(a.brand&&fold(a.brand)===fold(b.brand)){score=Math.min(1,score+.1);reasons.push('Одинаковый бренд');}return {score:Math.round(score*100)/100,reasons};
}
export function diverseChoice(rows,recent,policy){
  const s=selectionSettings(policy);if(!policy.selection||!s.diversity_enabled)return undefined;if(!rows.length)return null;
  const history=recent.map(r=>{try{return {...JSON.parse(r.data||'{}'),category:JSON.parse(r.data||'{}').category||r.topic};}catch{return {category:r.topic};}}),counts=Object.fromEntries(GROUPS.map(k=>[k,0]));for(const p of history)counts[productGroup(p)]++;
  let pool=rows;const latest=history.slice(-s.max_consecutive).map(productGroup);
  if(latest.length===s.max_consecutive&&new Set(latest).size===1){const alternate=pool.filter(r=>productGroup(JSON.parse(r.data))!==latest[0]);if(alternate.length)pool=alternate;}
  if(s.similar_window){const distinct=pool.filter(r=>!history.slice(-s.similar_window).some(h=>similarity(h,JSON.parse(r.data)).score>=.8));if(distinct.length)pool=distinct;}
  const present=[...new Set(pool.map(r=>productGroup(JSON.parse(r.data))))],sum=present.reduce((n,k)=>n+s.weights[k],0);
  const deficit=k=>(sum?s.weights[k]/sum:1/present.length)*(history.length+1)-counts[k];
  return [...pool].sort((a,b)=>deficit(productGroup(JSON.parse(b.data)))-deficit(productGroup(JSON.parse(a.data)))||Number(b.checked_at>0)-Number(a.checked_at>0)||a.queued_at-b.queued_at||a.pid-b.pid)[0];
}
