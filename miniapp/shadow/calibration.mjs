// Independent offline fashion-only calibration. No fetch, AI, credentials,
// production imports or publication policy. Categories are actual WB metadata,
// never positive guesses from title/search query. The server attests provenance.
const groups = {
  clothing: ['Брюки','Джинсы','Джеггинсы','Леггинсы','Тайтсы','Шорты','Бермуды','Юбки','Сарафаны','Платья','Блузки','Блузоны','Рубашки','Футболки','Поло','Майки','Топы','Туники','Лонгсливы','Водолазки','Джемперы','Свитеры','Пуловеры','Кардиганы','Толстовки','Худи','Свитшоты','Жакеты','Пиджаки','Жилеты','Костюмы','Костюмы спортивные','Комбинезоны','Комбинезоны спортивные','Куртки','Пальто','Полупальто','Плащи','Тренчкоты','Ветровки','Пуховики','Парки','Шубы','Дубленки','Гольфы','Носки','Колготки','Трусы','Бюстгальтеры','Комплекты белья','Пижамы','Халаты','Ночные сорочки','Купальники','Плавки'],
  shoes: ['Кроссовки','Кеды','Туфли','Босоножки','Сандалии','Балетки','Лоферы','Мокасины','Слипоны','Эспадрильи','Сабо','Мюли','Ботинки','Полуботинки','Сапоги','Полусапожки','Ботильоны','Ботфорты','Угги','Дутики','Валенки','Сланцы','Шлепанцы','Тапочки'],
  bags: ['Сумки','Рюкзаки','Клатчи','Кошельки','Портмоне','Картхолдеры'],
  accessories: ['Серьги','Кольца','Браслеты','Колье','Цепочки','Кулоны','Подвески','Броши','Бусы','Чокеры','Очки солнцезащитные','Очки для имиджа','Часы наручные','Ремни','Пояса','Шарфы','Палантины','Платки','Снуды','Шапки','Кепки','Бейсболки','Панамы','Береты','Шляпы','Перчатки','Варежки','Митенки','Ободки','Резинки для волос','Заколки для волос'],
};
export const FASHION_GROUP_LABELS = Object.freeze({clothing:'Одежда', shoes:'Обувь', bags:'Сумки', accessories:'Аксессуары'});
export const FASHION_CATEGORIES = Object.freeze(Object.fromEntries(Object.entries(groups).map(([group, names]) => [group, Object.freeze([...names])])));
const canonical = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/\s+/g,' ') : '';
const categoryMap = new Map(Object.entries(groups).flatMap(([group, names]) => names.map(category => [canonical(category), {group, category}])));
const idOf = product => Number(product?.id ?? product?.nmId ?? product?.pid);
const validId = value => Number.isSafeInteger(value) && value > 0 && value < 1e12;
const negativeTitle = /^(?:(?:набор|комплект)\s+(?:для\s+(?:шитья|рукоделия|поделок|создания|изготовления|декорирования)|нашивок|шевронов|заплаток|аппликаций|фурнитуры)|(?:вкладыш|вкладыши|обложка|обложки)\s+(?:для\s+|на\s+)?(?:авто)?документ|декор\s+для\s+|(?:книга|учебник|выкройка|нашивка|нашивки|шеврон|шевроны|заплатка|заплатки|термоаппликация|термоаппликации|ремкомплект|запчасть|запчасти|фурнитура)(?=$|[^\p{L}\p{N}]))/u;

export function fashionCategory(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product) || product.categoryVerified !== true) return {allowed:false, group:null, category:null, reason:'CATEGORY_NOT_CONFIRMED'};
  const entry = categoryMap.get(canonical(product.category));
  if (!entry) return {allowed:false, group:null, category:null, reason:'CATEGORY_OUTSIDE_FASHION_ALLOWLIST'};
  // Negative safety check only; a title is NEVER positive category evidence.
  if (negativeTitle.test(canonical(product.name ?? product.title))) return {allowed:false, group:null, category:entry.category, reason:'EXPLICIT_PART_CRAFT_OR_BOOK_TITLE'};
  return {allowed:true, ...entry, reason:'CONFIRMED_WB_FASHION_CATEGORY'};
}

function hasVerifiedPhoto(product) {
  if (!/^[a-f0-9]{64}$/i.test(product.imageHash ?? '') || !Number.isSafeInteger(product.photoVerifiedAt) || product.photoVerifiedAt <= 0) return false;
  if (product.localPhoto === `photos/${idOf(product)}.webp`) return true;
  try {
    const image = new URL(product.image);
    return image.protocol === 'https:' && !image.username && !image.password && /(?:^|\.)wbbasket\.ru$/.test(image.hostname);
  } catch {return false;}
}

function familyTokens(product) {
  // Remove explicit size markers, not color/style words. This is duplicate
  // detection only; these title tokens do not enter a taste/Visual profile.
  return canonical(product.name ?? product.title)
    .replace(/(?<![\p{L}\p{N}])(?:size|размер)\s*[\dа-яa-z/-]+/gu,' ')
    .replace(/\b(?:xxxl|xxl|xl|xs|xxs|s|m|l)\b/gu,' ')
    .replace(/[^\p{L}\p{N} ]/gu,' ').split(/\s+/u).filter(token => token.length > 1);
}

function sameFamily(a, b) {
  if (canonical(a.category) !== canonical(b.category)) return false;
  const explicitA = typeof a.familyId === 'string' || Number.isSafeInteger(a.familyId) ? String(a.familyId) : '';
  const explicitB = typeof b.familyId === 'string' || Number.isSafeInteger(b.familyId) ? String(b.familyId) : '';
  // An explicit verified parent id is sufficient only when the catalog adapter
  // supplied it; never derive a family from neighboring nmIds.
  if (a.familyVerified === true && b.familyVerified === true && explicitA && explicitA === explicitB) return true;
  const brand = canonical(a.brand);
  if (!brand || brand === 'unknown' || brand !== canonical(b.brand)) return false;
  const left = new Set(familyTokens(a)), right = new Set(familyTokens(b));
  if (Math.min(left.size,right.size) < 4) return false;
  const match = [...left].filter(token => right.has(token)).length, union = new Set([...left,...right]).size;
  // Strong near-equality retains legitimate clearly different colors because
  // color is not stripped. Generic "women's bag" labels are not a family.
  return match / Math.max(1,union) >= .95;
}

/** 30–40 real fashion photos, balanced across groups and categories.
 * A shortage remains explicit; never relax proof/category/duplicate rules to fill.
 */
export function selectFashionCalibration(products, {target=40,min=30,maxPerCategory=8,priceMin=0,priceMax=null,categories=null} = {}) {
  if (!Array.isArray(products) || products.length > 1000 || !Number.isSafeInteger(target) || target < 30 || target > 40 || !Number.isSafeInteger(min) || min < 30 || min > target || !Number.isSafeInteger(maxPerCategory) || maxPerCategory < 1 || maxPerCategory > 20 || !Number.isFinite(priceMin) || priceMin < 0 || priceMax !== null && (!Number.isFinite(priceMax) || priceMax < priceMin) || categories !== null && (!Array.isArray(categories) || categories.some(category => typeof category !== 'string'))) throw Error('CALIBRATION_INVALID_OPTIONS');
  const wanted = categories === null ? null : new Set(categories.map(canonical));
  const rejected = [], eligible = [], byId = new Set(), imageHashes = new Set();
  const reject = (product, reason) => rejected.push({id:validId(idOf(product))?idOf(product):null,reason});
  for (const product of products) {
    const id = idOf(product), category = fashionCategory(product);
    if (!validId(id)) {reject(product,'INVALID_NMID');continue;}
    if (!category.allowed) {reject(product,category.reason);continue;}
    if (wanted && !wanted.has(canonical(category.category))) {reject(product,'CATEGORY_FILTER');continue;}
    if (!hasVerifiedPhoto(product)) {reject(product,'PHOTO_NOT_VERIFIED');continue;}
    if (priceMin > 0 || priceMax !== null) {
      if (!Number.isFinite(product.price) || product.price <= 0) {reject(product,'FILTER_PRICE_UNKNOWN');continue;}
      if (product.price < priceMin || priceMax !== null && product.price > priceMax) {reject(product,'PRICE_FILTER');continue;}
    }
    if (byId.has(id)) {reject(product,'DUPLICATE_NMID');continue;}
    const hash = product.imageHash.toLowerCase();
    if (imageHashes.has(hash)) {reject(product,'DUPLICATE_IMAGE');continue;}
    if (eligible.some(prior => sameFamily(prior.product,product))) {reject(product,'NEAR_IDENTICAL_FAMILY');continue;}
    byId.add(id);imageHashes.add(hash);eligible.push({product,category:category.category,group:category.group});
  }
  const buckets = new Map(Object.keys(groups).map(group => [group,new Map()]));
  for (const item of eligible) {
    const bucket = buckets.get(item.group);
    if (!bucket.has(item.category)) bucket.set(item.category,[]);
    bucket.get(item.category).push(item);
  }
  const groupLists = [...buckets].filter(([,bucket])=>bucket.size).map(([group,bucket])=>({group,cursor:0,categories:[...bucket].sort(([a],[b])=>a.localeCompare(b,'ru')).map(([category,items])=>({category,items:items.sort((a,b)=>idOf(a.product)-idOf(b.product)),used:0}))}));
  const selected = [];
  while (selected.length < target) {
    let advanced = false;
    for (const list of groupLists) {
      for (let step=0;step<list.categories.length;step++) {
        const index=(list.cursor+step)%list.categories.length, bucket=list.categories[index];
        if (!bucket.items.length || bucket.used >= maxPerCategory) continue;
        selected.push(bucket.items.shift());bucket.used++;list.cursor=(index+1)%list.categories.length;advanced=true;break;
      }
      if (selected.length === target) break;
    }
    if (!advanced) break;
  }
  const byGroup={},byCategory={},breakdown={byGroup,byCategory,groups:byGroup,categories:byCategory};
  for (const item of selected) {byGroup[item.group]=(byGroup[item.group]??0)+1;byCategory[item.category]=(byCategory[item.category]??0)+1;}
  const rejectionCounts = Object.fromEntries([...new Set(rejected.map(row=>row.reason))].sort().map(reason=>[reason,rejected.filter(row=>row.reason===reason).length]));
  const shortfall=Math.max(0,target-selected.length),minimumShortfall=Math.max(0,min-selected.length);
  return {products:selected.map(item=>item.product),selectedIds:selected.map(item=>idOf(item.product)),target,min,availableEligible:eligible.length,selected:selected.length,shortfall,minimumShortfall,ready:minimumShortfall===0,breakdown,rejected,rejectionCounts,
    note:shortfall?`Подтверждено ${selected.length} разных fashion-фотографий из ${target}; недостающие товары не выдуманы, ограничения не ослаблены.`:`${selected.length} настоящих fashion-фотографий; одежда, обувь, сумки и аксессуары чередуются.`,
    priceFilterNote:priceMin>0||priceMax!==null?'Фильтр использует сохранённую цену снимка, не подтверждает сегодняшнюю цену или наличие.':null};
}

const dimensions={category:'Категория',budget:'Ценовой диапазон',style:'Стиль',fit:'Крой',pattern:'Принт',color:'Цвет',silhouette:'Силуэт',palette:'Палитра',texture:'Фактура',complexity:'Детализация',group:'Тип вещи',length:'Длина',sleeves:'Рукава',print_size:'Размер принта',print_location:'Расположение принта',neckline:'Горловина',shape:'Форма',height:'Высота',sole:'Подошва',toe:'Носок',closure:'Застёжка',size:'Размер',carry:'Ношение',decoration:'Декор',finish:'Поверхность',form:'Форма'};
const values={black:'чёрный',white:'белый',grey:'серый',beige:'бежевый',brown:'коричневый',red:'красный',pink:'розовый',blue:'синий',green:'зелёный',yellow:'жёлтый',orange:'оранжевый',purple:'фиолетовый',multicolor:'многоцветный',dark:'тёмная',light:'светлая',bright:'яркая',neutral:'нейтральная',pastel:'пастельная',solid:'однотонный',graphic:'графический',striped:'полоска',checked:'клетка',floral:'цветочный',animal:'анималистичный',abstract:'абстрактный',minimal:'минимализм',classic:'классический',streetwear:'уличный',sport:'спортивный',casual:'повседневный',retro:'ретро',romantic:'романтический',industrial:'индустриальный',oversize:'свободный oversize',regular:'обычный',slim:'приталенный',loose:'свободный',fitted:'облегающий',straight:'прямой',a_line:'А-силуэт',smooth:'гладкая',ribbed:'в рубчик',knitted:'вязаная',fuzzy:'ворсистая',quilted:'стёганая',woven:'плетёная',glossy:'глянцевая',matte:'матовая',low:'низкий',mid:'средний',high:'высокий',medium:'средний',cropped:'укороченная',short:'короткая',long:'длинная',sleeveless:'без рукавов',small:'маленький',large:'большой',front:'спереди',back:'сзади',front_and_back:'спереди и сзади',all_over:'по всей вещи',round:'круглая',v_neck:'V-образная',collared:'с воротником',hooded:'с капюшоном',chunky:'массивная',thin:'тонкая',thick:'толстая',pointed:'заострённый',square:'квадратный',laces:'шнурки',zip:'молния',velcro:'липучка',slip_on:'без застёжки',rectangular:'прямоугольная',bucket:'мешок',structured:'жёсткая',soft:'мягкая',shoulder:'на плече',crossbody:'через плечо',handles:'за ручки',backpack:'рюкзак',none:'без декора',hardware:'фурнитура',fringe:'бахрома',embroidery:'вышивка',print:'принт',angular:'угловатая',elongated:'удлинённая',irregular:'неправильная',metal:'металл',stones:'камни',apparel:'одежда',shoes:'обувь',bag:'сумка',accessory:'аксессуар'};

// Rendering only. Unknown labels never become feature evidence or an ML score.
export function tasteFeatureLabel(key) {
  if (typeof key !== 'string' || key.length > 220 || /[\u0000-\u001f]/u.test(key)) return 'Признак пока неизвестен';
  const normalized=key.replace(/^visual\./u,''),separator=normalized.indexOf('='),dimension=separator<0?normalized:normalized.slice(0,separator),value=separator<0?'unknown':normalized.slice(separator+1);
  const title=dimensions[dimension];
  if (!title) return 'Признак пока неизвестен';
  if (!value || ['unknown','неизвестно'].includes(canonical(value))) return `${title}: пока неизвестно`;
  if (dimension==='category') return `${title}: ${value}`;
  if (dimension==='budget' && /^(?:\d+–\d+|\d+\+) ₽$/u.test(value)) return `${title}: ${value}`;
  return `${title}: ${values[value]??'пока неизвестно'}`;
}
