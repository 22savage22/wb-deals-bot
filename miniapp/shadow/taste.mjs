// Offline, data-only taste calibration. No Telegram, D1, AI or production wiring.
// The caller MUST resolve products/traits from its trusted server-side dataset;
// booleans below are attestations, never authentication or client permissions.
import {COMMON, SPECIFIC, GROUPS} from '../cloudflare/visual_features.mjs';

export const TASTE_VERSION = 1;
export const TASTE_PROFILES = ['owner', 'wife', 'audience'];
export const TASTE_ACTIONS = ['like', 'dislike', 'more', 'block_similar'];
export const TASTE_DEFAULTS = {minSamples: 5, minFeatureSamples: 3, calibrationSize: 24};
export const TASTE_RETENTION = {personalMax: 100, audienceMax: 100, personalRetentionMs: 90 * 86400000, audienceRetentionMs: 30 * 86400000};
const weights = {like: 1, dislike: -1, more: 2, block_similar: -2};
const person = {owner: 'local-owner', wife: 'local-wife'};
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const idOf = product => Number(product?.id ?? product?.nmId ?? product?.pid);
const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Number(value.toFixed(4));
const label = value => typeof value === 'string' && value.trim() && value.length <= 100 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;

export function createTasteState() {
  return {version: TASTE_VERSION, ratings: [], audience: [], updatedAt: null};
}

function checkState(state) {
  if (!plain(state) || state.version !== TASTE_VERSION || !Array.isArray(state.ratings) || !Array.isArray(state.audience)) throw Error('TASTE_INVALID_STATE');
}

// Server may call on reads as well as writes. Return-only: no background timer,
// disk access or production migration; discarded snapshots contain no raw photos.
export function trimTasteState(state, {now = Date.now(), ...options} = {}) {
  checkState(state);
  const config = {...TASTE_RETENTION, ...options};
  if (!Number.isSafeInteger(now) || now <= 0 || ![config.personalMax, config.audienceMax].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 100) || ![config.personalRetentionMs, config.audienceRetentionMs].every(n => Number.isSafeInteger(n) && n >= 86400000 && n <= 365 * 86400000)) throw Error('TASTE_INVALID_RETENTION');
  const current = (row, age) => Number.isSafeInteger(row.ts) && row.ts > 0 && row.ts <= now && now - row.ts <= age;
  const newest = (rows, cap) => {
    const keep = new Set(rows.map((row, index) => ({row, index})).sort((a, b) => b.row.ts - a.row.ts || b.index - a.index).slice(0, cap).map(entry => entry.index));
    // Preserve insertion order: otherwise equal-millisecond ratings reverse on
    // every trim, eventually retaining an old entry instead of the newest one.
    return rows.filter((row, index) => keep.has(index));
  };
  const ratings = Object.keys(person).flatMap(profile => newest(state.ratings.filter(row => row.profile === profile && row.participant_id === person[profile] && current(row, config.personalRetentionMs)), config.personalMax));
  const audience = newest(state.audience.filter(row => current(row, config.audienceRetentionMs)), config.audienceMax);
  const removed = {personal: state.ratings.length - ratings.length, audience: state.audience.length - audience.length};
  if (!removed.personal && !removed.audience) return {state, changed: false, removed};
  return {state: {...clone(state), ratings: clone(ratings), audience: clone(audience), updatedAt: now}, changed: true, removed};
}

export function priceBand(price) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (price <= 100) return '0–100 ₽';
  if (price <= 200) return '100–200 ₽';
  if (price <= 300) return '200–300 ₽';
  if (price <= 600) return '300–600 ₽';
  if (price <= 1000) return '600–1000 ₽';
  if (price <= 2000) return '1000–2000 ₽';
  if (price <= 5000) return '2000–5000 ₽';
  return '5000+ ₽';
}

export function tasteFeatures(product, traits, {now = Date.now(), maxPriceAgeMs = 86400000} = {}) {
  if (!plain(product) || !validId(idOf(product))) throw Error('TASTE_INVALID_PRODUCT');
  const features = {};
  const category = label(product.category ?? product.cat);
  if (product.categoryVerified !== false && category && !['unknown', 'неизвестно'].includes(category.toLowerCase())) features[`category=${category}`] = 1;
  // Confirmed catalog price, never crossed-out price, title, or estimated image price.
  const price = product.price ?? product.product ?? product.current_price;
  const observedAt = product.observedAt;
  if (Number.isFinite(price) && price > 0 && Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now && now - observedAt <= maxPriceAgeMs) features[`budget=${priceBand(price)}`] = 1;
  // Cached AI confidence is not evidence of human review. BOTH checks required.
  const visualAccepted = plain(traits) && traits.reviewed === true && traits.cacheVerified === true && GROUPS.includes(traits.group) && plain(traits.fields);
  if (visualAccepted) {
    const allowed = {...COMMON, ...SPECIFIC[traits.group]};
    for (const [key, field] of Object.entries(traits.fields).slice(0, 24)) {
      if (!Object.hasOwn(allowed, key) || !plain(field) || !allowed[key].includes(field.value) || !Number.isFinite(field.confidence) || field.confidence < .8 || field.confidence > 1 || typeof field.evidence !== 'string' || field.evidence.trim().length < 5) continue;
      if (['print_size', 'print_location'].includes(key) && traits.fields.pattern?.value === 'solid') continue;
      if (key === 'print_location' && ['back', 'front_and_back'].includes(field.value) && traits.backReviewed !== true) continue;
      features[`visual.${key}=${field.value}`] = 1;
    }
    if (Object.keys(features).some(key => key.startsWith('visual.'))) features[`visual.group=${traits.group}`] = 1;
  }
  return features;
}

// Return {state, changed}; immutable upsert by (profile, local participant, nmId).
// Repeating an identical rating is a no-op, NOT a toggle. Undo is explicit.
export function setTasteRating(state, input, {now = Date.now()} = {}) {
  checkState(state);
  if (!plain(input) || !Object.hasOwn(person, input.profile) || !validId(input.nmId) || ![...TASTE_ACTIONS, 'undo'].includes(input.action)) throw Error('TASTE_INVALID_RATING');
  const participant_id = input.participant_id ?? person[input.profile];
  if (participant_id !== person[input.profile]) throw Error('TASTE_INVALID_PARTICIPANT');
  if (!Number.isSafeInteger(now) || now <= 0) throw Error('TASTE_INVALID_TIME');
  const trimmed = trimTasteState(state, {now});
  state = trimmed.state;
  const nmId = Number(input.nmId);
  const index = state.ratings.findIndex(row => row.profile === input.profile && row.participant_id === participant_id && row.nmId === nmId);
  const previous = index >= 0 ? state.ratings[index] : null;
  if (input.action === 'undo') {
    if (!previous) return {state, changed: trimmed.changed};
    const next = clone(state);
    next.ratings.splice(index, 1);
    next.updatedAt = now;
    return {state: next, changed: true};
  }
  if (!plain(input.product) || idOf(input.product) !== nmId) throw Error('TASTE_PRODUCT_ID_MISMATCH');
  if (previous?.action === input.action) return {state, changed: trimmed.changed};
  const features = tasteFeatures(input.product, input.traits, {now});
  const next = clone(state);
  const record = {profile: input.profile, participant_id, nmId, action: input.action, features, ts: now};
  if (index >= 0) next.ratings[index] = record;
  else next.ratings.push(record);
  next.updatedAt = now;
  return {state: trimTasteState(next, {now}).state, changed: true};
}

// Independent adapter for already persisted channel aggregates, not synthetic users.
// Counts replace a snapshot per nmId; rerunning an import never doubles feedback.
export function setAudienceSignals(state, input, {now = Date.now()} = {}) {
  checkState(state);
  if (!plain(input) || !validId(input.nmId) || !plain(input.product) || idOf(input.product) !== Number(input.nmId)) throw Error('TASTE_INVALID_AUDIENCE_PRODUCT');
  const counts = Object.fromEntries(['likes', 'dislikes', 'bought'].map(key => [key, input[key] ?? 0]));
  if (!Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000)) throw Error('TASTE_INVALID_COUNTS');
  if (!Number.isSafeInteger(now) || now <= 0) throw Error('TASTE_INVALID_TIME');
  const trimmed = trimTasteState(state, {now});
  state = trimmed.state;
  const nmId = Number(input.nmId), index = state.audience.findIndex(row => row.nmId === nmId);
  const old = index >= 0 ? state.audience[index] : null;
  if (old && Object.entries(counts).every(([key, value]) => old[key] === value)) return {state, changed: trimmed.changed};
  const next = clone(state);
  const row = {nmId, ...counts, features: tasteFeatures(input.product, input.traits, {now}), ts: now};
  if (index >= 0) next.audience[index] = row;
  else next.audience.push(row);
  next.updatedAt = now;
  return {state: trimTasteState(next, {now}).state, changed: true};
}

function limits(options) {
  const result = {...TASTE_DEFAULTS, ...options};
  if (![result.minSamples, result.minFeatureSamples].every(n => Number.isSafeInteger(n) && n >= 3 && n <= 100)) throw Error('TASTE_INVALID_SAMPLE_LIMIT');
  return result;
}

function rowsFor(state, profile) {
  if (profile === 'audience') return state.audience.filter(row => row.likes + row.dislikes + row.bought > 0).map(row => ({...row, positive: row.likes + 1.2 * row.bought, negative: row.dislikes, events: row.likes + row.dislikes + row.bought}));
  return state.ratings.filter(row => row.profile === profile && row.participant_id === person[profile]).map(row => ({...row, positive: Math.max(0, weights[row.action]), negative: Math.max(0, -weights[row.action]), events: 1}));
}

export function buildTasteProfile(state, profile, options = {}) {
  checkState(state);
  if (!TASTE_PROFILES.includes(profile)) throw Error('TASTE_INVALID_PROFILE');
  const config = limits(options), rows = rowsFor(state, profile), stats = new Map();
  for (const row of rows) for (const key of Object.keys(row.features)) {
    const stat = stats.get(key) ?? {key, products: 0, positive: 0, negative: 0, events: 0, nmIds: []};
    stat.products++;
    stat.positive += row.positive;
    stat.negative += row.negative;
    stat.events += row.events;
    stat.nmIds.push(row.nmId);
    stats.set(key, stat);
  }
  const configured = rows.length >= config.minSamples;
  const evidence = Array.from(stats.values(), stat => ({...stat, preference: round((stat.positive - stat.negative) / (stat.positive + stat.negative + 4)), sufficient: configured && stat.products >= config.minFeatureSamples}));
  evidence.sort((a, b) => b.preference - a.preference || b.products - a.products || a.key.localeCompare(b.key));
  const accepted = evidence.filter(row => row.sufficient);
  const preferred = accepted.filter(row => row.preference > 0).slice(0, 12);
  const avoided = accepted.filter(row => row.preference < 0).sort((a, b) => a.preference - b.preference).slice(0, 12);
  const unknown = ['category', 'budget', 'style', 'fit', 'pattern', 'color', 'silhouette'].filter(dimension => !accepted.some(row => row.key.startsWith(dimension === 'category' || dimension === 'budget' ? dimension + '=' : 'visual.' + dimension + '=')));
  return {
    version: TASTE_VERSION, profile, configured, sampleProducts: rows.length,
    feedbackEvents: rows.reduce((sum, row) => sum + row.events, 0),
    lastRatingAt: rows.length ? Math.max(...rows.map(row => row.ts)) : null,
    minimumSamples: config.minSamples, minimumFeatureSamples: config.minFeatureSamples,
    progress: {rated: rows.length, target: config.calibrationSize},
    preferred, avoided, evidence, unknown,
    blockedProducts: profile === 'audience' ? [] : rows.filter(row => row.action === 'block_similar').map(row => row.nmId),
    blockedExamples: profile === 'audience' ? [] : rows.filter(row => row.action === 'block_similar').map(row => ({nmId: row.nmId, features: {...row.features}})),
    uncertainty: !rows.length ? 'not_configured' : !configured ? 'insufficient_ratings' : 'small_sample',
    note: !rows.length ? 'Предпочтения ещё не настроены: нет настоящих оценок.' : !configured ? `Пока мало оценок: ${rows.length}/${config.minSamples}. Вкус не угадывается.` : 'Предпочтения основаны только на ваших оценках. Это не прогноз вероятности покупки; субъективные признаки остаются неизвестными без проверенного профиля.',
  };
}

function blockedSimilarity(examples, features) {
  const category = Object.keys(features).find(key => key.startsWith('category='));
  if (!category) return null;
  const structural = new Set(['pattern', 'silhouette', 'fit', 'style']);
  const visualMap = values => new Map(Object.keys(values).filter(key => key.startsWith('visual.') && !key.startsWith('visual.group=')).map(key => {
    const separator = key.indexOf('=');
    return [key.slice(7, separator), key.slice(separator + 1)];
  }));
  const target = visualMap(features);
  for (const example of examples) {
    if (!example.features[category]) continue;
    const source = visualMap(example.features), matched = [], conflicts = [];
    for (const [field, value] of source) if (target.has(field)) (target.get(field) === value ? matched : conflicts).push(field);
    // An explicit restriction may act before learned taste has enough samples.
    // It is narrow: colors/category alone cannot remove a whole category.
    if (matched.length >= 3 && matched.filter(field => structural.has(field)).length >= 2 && !conflicts.some(field => structural.has(field)) && matched.length / (matched.length + conflicts.length) >= .8) return {nmId: example.nmId, matchingFields: matched, agreement: round(matched.length / (matched.length + conflicts.length))};
  }
  return null;
}

export function scoreTaste(profile, product, {traits, now = Date.now()} = {}) {
  if (!plain(profile) || profile.version !== TASTE_VERSION || !TASTE_PROFILES.includes(profile.profile)) throw Error('TASTE_INVALID_PROFILE');
  const features = tasteFeatures(product, traits, {now}), keys = new Set(Object.keys(features));
  const matched = profile.evidence.filter(row => row.sufficient && keys.has(row.key));
  // A popularity count is not 100 independent observations of a trait: support
  // above is the number of distinct rated products, including for the audience.
  const active = profile.configured && matched.length > 0;
  const score = active ? round(matched.reduce((sum, row) => sum + row.preference, 0) / matched.length) : 0;
  const exactBlocked = profile.blockedProducts.includes(idOf(product));
  const similar = exactBlocked ? null : blockedSimilarity(profile.blockedExamples ?? [], features);
  const blocked = exactBlocked || !!similar;
  return {score, configured: profile.configured, supported: active, blocked, blockReason: exactBlocked ? 'explicit_product' : similar ? 'explicit_reviewed_similarity' : null, blockEvidence: similar,
    sampleProducts: profile.sampleProducts, matchedFeatures: matched.map(row => ({key: row.key, preference: row.preference, products: row.products, nmIds: row.nmIds})),
    uncertainty: !profile.configured ? profile.uncertainty : !active ? 'no_matching_evidence' : 'small_sample',
    reason: exactBlocked ? 'Вы явно попросили не показывать этот товар. Похожесть без проверенных признаков не угадывается.' : similar ? `Похож на явно заблокированный товар ${similar.nmId}: одна категория и ${similar.matchingFields.length} проверенных визуальных совпадения, включая минимум два структурных.` : !profile.configured ? profile.note : !active ? 'Нет достаточных оценок похожих подтверждённых признаков; нейтральный вклад.' : 'Совпали признаки реально оценённых товаров; учитывается объём выборки, а не придумывается ваш вкус.'};
}

function photoOf(product) {
  const candidate = product.image ?? product.photo ?? product.images?.[0];
  if (typeof candidate !== 'string') return null;
  try { const url = new URL(candidate); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? candidate : null; } catch { return null; }
}

// Deterministic balanced sample for a real-photo calibration, never fake cards.
// Diversity uses confirmed metadata, NOT inferred style from titles/photos.
export function selectCalibrationProducts(products, {size = TASTE_DEFAULTS.calibrationSize} = {}) {
  if (!Array.isArray(products) || !Number.isSafeInteger(size) || size < 20 || size > 30) throw Error('TASTE_INVALID_CALIBRATION_SIZE');
  const unique = new Map();
  for (const product of products) if (plain(product) && validId(idOf(product)) && photoOf(product) && !unique.has(idOf(product))) unique.set(idOf(product), product);
  const groups = new Map();
  for (const product of unique.values()) {
    // A historical search topic can balance the photo sample; it is NEVER a
    // learned product category when the adapter says metadata is unverified.
    const key = (product.categoryVerified === false ? null : label(product.category ?? product.cat)) ?? label(product.historicalTopic) ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(product);
  }
  const buckets = Array.from(groups).sort(([a], [b]) => a.localeCompare(b)).map(([, list]) => list.sort((a, b) => idOf(a) - idOf(b)));
  const selected = [];
  while (selected.length < size && buckets.some(list => list.length)) for (const list of buckets) if (list.length && selected.length < size) selected.push(list.shift());
  return {products: selected, requested: size, available: unique.size, shortfall: Math.max(0, size - selected.length), note: selected.length < size ? `Есть только ${selected.length} разных товаров с настоящими фото; недостающие карточки не выдумываются.` : 'Настоящие фото, категории чередуются; оценки владельца и жены сохраняются отдельно.'};
}
