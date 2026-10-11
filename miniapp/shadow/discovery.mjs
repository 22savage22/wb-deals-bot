// Independent read-only SHADOW discovery. No fetch, production import, D1, AI,
// Telegram, timers/cron registration or default network client lives here.
// Persist the returned admission state atomically BEFORE I/O when used by a
// multi-process staging runner. readOnly is a required adapter contract, not
// a claim that arbitrary injected code can be proved side-effect free.
export const DISCOVERY_TOPICS = Object.freeze([
  { category: 'clothing', queries: ['платье женское', 'футболка мужская', 'джинсы женские'] },
  { category: 'shoes', queries: ['кроссовки женские', 'кроссовки мужские'] },
  { category: 'bags', queries: ['сумка женская', 'рюкзак'] },
  { category: 'accessories', queries: ['ремень', 'кепка', 'украшения'] },
  { category: 'home', queries: ['товары для кухни', 'органайзер для дома', 'плед'] },
  { category: 'electronics', queries: ['электроника', 'наушники'] },
  { category: 'cosmetics', queries: ['косметика', 'уход за лицом'] },
  { category: 'unusual', queries: ['оригинальные подарки', 'необычные товары для дома'] },
].map(t => Object.freeze({ ...t, queries: Object.freeze(t.queries) })));
export const ULTRA_BUDGET_CEILINGS = Object.freeze([100, 200, 300]);
const MINUTE = 60_000, MAX_CARDS = 20, MAX_RESULTS = 100;
const busySources = new WeakMap();
const admittedSources = new WeakMap();
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const id = v => Number.isSafeInteger(v) && v > 0 && v <= 999_999_999_999;
const label = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export const discoveryTitleKey = v => label(v).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const money = v => Number.isSafeInteger(v) && v > 0 && v <= 1_000_000_000 ? v / 100 : null;
function time(now) { if (!Number.isSafeInteger(now) || now <= 0) throw Error('SHADOW_INVALID_TIME'); return now; }
function policy(config = {}) {
  const interval = finite(config.intervalMinutes) ? config.intervalMinutes : 20;
  return { intervalMs: Math.max(5, Math.min(1440, interval)) * MINUTE,
    maxPrice: finite(config.maxPrice) && config.maxPrice > 0 ? config.maxPrice : null,
    minRating: finite(config.minRating) ? Math.max(4, Math.min(5, config.minRating)) : 4.3,
    minReviews: finite(config.minReviews) ? Math.max(10, Math.ceil(config.minReviews)) : 20,
    detailLimit: finite(config.detailLimit) ? Math.max(1, Math.min(MAX_CARDS, Math.floor(config.detailLimit))) : MAX_CARDS,
    timeoutMs: finite(config.timeoutMs) ? Math.max(10, Math.min(12_000, config.timeoutMs)) : 12_000,
    ultraBudgetEvery: finite(config.ultraBudgetEvery) ? Math.max(1, Math.min(100, Math.floor(config.ultraBudgetEvery))) : 4,
    existingTopics: Array.isArray(config.existingTopics) ? config.existingTopics.slice(0, 100).map(v => label(v, 100)).filter(Boolean) : [],
  };
}
function stateOf(state = {}) {
  return { version: 1, cursor: Math.max(0, Math.floor(finite(state.cursor) ? state.cursor : 0)),
    failures: Math.max(0, Math.min(16, Math.floor(finite(state.failures) ? state.failures : 0))),
    lastAttempt: finite(state.lastAttempt) ? Math.max(0, state.lastAttempt) : 0,
    nextSearch: finite(state.nextSearch) ? Math.max(0, state.nextSearch) : 0,
    retryAt: finite(state.retryAt) ? Math.max(0, state.retryAt) : 0,
    leaseUntil: finite(state.leaseUntil) ? Math.max(0, state.leaseUntil) : 0,
    lastSuccess: finite(state.lastSuccess) ? Math.max(0, state.lastSuccess) : 0,
    lastError: label(state.lastError, 50) };
}
export function planDiscovery(state = {}, config = {}, now = Date.now()) {
  time(now); const s = stateOf(state), p = policy(config);
  const notBefore = Math.max(s.nextSearch, s.retryAt, s.lastAttempt ? s.lastAttempt + p.intervalMs : 0);
  if (s.leaseUntil > now) return { due: false, reason: 'lease_busy', nextSearch: Math.max(notBefore, s.leaseUntil), state: s };
  if (notBefore > now) return { due: false, reason: s.retryAt > now ? 'backoff' : 'not_due', nextSearch: notBefore, state: s };
  const topics = [...DISCOVERY_TOPICS, ...(p.existingTopics.length ? [{ category: 'configured', queries: p.existingTopics }] : [])];
  const lane = topics[s.cursor % topics.length], lap = Math.floor(s.cursor / topics.length);
  const query = lane.queries[lap % lane.queries.length];
  const ultra = (s.cursor + 1) % p.ultraBudgetEvery === 0;
  const budget = ultra ? ULTRA_BUDGET_CEILINGS[Math.floor(s.cursor / p.ultraBudgetEvery) % 3] : null;
  // Ultra-budget is independent of channel/category restrictions, but never
  // bypasses real price, rating, review, stock, known-ID or duplicate checks.
  const priceCeiling = budget ?? p.maxPrice;
  return { due: true, query, category: lane.category, lane: ultra ? 'ultra_budget' : 'regular', priceCeiling,
    params: { appType: '1', curr: 'rub', dest: '-1257786', spp: '30', lang: 'ru', query,
      page: String(1 + lap % 5), sort: s.cursor % 2 ? 'popular' : 'priceup', resultset: 'catalog' },
    state: { ...s, cursor: s.cursor + 1, lastAttempt: now, nextSearch: now + p.intervalMs, leaseUntil: now + 60_000 }, policy: p };
}
export function shadowRetryAfter(value, now) {
  if (value == null || value === '') return 0;
  const seconds = /^\d+$/.test(String(value).trim()) ? Number(value) : (Date.parse(String(value)) - now) / 1000;
  return finite(seconds) ? Math.max(0, Math.min(86_400, Math.ceil(seconds))) * 1000 : 0;
}
export function nextDiscoveryState(state, outcome, now = Date.now(), random = Math.random) {
  time(now); const s = stateOf(state);
  if (outcome?.ok === true) return { ...s, failures: 0, retryAt: 0, leaseUntil: 0, lastError: '', lastSuccess: now };
  const failures = Math.min(16, s.failures + 1), status = Number(outcome?.status || 0);
  const base = status === 403 ? 900_000 : 300_000;
  const exponential = Math.min(21_600_000, base * 2 ** (failures - 1));
  const r = random(), jitter = Math.floor(exponential * .25 * (finite(r) ? Math.max(0, Math.min(1, r)) : 1));
  const delay = Math.max(Math.min(21_600_000, exponential + jitter), shadowRetryAfter(outcome?.retryAfter, now));
  const retryAt = Math.max(s.nextSearch, now + delay);
  const code = status >= 400 && status <= 599 ? `WB_HTTP_${status}` : ['TIMEOUT', 'INVALID_RESPONSE', 'INVALID_CONTEXT', 'ADMISSION_FAILED'].includes(outcome?.code) ? outcome.code : 'SOURCE_UNAVAILABLE';
  return { ...s, failures, retryAt, nextSearch: retryAt, leaseUntil: 0, lastError: code };
}
function stock(size) {
  const qty = finite(size.qty) && size.qty >= 0 ? size.qty : null;
  const rows = Array.isArray(size.stocks) ? size.stocks.slice(0, 100) : null;
  const known = rows?.filter(v => object(v) && finite(v.qty) && v.qty >= 0) ?? [];
  const positive = known.some(v => v.qty > 0);
  if (qty !== null && rows && ((qty === 0 && positive) || (qty > 0 && rows.length > 0 && known.length === rows.length && !positive))) return null;
  if (qty !== null) return qty > 0;
  if (positive) return true;
  if (rows && (rows.length === 0 || known.length === rows.length)) return false;
  return null;
}
export function normalizeWBCard(card, { query = '', category = '', now = Date.now(), context = {}, allowUnknownStock = false } = {}) {
  time(now);
  if (!object(card) || !id(card.id) || !label(card.name) || !Array.isArray(card.sizes)) return null;
  const currency = label(context.currency || context.curr, 10).toUpperCase();
  const destination = context.destination ?? context.dest;
  if (currency !== 'RUB' || !/^-?\d{1,10}$/.test(String(destination ?? ''))) return null;
  const ctx = { curr: 'rub', dest: String(destination), spp: label(context.spp, 10) || 'unknown' };
  const canonicalContext = { currency, destination: ctx.dest, paymentBasis: label(context.paymentBasis, 80) || 'unknown' };
  const variants = card.sizes.slice(0, 100).filter(object).map(size => {
    const price = money(size.price?.product), oldPrice = money(size.price?.basic);
    const available = stock(size), chrt = size.chrtId ?? size.chrtID;
    // Name/index is not a stable SKU: sizes can be reordered/renamed. Without
    // a real WB size ID history matching must remain unknown.
    const sizeID = id(chrt) ? chrt : id(size.sizeId) ? size.sizeId : null;
    return { variantKey: sizeID === null ? 'unknown' : String(sizeID),
      size: label(size.name || size.origName, 60) || 'unknown', price, oldPrice, available,
      condition: label(size.price?.condition, 80) || canonicalContext.paymentBasis, currency: 'RUB', context: { ...canonicalContext } };
  }).filter(v => v.price !== null);
  const proven = variants.filter(v => v.available === true);
  const diagnostic = allowUnknownStock ? variants.filter(v => v.available === null) : [];
  const candidates = proven.length ? proven : diagnostic;
  if (!candidates.length) return null;
  const selected = candidates.reduce((a, b) => a.price <= b.price ? a : b);
  return { id: card.id, pid: card.id, title: label(card.name), name: label(card.name), brand: label(card.brand, 100),
    category: label(card.subjectName, 100) || label(card.subject, 100) || label(category, 100) || 'unknown',
    type: label(card.type, 100) || 'unknown',
    query: label(query, 100), price: selected.price, oldPrice: selected.oldPrice, currency: 'RUB',
    priceSource: 'wb_card', observedAt: now, available: selected.available, variantKey: selected.variantKey,
    variants, context: { ...canonicalContext }, priceContext: { ...ctx }, priceCondition: selected.condition,
    ...(label(card.priceBasis, 60) ? { priceBasis: label(card.priceBasis, 60) } : {}),
    ...(Number.isSafeInteger(card.packCount) && card.packCount > 0 && card.packCount <= 1000 ? { packCount: card.packCount } : {}),
    sellerDiscountPercent: selected.oldPrice > selected.price ? Math.round((1 - selected.price / selected.oldPrice) * 10000) / 100 : 0,
    sellerDiscountIsEvidence: false, rating: finite(card.reviewRating) ? card.reviewRating : finite(card.rating) ? card.rating : null,
    reviews: finite(card.feedbacks) ? card.feedbacks : finite(card.nmFeedbacks) ? card.nmFeedbacks : null,
    url: `https://www.wildberries.ru/catalog/${card.id}/detail.aspx`,
  };
}
function knownSet(values, mapper) {
  if (!(values instanceof Set) && !Array.isArray(values) && values !== undefined) throw Error('SHADOW_INVALID_KNOWN_SET');
  const rows = values === undefined ? [] : [...values];
  if (rows.length > 10_000) throw Error('SHADOW_KNOWN_SET_TOO_LARGE');
  return new Set(rows.map(mapper).filter(Boolean));
}
function products(payload) {
  const status = Number(payload?.status || 0);
  if (status >= 400 && status <= 599) throw Object.assign(Error('Source HTTP error'), { status, headers: payload.headers });
  const rows = Array.isArray(payload) ? payload : payload?.products ?? payload?.data?.products;
  if (!Array.isArray(rows)) throw Object.assign(Error('Invalid source response'), { safeCode: 'INVALID_RESPONSE' });
  return rows;
}
function errorInfo(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? 0);
  const retryAfter = error?.retryAfter ?? error?.retry_after ?? error?.headers?.get?.('Retry-After') ?? error?.response?.headers?.get?.('Retry-After');
  return { status, retryAfter, code: error?.safeCode }; // Never expose the raw message/body/headers/URL.
}
function detailContext(payload, requested) {
  const c = payload?.context;
  const currency = label(c?.currency || c?.curr, 10).toUpperCase(), destination = c?.destination ?? c?.dest;
  // Requested parameters alone cannot prove an adapter actually honoured them.
  // The trusted read-only adapter must report its actual anonymous/card context.
  if (!object(c) || currency !== requested.curr.toUpperCase() || String(destination ?? '') !== requested.dest)
    throw Object.assign(Error('Unknown detail context'), { safeCode: 'INVALID_CONTEXT' });
  return { currency, destination: String(destination), spp: label(c.spp, 10) || 'unknown', paymentBasis: label(c.paymentBasis, 80) || 'unknown' };
}
async function invoke(source, kind, argument, timeoutMs, token, params) {
  const controller = new AbortController(); let timer;
  // If an injected client ignores cancellation, keep its in-process slot held
  // until it settles. Unknown network outcome must not cause parallel retries.
  const work = Promise.resolve().then(() => source[kind](argument, { signal: controller.signal, ...(params ? { params: { ...params } } : {}) }));
  token.pending = work;
  work.then(() => { if (token.pending === work) token.pending = null; }, () => { if (token.pending === work) token.pending = null; });
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(Error('Source timeout'), { safeCode: 'TIMEOUT' })); }, timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
export function createShadowDiscovery(source, config = {}) {
  if (!object(source) || source.readOnly !== true || typeof source.search !== 'function' || typeof source.cards !== 'function') throw Error('SHADOW_READ_ONLY_SOURCE_REQUIRED');
  const p = policy(config);
  return { fetchShadowBatch: async ({ state = {}, knownIds, knownTitles, now = Date.now(), random = Math.random, onAdmission } = {}) => {
    time(now); const idsKnown = knownSet(knownIds, v => id(Number(v)) ? String(Number(v)) : ''), titlesKnown = knownSet(knownTitles, discoveryTitleKey);
    const supplied = stateOf(state), lastAdmitted = admittedSources.get(source);
    // Keep the newest admitted state within this process as well. A caller's
    // stale/omitted snapshot cannot erase a cooldown between separate clients.
    // Cross-process safety still requires atomic staging persistence/admission.
    const effective = lastAdmitted && lastAdmitted.lastAttempt >= supplied.lastAttempt ? lastAdmitted : supplied;
    const receipt = { mode: 'SHADOW', result: 'skipped', calls: 0, found: 0, newCandidates: 0, cardsValidated: 0, newValidProducts: 0,
      valueContextKnownProducts: 0, publicationApprovedProducts: 0, validationScope: 'discovery_cards_only_not_publication_approval',
      rejected: { known: 0, duplicate: 0, malformed: 0, invalidCard: 0, unavailable: 0, budget: 0, rating: 0, reviews: 0 } };
    if (busySources.has(source)) return { products: [], state: { ...effective }, receipt: { ...receipt, reason: 'source_busy', nextSearch: effective.nextSearch } };
    const plan = planDiscovery(effective, config, now);
    if (!plan.due) return { products: [], state: plan.state, receipt: { ...receipt, reason: plan.reason, nextSearch: plan.nextSearch } };
    const token = { pending: null }; busySources.set(source, token);
    let current = plan.state;
    admittedSources.set(source, { ...current });
    Object.assign(receipt, { query: plan.query, category: plan.category, lane: plan.lane, priceCeiling: plan.priceCeiling, at: now });
    try {
      // Callback returns false on a lost atomic lease. It may persist ONLY the
      // independent staging state; no production storage adapter is provided.
      if (onAdmission && await onAdmission({ ...current }) !== true) throw Object.assign(Error('Admission refused'), { safeCode: 'ADMISSION_FAILED' });
      const params = { ...plan.params };
      if (source.supportsPriceFilter === true && plan.priceCeiling) params.priceU = `0;${Math.floor(plan.priceCeiling * 100)}`;
      receipt.calls++;
      const found = products(await invoke(source, 'search', params, p.timeoutMs, token)).slice(0, MAX_RESULTS);
      receipt.found = found.length; const candidateIds = [], batchIds = new Set(), batchTitles = new Set();
      for (const raw of found) {
        if (!object(raw) || !id(raw.id) || !label(raw.name)) { receipt.rejected.malformed++; continue; }
        const key = discoveryTitleKey(raw.name);
        if (idsKnown.has(String(raw.id))) { receipt.rejected.known++; continue; }
        if (batchIds.has(raw.id) || titlesKnown.has(key) || batchTitles.has(key)) { receipt.rejected.duplicate++; continue; }
        batchIds.add(raw.id); batchTitles.add(key); candidateIds.push(raw.id);
        if (candidateIds.length >= p.detailLimit) break;
      }
      receipt.newCandidates = candidateIds.length;
      const result = [];
      if (candidateIds.length) {
        receipt.calls++;
        const detailParams = Object.fromEntries(['appType', 'curr', 'dest', 'spp', 'lang'].map(key => [key, plan.params[key]]));
        const payload = await invoke(source, 'cards', candidateIds, p.timeoutMs, token, detailParams);
        const details = products(payload).slice(0, MAX_CARDS), context = detailContext(payload, detailParams);
        const returned = new Set(), acceptedTitles = new Set();
        for (const raw of details) {
          if (!object(raw) || !batchIds.has(raw.id) || returned.has(raw.id)) { receipt.rejected.malformed++; continue; }
          returned.add(raw.id);
          const card = normalizeWBCard(raw, { query: plan.query, category: plan.category, now, context });
          if (!card) { receipt.rejected.invalidCard++; continue; }
          if (card.available !== true) { receipt.rejected.unavailable++; continue; }
          const key = discoveryTitleKey(card.title);
          if (titlesKnown.has(key) || acceptedTitles.has(key)) { receipt.rejected.duplicate++; continue; }
          if (plan.priceCeiling && card.price > plan.priceCeiling) { receipt.rejected.budget++; continue; }
          if (card.rating === null || card.rating < p.minRating || card.rating > 5) { receipt.rejected.rating++; continue; }
          if (card.reviews === null || !Number.isSafeInteger(card.reviews) || card.reviews < p.minReviews) { receipt.rejected.reviews++; continue; }
          acceptedTitles.add(key); result.push({ ...card, discoveryLane: plan.lane });
        }
        receipt.rejected.invalidCard += candidateIds.filter(candidate => !returned.has(candidate)).length;
      }
      current = nextDiscoveryState(current, { ok: true }, now, random);
      admittedSources.set(source, { ...current });
      const identified = result.filter(c => c.variantKey !== 'unknown' && ['standard', 'wallet', 'wb_wallet', 'card', 'credit', 'card_membership'].includes(c.context.paymentBasis));
      // Even this narrower number is NOT publisher eligibility: value/visual/
      // taste/safety assessment remains a separate SHADOW step.
      const standard = identified.filter(c => c.context.paymentBasis === 'standard' && c.priceCondition === 'standard');
      return { products: result, state: current, receipt: { ...receipt, result: 'success', cardsValidated: result.length,
        valueContextKnownProducts: identified.length, newValidProducts: standard.length, newIds: result.map(c => c.id), nextSearch: current.nextSearch } };
    } catch (error) {
      current = nextDiscoveryState(current, errorInfo(error), now, random);
      admittedSources.set(source, { ...current });
      return { products: [], state: current, receipt: { ...receipt, result: 'error', error: current.lastError, nextSearch: current.nextSearch } };
    } finally {
      if (token.pending) token.pending.finally(() => { if (busySources.get(source) === token) busySources.delete(source); }).catch(() => {});
      else if (busySources.get(source) === token) busySources.delete(source);
    }
  } };
}
export async function fetchShadowBatch(source, options = {}) {
  return createShadowDiscovery(source, options.config).fetchShadowBatch(options);
}
