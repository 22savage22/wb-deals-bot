// Read-only SHADOW scoring. No I/O, production imports, database writes or AI calls.
// Prices are RUB numbers (not WB kopecks); observedAt accepts ISO, epoch seconds
// or milliseconds. Adapters must supply factual stock and provenance, not infer them.
export const VALUE_POLICY = Object.freeze({
  minRating: 4.3, minReviews: 20, maxPriceAgeMs: 86_400_000,
  minHistoryDays: 3, minHistorySpanDays: 7, historyLimit: 28,
  historyRetentionDays: 90, minComparables: 5, comparableLimit: 200,
  maxTrackedProducts: 300,
});
const DAY = 86_400_000;
const SOURCES = new Set(['wb_card', 'wb_search', 'wb_page', 'wb_catalog']);
const GENERIC = new Set(['', 'unknown', 'other', 'другое', 'неизвестно']);
const clamp = (n, low = 0, high = 100) => Math.min(high, Math.max(low, n));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const epoch = n => finite(n) && n > 0 && n <= 8_640_000_000_000_000;
const money = n => finite(n) && n > 0 && n <= 10_000_000;
const text = n => typeof n === 'string' ? n.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ').slice(0, 120) : '';
const round = n => Math.round(n * 100) / 100;
function millis(n) {
  const value = typeof n === 'string' ? Date.parse(n) : finite(n) && n > 0 ? n < 100_000_000_000 ? n * 1000 : n : NaN;
  return epoch(value) ? value : NaN;
}
function policyOf(overrides = {}) {
  overrides ??= {};
  const p = { ...VALUE_POLICY };
  for (const key of Object.keys(p)) if (finite(overrides[key]) && overrides[key] > 0) p[key] = overrides[key];
  // Bounded even when fed a malformed or over-generous client configuration.
  p.historyLimit = Math.floor(clamp(p.historyLimit, 3, 28));
  p.comparableLimit = Math.floor(clamp(p.comparableLimit, 5, 200));
  p.historyRetentionDays = Math.floor(clamp(p.historyRetentionDays, 7, 90));
  p.maxTrackedProducts = Math.floor(clamp(p.maxTrackedProducts, 1, 300));
  p.maxPriceAgeMs = clamp(p.maxPriceAgeMs, 60_000, 2 * DAY);
  p.minRating = clamp(p.minRating, 4, 5);
  p.minReviews = Math.ceil(clamp(p.minReviews, 10, 10_000));
  p.minComparables = Math.ceil(clamp(p.minComparables, 3, 200));
  p.minHistoryDays = Math.ceil(clamp(p.minHistoryDays, 3, 28));
  p.minHistorySpanDays = clamp(p.minHistorySpanDays, 7, 90);
  return p;
}
const median = values => {
  const rows = [...values].sort((a, b) => a - b), middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
function sameMoney(a, b) { return money(a) && money(b) && Math.abs(a - b) <= 0.005; }
const conditionalPrice = condition => condition != null &&
  (typeof condition !== 'string' || !['', 'standard', 'none'].includes(text(condition)));
const stableVariant = value => typeof value === 'string' && value.trim().length <= 100 && !GENERIC.has(text(value)) ? value.trim() : null;
/** A context is evidence only when currency, destination and payment basis are explicit. */
export function priceContextKey(context) {
  if (typeof context === 'string') {
    if (context.length > 500) return null;
    try { context = JSON.parse(context); } catch { return null; }
  }
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
    !['currency', 'destination', 'paymentBasis'].every(key => Object.hasOwn(context, key)) || context.currency !== 'RUB') return null;
  const destination = typeof context.destination === 'string' ? context.destination.trim() : Number.isSafeInteger(context.destination) ? String(context.destination) : '';
  const paymentBasis = typeof context.paymentBasis === 'string' ? text(context.paymentBasis) : '';
  if (!/^-?\d{1,20}$/.test(destination) || !['standard', 'wallet', 'wb_wallet', 'card', 'credit', 'card_membership'].includes(paymentBasis)) return null;
  return JSON.stringify({ currency: 'RUB', destination, paymentBasis });
}
function priceEvidence(product, now, p) {
  const at = millis(product?.observedAt), ageMs = now - at;
  const valid = money(product?.price) && SOURCES.has(product?.priceSource) &&
    (!product?.currency || product.currency === 'RUB') && finite(ageMs) && ageMs >= 0 && ageMs <= p.maxPriceAgeMs;
  return { valid, price: money(product?.price) ? product.price : null,
    source: SOURCES.has(product?.priceSource) ? product.priceSource : 'unknown',
    observedAt: finite(at) ? new Date(at).toISOString() : null,
    ageMs: finite(ageMs) ? ageMs : null,
    score: valid ? round(100 - 35 * ageMs / p.maxPriceAgeMs) : 0,
    confidence: valid ? round(1 - .35 * ageMs / p.maxPriceAgeMs) : 0 };
}
function variantEvidence(product) {
  const rows = Array.isArray(product?.variants) ? product.variants.slice(0, 100) : [];
  const available = rows.filter(v => v?.available === true && money(v.price));
  const selected = available.filter(v => sameMoney(v.price, product.price) &&
    (!product.variantKey || String(v.variantKey ?? v.key ?? v.size ?? '') === String(product.variantKey)));
  const conditioned = selected.some(v => conditionalPrice(v.condition));
  return { supplied: rows.length > 0, matches: selected.length, conditioned,
    pricesDiffer: new Set(available.map(v => Math.round(v.price * 100))).size > 1,
    availableVariants: available.length,
    availableSizesAtPrice: selected.map(v => String(v.size ?? v.variantKey ?? 'unknown')).slice(0, 20),
    conditions: selected.map(v => v.condition).filter(v => typeof v === 'string' && v.trim()).slice(0, 10) };
}
function historyValue(product, now, p) {
  const key = stableVariant(product.variantKey), context = priceContextKey(product.context);
  const unknown = reason => ({ known: false, score: null, confidence: 0, reason,
    observations: 0, distinctDays: 0, referencePrice: null, savingsPercent: null });
  if (key === null) return unknown('variant_not_identified');
  if (!context || product.currency !== 'RUB') return unknown('price_context_not_identified');
  const byDay = new Map();
  // Callers must load by (pid, variant_key, context) with ORDER BY observed_at DESC LIMIT 28.
  // Never turn an unbounded supplied history into an unbounded per-candidate scan.
  for (const row of (Array.isArray(product.history) ? product.history : []).slice(0, p.historyLimit)) {
    const at = millis(row?.at), observed = millis(product.observedAt), rowKey = stableVariant(row?.variantKey);
    if (!money(row?.price) || !SOURCES.has(row?.source) || row.currency !== 'RUB' || rowKey !== key || priceContextKey(row.context) !== context ||
      !finite(at) || at > now || !finite(observed) || at > observed - DAY || at < now - p.historyRetentionDays * DAY) continue;
    const day = Math.floor(at / DAY), prev = byDay.get(day);
    if (!prev || at > prev.at) byDay.set(day, { price: row.price, at });
  }
  const rows = [...byDay.values()];
  if (rows.length < p.minHistoryDays) return unknown('insufficient_observed_days');
  const spanDays = (Math.max(...rows.map(r => r.at)) - Math.min(...rows.map(r => r.at))) / DAY;
  if (spanDays < p.minHistorySpanDays) return unknown('history_too_short');
  const referencePrice = median(rows.map(r => r.price)), savings = (referencePrice - product.price) / referencePrice;
  return { known: true, score: round(clamp(50 + 200 * savings)),
    confidence: round(clamp(.35 + rows.length / 50 + Math.min(spanDays, 30) / 100, 0, .95)),
    reason: 'observed_price_history', observations: rows.length, distinctDays: rows.length,
    spanDays: round(spanDays), referencePrice: round(referencePrice), savingsPercent: round(100 * savings),
    basis: key, context, notSellerStruckThroughPrice: true };
}

/** Only independently confirmed, comparable in-stock peers can establish a price cohort. */
export function compareCohortPrice(product, comparables = [], { now = Date.now(), policy = {} } = {}) {
  const p = policyOf(policy), category = text(product?.category), type = text(product?.type), ids = new Set();
  const unknown = reason => ({ known: false, score: null, confidence: 0, reason, peers: 0,
    medianPrice: null, savingsPercent: null, pricePercentile: null });
  if (!epoch(now) || !money(product?.price) || GENERIC.has(category) || GENERIC.has(type)) return unknown('cohort_not_identified');
  if (!priceEvidence(product, now, p).valid) return unknown('current_price_unverified');
  const context = priceContextKey(product.context), priceBasis = text(product.priceBasis);
  if (!context || product.currency !== 'RUB' || GENERIC.has(priceBasis) || !Number.isSafeInteger(product.packCount) || product.packCount <= 0) return unknown('price_context_or_pack_basis_unknown');
  const candidateVariants = variantEvidence(product);
  if (candidateVariants.conditioned || conditionalPrice(product.priceCondition) || candidateVariants.supplied && !candidateVariants.matches) return unknown('price_basis_not_comparable');
  const peers = [];
  for (const peer of (Array.isArray(comparables) ? comparables : []).slice(0, p.comparableLimit)) {
    const variant = variantEvidence(peer);
    if (!Number.isSafeInteger(peer?.id) || peer.id <= 0 || peer.id === product.id || ids.has(peer.id) ||
      text(peer.category) !== category || text(peer.type) !== type ||
      peer.currency !== 'RUB' || priceContextKey(peer.context) !== context ||
      text(peer.priceBasis) !== priceBasis || peer.packCount !== product.packCount ||
      (product.audience && peer.audience && product.audience !== 'unknown' && peer.audience !== 'unknown' && product.audience !== peer.audience) ||
      peer.available !== true || !priceEvidence(peer, now, p).valid ||
      !finite(peer.rating) || peer.rating < p.minRating || peer.rating > 5 ||
      !Number.isSafeInteger(peer.reviews) || peer.reviews < p.minReviews ||
      variant.conditioned || conditionalPrice(peer.priceCondition) || variant.supplied && !variant.matches) continue;
    ids.add(peer.id); peers.push(peer.price);
  }
  if (peers.length < p.minComparables) return { ...unknown('insufficient_comparable_peers'), peers: peers.length };
  const med = median(peers), savings = (med - product.price) / med;
  const percentile = 100 * (peers.filter(price => price < product.price).length + peers.filter(price => sameMoney(price, product.price)).length / 2) / peers.length;
  const outlier = product.price < Math.min(...peers) * .5;
  return { known: true, score: round(clamp(50 + 200 * savings)),
    confidence: round(Math.min(outlier ? .5 : .85, .35 + peers.length / 40)),
    reason: 'same_category_type_verified_cohort', peers: peers.length,
    scope: 'limited_observed_sample_not_entire_market', context, priceBasis, packCount: product.packCount,
    category, type, medianPrice: round(med), savingsPercent: round(savings * 100),
    pricePercentile: round(percentile), outlier, peerIds: [...ids] };
}

/** Hard gates run before scoring: a giant claimed discount never rescues bad stock/quality. */
export function assessValue(product = {}, { now = Date.now(), policy = {}, comparables = product?.comparables ?? [] } = {}) {
  product ??= {};
  const p = policyOf(policy), flags = [], reasons = [], price = priceEvidence(product, now, p), variants = variantEvidence(product);
  if (!epoch(now)) throw new TypeError('now must be valid epoch milliseconds');
  if (!Number.isSafeInteger(product.id) || product.id <= 0 || product.id >= 1e12 || !text(product.name)) reasons.push('invalid_product');
  if (!price.valid) reasons.push('price_not_fresh_verified');
  if (product.available !== true) reasons.push(product.available === false ? 'not_available' : 'availability_unknown');
  if (!finite(product.rating) || product.rating < p.minRating || product.rating > 5) reasons.push('rating_below_quality_gate_or_unknown');
  if (!Number.isSafeInteger(product.reviews) || product.reviews < p.minReviews) reasons.push('reviews_below_quality_gate_or_unknown');
  if (variants.supplied && !variants.matches) reasons.push('advertised_price_has_no_available_variant');
  if (variants.conditioned || conditionalPrice(product.priceCondition)) reasons.push('purchase_condition_requires_verification');
  if (variants.pricesDiffer) flags.push('price_depends_on_size_or_variant');
  if (money(product.oldPrice)) {
    flags.push('seller_old_price_not_discount_evidence');
    if (product.oldPrice / product.price >= 5) flags.push('suspicious_seller_discount');
    if (product.oldPrice < product.price) flags.push('seller_old_price_below_current');
  }
  const history = price.valid ? historyValue(product, now, p) : { known: false, score: null, confidence: 0, reason: 'current_price_unverified' };
  const market = compareCohortPrice(product, comparables, { now, policy: p });
  if (market.outlier) flags.push('very_low_cohort_price_verify_conditions');
  const eligible = reasons.length === 0;
  const validQualityData = finite(product.rating) && product.rating >= 0 && product.rating <= 5 && Number.isSafeInteger(product.reviews) && product.reviews >= 0;
  const qualityPassed = validQualityData && product.rating >= p.minRating && product.reviews >= p.minReviews;
  const qualityScore = finite(product.rating) && Number.isSafeInteger(product.reviews) ? round(clamp(60 + 35 * (product.rating - p.minRating) / Math.max(.01, 5 - p.minRating) + 5 * Math.min(1, product.reviews / 200))) : 0;
  const evidence = [history, market].filter(v => v.known), valueScore = evidence.length ? round(evidence.reduce((sum, v) => sum + v.score, 0) / evidence.length) : null;
  const qualityConfidence = validQualityData ? round(Math.min(.9, .35 + Math.log10(product.reviews + 1) / 5)) : 0;
  const confidence = round(.35 * price.confidence + .25 * (qualityPassed ? qualityConfidence : 0) + .2 * history.confidence + .2 * market.confidence);
  // Unknown bargain evidence has zero bargain contribution, not a fabricated neutral discount.
  const score = eligible ? round(.3 * qualityScore + .25 * price.score + .45 * (valueScore ?? 0)) : 0;
  const explanation = [price.valid ? `Подтверждённая цена ${product.price} ₽; источник ${price.source}.` : 'Свежая подтверждённая цена отсутствует.',
    history.known ? `Реальная история: медиана ${history.referencePrice} ₽ за ${history.distinctDays} разных дней; разница ${history.savingsPercent}%.` : `Реальная история неизвестна: ${history.reason}.`,
    market.known ? `Ограниченная выборка ${market.peers} сопоставимых товаров той же категории/типа (не весь рынок): медиана ${market.medianPrice} ₽; разница ${market.savingsPercent}%.` : `Сравнение с рынком неизвестно: ${market.reason}.`,
    'Зачёркнутая цена продавца не используется в оценке выгоды.'];
  if (variants.pricesDiffer) explanation.push(`Цена доступна только для вариантов: ${variants.availableSizesAtPrice.join(', ') || 'не подтверждено'}.`);
  if (!eligible) explanation.push(`Не подходит по обязательным проверкам: ${reasons.join(', ')}.`);
  return { eligible, score, confidence, rejectedReasons: reasons, flags, explanation, price, history, market,
    criteria: { realValue: { score: valueScore, confidence: evidence.length ? round(evidence.reduce((s, v) => s + v.confidence, 0) / evidence.length) : 0, state: evidence.length ? 'known' : 'unknown' },
      priceTrust: { score: price.score, confidence: price.confidence, state: price.valid ? 'known' : 'unverified' },
      quality: { score: qualityPassed ? qualityScore : 0, confidence: qualityConfidence,
        state: reasons.some(r => r.includes('quality') || r.includes('reviews')) ? 'rejected' : 'known', disclaimer: 'Рейтинг и отзывы — признаки, не гарантия качества.' },
      availability: { score: product.available === true && (!variants.supplied || variants.matches > 0) ? 100 : 0,
        confidence: typeof product.available === 'boolean' ? 1 : 0, state: product.available === true ? variants.supplied && !variants.matches ? 'unavailable_price_variant' : 'known' : product.available === false ? 'unavailable' : 'unknown' } },
    variant: { ...variants, variantKey: product.variantKey ?? null } };
}

/** One capture per product/variant/context/UTC day; indexed probes, never full history reads. */
export function planPriceObservation(product, { now = Date.now(), lastObservation = null, policy = {} } = {}) {
  const p = policyOf(policy), evidence = priceEvidence(product, now, p), day = epoch(now) ? new Date(now).toISOString().slice(0, 10) : null;
  const base = { due: false, reason: 'price_or_availability_unverified', observation: null,
    storagePlan: { pointLookup: 'pid + variant_key + context + day (unique indexed key)', currentLookupLimit: 1,
      historyLookup: 'pid + variant_key + context, observed_at DESC', historyLimit: p.historyLimit,
      maxPerProductVariantContextUtcDay: 1, retentionDays: p.historyRetentionDays, maxTrackedProducts: p.maxTrackedProducts,
      maxDailyWrites: p.maxTrackedProducts, maxDailyPointReadRows: p.maxTrackedProducts,
      maxDailyHistoryReadRows: p.maxTrackedProducts * p.historyLimit } };
  if (!epoch(now) || !Number.isSafeInteger(product?.id) || product.id <= 0 || !evidence.valid || product.available !== true) return base;
  const context = priceContextKey(product.context), variantKey = stableVariant(product.variantKey);
  if (!context || product.currency !== 'RUB' || !variantKey) return { ...base, reason: 'price_context_or_variant_unknown' };
  const lastAt = millis(lastObservation?.at ?? lastObservation?.observedAt);
  if (lastObservation?.id === product.id && lastObservation.variantKey === variantKey && priceContextKey(lastObservation.context) === context &&
    (lastObservation?.day === day || finite(lastAt) && new Date(lastAt).toISOString().slice(0, 10) === day)) return { ...base, reason: 'already_observed_today' };
  const variant = variantEvidence(product);
  if (variant.conditioned || conditionalPrice(product.priceCondition) || variant.supplied && !variant.matches || variant.pricesDiffer && !product.variantKey) return { ...base, reason: 'variant_or_condition_unverified' };
  return { ...base, due: true, reason: 'daily_verified_observation', observation: {
    id: product.id, day, variantKey, context, currency: 'RUB', price: product.price,
    source: product.priceSource, observedAt: millis(product.observedAt) } };
}

/** A separate cheap-discovery lane. It never changes channel policy or max price. */
export function budgetDiscovery(products = [], { budgets = [100, 200, 300], limit = 6, now = Date.now(), policy = {} } = {}) {
  const ceilings = [...new Set(budgets.filter(v => finite(v) && v > 0 && v <= 300))].sort((a, b) => a - b), seen = new Set(), rows = [];
  for (const product of (Array.isArray(products) ? products : []).slice(0, 300)) {
    if (seen.has(product?.id)) continue;
    seen.add(product?.id);
    const value = assessValue(product, { now, policy });
    if (value.eligible) rows.push({ product, value });
  }
  const cap = finite(limit) ? Math.floor(clamp(limit, 1, 30)) : 6;
  return { mode: 'budget_discovery_shadow', changesChannelPolicy: false,
    strategies: ceilings.map(maxPrice => ({ maxPrice, priceU: `0;${Math.round(maxPrice * 100)}`, sort: 'priceup' })),
    tiers: ceilings.map(maxPrice => {
      const found = rows.filter(({ product }) => product.price <= maxPrice).sort((a, b) => b.value.score - a.value.score || a.product.price - b.product.price || a.product.id - b.product.id);
      return { maxPrice, found: found.length, state: found.length ? 'verified_candidates' : 'no_verified_candidates',
        candidates: found.slice(0, cap).map(({ product, value }) => ({ id: product.id, price: product.price, valueScore: value.score,
          bargainEvidence: value.criteria.realValue.state, explanation: value.explanation })) };
    }) };
}
