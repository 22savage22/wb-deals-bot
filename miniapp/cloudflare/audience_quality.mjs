// Owner policy and bounded current-vote projection. No River/model/AI calls.
export const QUALITY_CATEGORIES={textbooks:'Учебники',study_aids:'Учебные пособия',notebooks:'Тетради',stationery:'Канцелярия',books:'Книги'};
export const VOTE_WINDOW=500;
export const TYPE_LABELS={tshirt:'Футболки',longsleeve:'Лонгсливы',hoodie:'Худи',jeans:'Джинсы',dress:'Платья',skirt:'Юбки',blouse:'Блузки и рубашки',outerwear:'Верхняя одежда',knitwear:'Трикотаж',trousers:'Брюки и шорты',shoes:'Обувь',bag:'Сумки',accessory:'Аксессуары',...QUALITY_CATEGORIES};
const fold=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').trim();
const word=s=>new RegExp('(?:^|[^\\p{L}])(?:'+s+')','u');
const fashionHead=word('футболк|лонгслив|худи|джинс|плать|юбк|блуз|куртк|пальто|свитер|джемпер|брюк|шорт|рубаш|толстов|водолазк|кроссов|кед[аы ]|ботин|сапог|туфл|босонож|сандал|сумк|рюкзак|кошелек|ремень|ремни|серьг|сереж|браслет|кепк|шапк|колье|кольц|цепоч|подвеск');
const rules=[
 ['textbooks',word('учебник')],
 ['notebooks',word('тетрад|блокнот|ежедневник|дневник|скетчбук')],
 ['study_aids',word('учебн(?:ое|ые|ых) пособ|пособие|пособия|пропис|фгос|огэ|егэ|подготовк.{0,24}(?:экзамен|школ)|справочник|таблиц.{0,15}(?:менделеев|растворим)|[0-9]+(?:[-–][0-9]+)?[- ]*(?:й )?класс|практическ.{0,15}(?:заняти|материал)|биологическ.{0,8}химия')],
 ['stationery',word('канцеляр|карандаш|фломастер|маркер|ластик|корректор|пенал|степлер|дырокол|скрепк|бумаг.{0,8}(?:офис|принтер)|ручк.{0,10}(?:шариков|гелев)|альбом.{0,10}рисован')],
 ['books',word('книг|литератур|роман(?:ы|ов|а|$)|энциклопеди|издательств|бестселлер|сборник (?:задач|стих)|сказк|атлас')]
];
export function ownerCategory(p){
 const cat=fold(p.category||p.subjectName||p.cat),title=fold(p.title||p.name);
 // WB's explicit subject wins. Generic "other" is never a useful category.
 for(const [key,re] of rules)if(re.test(cat))return key;
 if(/^(?:ручки|линейки|циркули|точилки|канцелярские ножи)$/u.test(cat))return 'stationery';
 if(/^(?:книжная продукция|книжные издания)$/u.test(cat))return 'books';
 if(/^(?:учебные материалы|образование)$/u.test(cat))return 'study_aids';
 if(p.category_source==='wb-cdn'&&/канцеляр/u.test(fold(p.category_root)))return 'stationery';
 if(p.category_source==='wb-cdn'&&/книжная продукция/u.test(fold(p.category_root))&&!/диск|винил|\b(?:cd|dvd)\b/u.test(cat))return 'books';
 if(/электронн.{0,8}книг.{0,12}ридер/u.test(title)||/ридер/u.test(cat))return null;
 // A bag FOR textbooks / a T-shirt with a book print is still fashion.
 if(fashionHead.test(title)&&!rules.some(([,re])=>re.test(title.split(/\s+(?:для|с принтом|с рисунком)\s+/u)[0])))return null;
 for(const [key,re] of rules)if(re.test(title))return key;
 return null;
}
export function productType(p){
 const excluded=ownerCategory(p);if(excluded)return excluded;
 const head=s=>fold(s).split(/\s+для\s+/u)[0];
 const text=[head(p.category),head(p.title)].join(' ');
 for(const [key,re] of [
  ['tshirt',word('футболк|поло')],['longsleeve',word('лонгслив|водолазк')],['hoodie',word('худи|толстов')],['jeans',word('джинс')],['dress',word('плать')],['skirt',word('юбк')],['blouse',word('блуз|рубаш')],['outerwear',word('куртк|пальто')],['knitwear',word('свитер|джемпер|кофт')],['trousers',word('брюк|шорт')],['shoes',word('кроссов|кед[аы ]|ботин|сапог|туфл|босонож|сандал|обув')],['bag',word('сумк|рюкзак|кросс-боди|тоут|шоппер')],['accessory',word('серьг|сереж|браслет|колье|кольц|подвеск|цепоч|украшен|ремень|ремни|кепк|кошелек')]
 ])if(re.test(text))return key;
 // Never collapse unrelated unknown subjects into one learnable category.
 return !['','другое','other'].includes(fold(p.category))?'wb:'+fold(p.category):'query:'+fold(p.query||'unknown');
}
const fashion=new Set(['tshirt','longsleeve','hoodie','jeans','dress','skirt','blouse','outerwear','knitwear','trousers','shoes','bag','accessory']);
export function qualitySettings(policy={}){return {enabled:false,excluded:[],feedback_enabled:false,fashion_priority:false,...policy.audience_quality};}
export function validateQuality(v){
 if(!v||['enabled','feedback_enabled','fashion_priority'].some(k=>typeof v[k]!=='boolean')||!Array.isArray(v.excluded)||v.excluded.some(k=>!Object.hasOwn(QUALITY_CATEGORIES,k)))throw Error('Проверьте исключения и переключатели');
 return {enabled:v.enabled,excluded:[...new Set(v.excluded)],feedback_enabled:v.feedback_enabled,fashion_priority:v.fashion_priority};
}
export function ownerReason(p,policy){const s=qualitySettings(policy),key=ownerCategory(p);return s.enabled&&s.excluded.includes(key)?'Запрет владельца: '+QUALITY_CATEGORIES[key]:null;}
export function queryOwnerReason(query,policy){return ownerReason({title:query},policy);}
export function summariseVotes(rows){
 const items=new Map(),traits=new Map();let likes=0,dislikes=0;
 const add=(key,row)=>{if(!traits.has(key))traits.set(key,{key,likes:0,dislikes:0,people:new Set(),products:new Set()});const s=traits.get(key);s[row.sentiment==='l'?'likes':'dislikes']++;s.people.add(row.voter);s.products.add(row.pid);};
 for(const r of rows){
  if(!['l','d'].includes(r.sentiment))continue;
  let p;try{p=typeof r.data==='string'?JSON.parse(r.data):r.data;}catch{continue;}if(!p)continue;
  const item=items.get(r.pid)||{likes:0,dislikes:0};item[r.sentiment==='l'?'likes':'dislikes']++;items.set(r.pid,item);
  if(r.sentiment==='l')likes++;else dislikes++;
  add('type:'+productType(p),r);
  // Passed in ONLY by current-image/model validated cachedProfiles(). No title style.
  for(const key of r.visual_keys||[])add(key,r);
 }
 const stats=[...traits.values()].map(s=>{const n=s.likes+s.dislikes,rate=(s.likes+2)/(n+4),sufficient=s.people.size>=5&&s.products.size>=4&&n>=12;
  const z=1.96,p=s.likes/n,d=1+z*z/n,center=(p+z*z/(2*n))/d,radius=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d,interval=[Math.max(0,center-radius),Math.min(1,center+radius)];
  const direction=sufficient&&interval[1]<.5?'negative':sufficient&&interval[0]>.5?'positive':'insufficient';
  return {key:s.key,label:TYPE_LABELS[s.key.replace(/^type:/,'')]||s.key.replace(/^type:(?:query:|wb:)?/,''),likes:s.likes,dislikes:s.dislikes,positive_ratio:n?s.likes/n:null,negative_ratio:n?s.dislikes/n:null,people:s.people.size,products:s.products.size,sufficient,interval,direction,multiplier:direction!=='insufficient'?Math.max(.6,Math.min(1.2,1+(rate-.5)*.8)):1,reason:!sufficient?'Недостаточно данных: нужно 5 человек, 4 товара и 12 голосов':direction==='insufficient'?'Сигнал неустойчив: доверительный интервал пересекает 50%':'Мягкая оценка: устойчивый сигнал (Wilson 95%), не запрет'};});
 return {items,traits:new Map(stats.map(s=>[s.key,s])),likes,dislikes,sampled_votes:rows.length,truncated:rows.length===VOTE_WINDOW};
}
export function candidateQuality(p,policy,context=null,visualKeys=[]){
 const s=qualitySettings(policy),reasons=[],blocked=ownerReason(p,policy),type=productType(p);let score=1;
 if(blocked)return {allowed:false,reason:blocked,type,score:0,reasons:[blocked]};
 if(!s.enabled)return {allowed:true,type,score,reason:'Действующие фильтры Legacy; новые правила выключены',reasons:[]};
 if(s.fashion_priority&&fashion.has(type)){score*=1.15;reasons.push('Приоритет одежды, обуви и аксессуаров (+15%, не оценка стиля)');}
 if(s.feedback_enabled&&context){
  const item=context.items.get(Number(p.id));if(item){const n=item.likes+item.dislikes,m=1+(item.likes-item.dislikes)/(n+4)*.25;score*=m;reasons.push(`Этот товар: 👍 ${item.likes} / 👎 ${item.dislikes}`);}
  for(const key of ['type:'+type,...visualKeys]){const t=context.traits.get(key);if(t?.sufficient){score*=t.multiplier;reasons.push(`${t.label||key}: 👍 ${t.likes} / 👎 ${t.dislikes}, множитель ${t.multiplier.toFixed(2)}`);}}
 }
 return {allowed:true,type,score:Math.max(.45,Math.min(1.5,score)),reason:reasons.join(' · ')||'Разрешён; независимых реакций пока недостаточно',reasons};
}
export function qualityRank(rows,recent,policy,context=null){
 const s=qualitySettings(policy);if(!s.enabled)return rows;
 const types=recent.slice(-2).map(r=>productType(JSON.parse(r.data||'{}'))),last=types.length===2&&types[0]===types[1]?types[0]:null;
 const alternate=s.fashion_priority&&last&&rows.some(r=>productType(JSON.parse(r.data))!==last);
 return rows.map((row,i)=>{const p=JSON.parse(row.data),v=candidateQuality(p,policy,context,context?.visual?.get(row.pid)||[]);return {row,i,v,score:v.score*(alternate&&last===v.type?.replace(/^type:/,'')?.toString()?0.7:1)};})
  .filter(x=>x.v.allowed).sort((a,b)=>b.score-a.score||a.i-b.i).map(x=>x.row);
}
