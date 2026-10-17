import test from 'node:test';
import assert from 'node:assert/strict';
import { assessValue, compareCohortPrice, planPriceObservation, budgetDiscovery, priceContextKey } from './value.mjs';
const NOW = Date.parse('2026-10-11T12:00:00Z'), DAY = 86_400_000;
const CONTEXT = Object.freeze({ currency: 'RUB', destination: '-1257786', paymentBasis: 'standard' });
const card = (patch = {}) => ({ id: 100, name: 'Футболка женская', price: 200, oldPrice: 6200,
  rating: 4.7, reviews: 70, category: 'Футболки', type: 'tshirt', available: true,
  currency: 'RUB', context: CONTEXT, variantKey: 'standard', priceBasis: 'single_item', packCount: 1,
  observedAt: NOW - 1000, priceSource: 'wb_card', ...patch });
const past = (prices = [400, 400, 400]) => prices.map((price, i) => ({ price, at: NOW - (3 + i * 4) * DAY, source: 'wb_card', currency: 'RUB', context: CONTEXT, variantKey: 'standard' }));
const peers = (patch = {}) => Array.from({ length: 6 }, (_, i) => card({ id: 200 + i, price: 400 + i * 10, ...patch }));

test('struck-through seller price contributes no value without real observations', () => {
  const ordinary = assessValue(card({ oldPrice: 250 }), { now: NOW });
  const exaggerated = assessValue(card({ oldPrice: 100000 }), { now: NOW });
  assert.equal(ordinary.score, exaggerated.score);
  assert.equal(exaggerated.history.known, false);
  assert.equal(exaggerated.criteria.realValue.score, null);
  assert.ok(exaggerated.flags.includes('suspicious_seller_discount'));
  assert.ok(exaggerated.score < 60);
});
test('real daily observations establish real saving independently of seller oldPrice', () => {
  const value = assessValue(card({ history: past(), oldPrice: 205 }), { now: NOW });
  assert.equal(value.history.referencePrice, 400);
  assert.equal(value.history.savingsPercent, 50);
  assert.equal(value.history.score, 100);
  assert.equal(value.history.distinctDays, 3);
  assert.ok(value.score > assessValue(card(), { now: NOW }).score);
});
test('same-day bursts cannot fabricate a price history', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ price: 500, at: NOW - DAY - i * 1000, source: 'wb_card' }));
  assert.equal(assessValue(card({ history }), { now: NOW }).history.known, false);
});
test('future/stale/foreign/invalid observations are ignored', () => {
  const history = [
    ...past().map(row => ({ ...row, source: 'seller_claim' })),
    { price: 500, at: NOW + DAY, source: 'wb_card' },
    { price: 500, at: NOW - 100 * DAY, source: 'wb_card' },
    { price: '500', at: NOW - 10 * DAY, source: 'wb_card' },
  ];
  assert.equal(assessValue(card({ history }), { now: NOW }).history.known, false);
});
test('too-short real history stays unknown', () => {
  const history = [2, 3, 4].map(days => ({ price: 400, at: NOW - days * DAY, source: 'wb_card', currency: 'RUB', context: CONTEXT, variantKey: 'standard' }));
  assert.equal(assessValue(card({ history }), { now: NOW }).history.reason, 'history_too_short');
});
test('increasing real price has negative savings, not a fake discount', () => {
  const value = assessValue(card({ price: 500, history: past(), oldPrice: 100000 }), { now: NOW });
  assert.equal(value.history.savingsPercent, -25);
  assert.equal(value.history.score, 0);
});
test('a quality gate cannot be offset by a huge historical discount', () => {
  for (const patch of [{ rating: 1 }, { rating: 0 }, { rating: NaN }, { rating: '5' }, { reviews: 1 }, { reviews: '500' }, { reviews: -1 }, { rating: 5.1 }]) {
    const value = assessValue(card({ price: 1, history: past(), ...patch }), { now: NOW });
    assert.equal(value.eligible, false);
    assert.equal(value.score, 0);
  }
});
test('availability unknown or false cannot be outweighed by discount', () => {
  for (const available of [false, undefined, 1, 'true']) {
    assert.equal(assessValue(card({ available, history: past() }), { now: NOW }).eligible, false);
  }
});
test('price verification is strict about source, date, currency and type', () => {
  for (const patch of [{ price: '200' }, { price: NaN }, { price: 0 }, { priceSource: 'seller' }, { observedAt: NOW + 1 }, { observedAt: NOW - 2 * DAY }, { observedAt: null }, { currency: 'USD' }]) {
    assert.equal(assessValue(card(patch), { now: NOW }).eligible, false);
  }
  assert.equal(assessValue(card({ observedAt: (NOW - 1000) / 1000 }), { now: NOW }).eligible, true);
  assert.equal(assessValue(card({ observedAt: new Date(NOW - 1000).toISOString() }), { now: NOW }).eligible, true);
});
test('selected low price must exist on an available size', () => {
  const variants = [{ price: 200, size: 'XS', available: false }, { price: 600, size: 'M', available: true }];
  const value = assessValue(card({ variants }), { now: NOW });
  assert.equal(value.eligible, false);
  assert.ok(value.rejectedReasons.includes('advertised_price_has_no_available_variant'));
});
test('conditional wallet/card price requires explicit verification; no generic discount compensation', () => {
  const value = assessValue(card({ variantKey: 'M', variants: [{ price: 200, size: 'M', available: true, condition: 'WB wallet' }] }), { now: NOW });
  assert.equal(value.eligible, false);
  assert.ok(value.rejectedReasons.includes('purchase_condition_requires_verification'));
});
test('size-dependent price is disclosed; unbound history is not silently mixed', () => {
  const variants = [{ price: 200, size: 'XS', available: true }, { price: 600, size: 'M', available: true }];
  const value = assessValue(card({ variantKey: undefined, variants, history: past() }), { now: NOW });
  assert.equal(value.eligible, true);
  assert.ok(value.flags.includes('price_depends_on_size_or_variant'));
  assert.equal(value.history.reason, 'variant_not_identified');
  assert.deepEqual(value.variant.availableSizesAtPrice, ['XS']);
});
test('variant-specific history never mixes cheaper/different size', () => {
  const history = past().map(row => ({ ...row, variantKey: 'M' }));
  const value = assessValue(card({ variantKey: 'XS', history }), { now: NOW });
  assert.equal(value.history.known, false);
  const corrected = assessValue(card({ variantKey: 'M', history }), { now: NOW });
  assert.equal(corrected.history.known, true);
});
test('cohort only compares verified same-category AND same-type peers', () => {
  const comparable = compareCohortPrice(card(), peers(), { now: NOW });
  assert.equal(comparable.known, true);
  assert.equal(comparable.peers, 6);
  assert.equal(comparable.medianPrice, 425);
  for (const patch of [{ category: 'Куртки' }, { type: 'jacket' }, { available: false }, { priceSource: 'other' }, { rating: 1 }, { observedAt: NOW - 100 * DAY }]) {
    assert.equal(compareCohortPrice(card(), peers(patch), { now: NOW }).known, false);
  }
});
test('duplicate peers and self comparisons cannot manufacture a cohort', () => {
  assert.equal(compareCohortPrice(card(), Array(30).fill(card()), { now: NOW }).peers, 0);
  assert.equal(compareCohortPrice(card(), Array(30).fill(card({ id: 200 })), { now: NOW }).peers, 1);
});
test('unknown category/type cannot be compared with a generic everything cohort', () => {
  for (const patch of [{ category: 'другое' }, { type: 'unknown' }, { type: undefined }]) {
    assert.equal(compareCohortPrice(card(patch), peers(patch), { now: NOW }).known, false);
  }
});
test('different pack quantity, money basis and known audience are not comparable', () => {
  for (const patch of [{ packCount: 10 }, { priceBasis: 'per_pack' }, { audience: 'men' }]) {
    assert.equal(compareCohortPrice(card({ audience: 'women' }), peers(patch), { now: NOW }).known, false);
  }
});
test('cohort percentile handles ties and suspiciously low price confidence', () => {
  assert.equal(compareCohortPrice(card({ price: 400 }), peers({ price: 400 }), { now: NOW }).pricePercentile, 50);
  const value = compareCohortPrice(card({ price: 100 }), peers({ price: 400 }), { now: NOW });
  assert.equal(value.outlier, true);
  assert.ok(value.confidence <= .5);
});
test('budget discovery includes real <=100/200/300 candidates without restricting expensive channel candidates', () => {
  const products = [100, 200, 300, 1000].map((price, i) => card({ id: 100 + i, price }));
  const result = budgetDiscovery(products, { now: NOW });
  assert.deepEqual(result.tiers.map(t => t.found), [1, 2, 3]);
  assert.deepEqual(result.strategies.map(t => t.priceU), ['0;10000', '0;20000', '0;30000']);
  assert.equal(result.changesChannelPolicy, false);
  assert.equal(assessValue(products[3], { now: NOW }).eligible, true);
  assert.equal(result.tiers[0].candidates[0].bargainEvidence, 'unknown');
});
test('budget search honestly reports empty when cheap products fail quality or stock', () => {
  const result = budgetDiscovery([card({ price: 100, rating: 1 }), card({ price: 50, available: false })], { now: NOW });
  assert.ok(result.tiers.every(t => t.state === 'no_verified_candidates' && t.found === 0));
});
test('price observations have bounded point reads/history and one product-day write', () => {
  const plan = planPriceObservation(card(), { now: NOW });
  assert.equal(plan.due, true);
  assert.equal(plan.storagePlan.historyLimit, 28);
  assert.equal(plan.storagePlan.maxDailyPointReadRows, 300);
  assert.equal(plan.storagePlan.maxDailyHistoryReadRows, 8400);
  assert.equal(plan.storagePlan.maxDailyWrites, 300);
  assert.equal(plan.observation.day, '2026-10-11');
  assert.equal(typeof plan.observation.observedAt, 'number');
  assert.equal(planPriceObservation(card(), { now: NOW, lastObservation: { id: 100, variantKey: 'standard', context: CONTEXT, day: '2026-10-11' } }).due, false);
  assert.equal(planPriceObservation(card(), { now: NOW, lastObservation: { id: 100, variantKey: 'standard', context: CONTEXT, at: NOW - 10000 } }).due, false);
  assert.equal(planPriceObservation(card(), { now: NOW, lastObservation: { id: 100, variantKey: 'standard', context: CONTEXT, at: NOW - DAY } }).due, true);
});
test('observation planner does not record size-mixed, conditional, stale or unavailable prices', () => {
  for (const patch of [{ available: false }, { observedAt: NOW - 5 * DAY }, { priceSource: 'seller' },
    { variants: [{ size: 'XS', available: true, price: 200 }, { size: 'M', available: true, price: 500 }] },
    { variants: [{ size: 'XS', available: true, price: 200, condition: 'credit' }] }]) {
    assert.equal(planPriceObservation(card(patch), { now: NOW }).due, false);
  }
});
test('client configuration cannot turn bounded read plan into whole table reads or remove quality gates', () => {
  const policy = { historyLimit: 1e8, comparableLimit: 1e8, maxTrackedProducts: 1e8, maxPriceAgeMs: 1e20, minRating: .1, minReviews: .1 };
  const plan = planPriceObservation(card(), { now: NOW, policy });
  assert.equal(plan.storagePlan.historyLimit, 28);
  assert.equal(plan.storagePlan.maxTrackedProducts, 300);
  assert.equal(assessValue(card({ rating: 3.9, reviews: 9 }), { now: NOW, policy }).eligible, false);
});
test('input history/products are not mutated during scoring or planning', () => {
  const product = card({ history: past(), variants: [{ price: 200, available: true, size: 'M' }] });
  const snapshot = JSON.stringify(product);
  assessValue(product, { now: NOW, comparables: peers() });
  planPriceObservation(product, { now: NOW });
  budgetDiscovery([product], { now: NOW });
  assert.equal(JSON.stringify(product), snapshot);
});
test('null products and out-of-range dates deny evidence rather than crash or emit non-finite data', () => {
  assert.equal(assessValue(null, { now: NOW }).eligible, false);
  const value = assessValue(card({ observedAt: 1e30, reviews: -1 }), { now: NOW });
  assert.equal(value.price.observedAt, null);
  assert.equal(value.criteria.quality.confidence, 0);
  assert.ok(!JSON.stringify(value).includes('NaN'));
  assert.equal(planPriceObservation(card(), { now: 1e30 }).due, false);
  assert.equal(compareCohortPrice(card({ observedAt: NOW - 5 * DAY }), peers(), { now: NOW }).known, false);
});
test('a stale price does not falsely zero independent quality evidence', () => {
  const value = assessValue(card({ observedAt: NOW - 5 * DAY }), { now: NOW });
  assert.equal(value.eligible, false);
  assert.equal(value.score, 0);
  assert.equal(value.criteria.quality.state, 'known');
  assert.ok(value.criteria.quality.score > 0);
});
test('product-level payment conditions and foreign-currency history are not counted as standard price observations', () => {
  assert.equal(planPriceObservation(card({ priceCondition: 'wallet' }), { now: NOW }).due, false);
  const history = past().map(row => ({ ...row, currency: 'USD' }));
  assert.equal(assessValue(card({ history }), { now: NOW }).history.known, false);
});
test('non-string purchase conditions stay unknown and cannot masquerade as standard pricing', () => {
  for (const condition of [false, true, {}, [], 0]) {
    assert.equal(assessValue(card({ priceCondition: condition }), { now: NOW }).eligible, false);
    assert.equal(assessValue(card({ variants: [{ price: 200, available: true, condition }] }), { now: NOW }).eligible, false);
    assert.equal(compareCohortPrice(card(), peers({ priceCondition: condition }), { now: NOW }).known, false);
  }
  assert.equal(planPriceObservation(undefined, { now: NOW }).due, false);
});
test('null variant/context history cannot manufacture an observed discount', () => {
  const history = past().map(row => ({ ...row, variantKey: undefined, context: undefined }));
  const value = assessValue(card({ history, variantKey: undefined, context: undefined }), { now: NOW });
  assert.equal(value.eligible, true);
  assert.equal(value.history.known, false);
  assert.equal(value.market.known, false);
  assert.equal(value.criteria.realValue.state, 'unknown');
  assert.equal(planPriceObservation(card({ context: undefined }), { now: NOW }).due, false);
});
test('currency/destination/payment context changes cannot create fake historical savings', () => {
  for (const context of [undefined, { ...CONTEXT, currency: 'USD' }, { ...CONTEXT, destination: '-99999' }, { ...CONTEXT, paymentBasis: 'wallet' }, { currency: 'RUB', destination: '-1257786' }]) {
    const history = past().map(row => ({ ...row, context }));
    assert.equal(assessValue(card({ history }), { now: NOW }).history.known, false);
    assert.equal(compareCohortPrice(card(), peers({ context }), { now: NOW }).known, false);
  }
});
test('unknown packs or price basis do not get silently treated as one ordinary item', () => {
  for (const patch of [{ packCount: undefined }, { packCount: null }, { packCount: '1' }, { packCount: 0 }, { priceBasis: undefined }, { currency: undefined }]) {
    assert.equal(compareCohortPrice(card(patch), peers(), { now: NOW }).known, false);
    assert.equal(compareCohortPrice(card(), peers(patch), { now: NOW }).known, false);
  }
  const result = compareCohortPrice(card(), peers(), { now: NOW });
  assert.equal(result.scope, 'limited_observed_sample_not_entire_market');
});
test('context normalization is stable but only accepts explicit official price-location/payment fields', () => {
  assert.equal(priceContextKey({ paymentBasis: 'standard', destination: '-1257786', currency: 'RUB' }), priceContextKey(CONTEXT));
  assert.equal(priceContextKey(JSON.stringify(CONTEXT)), priceContextKey(CONTEXT));
  assert.equal(priceContextKey('legacy_default'), null);
  assert.equal(priceContextKey({ ...CONTEXT, destination: 'unknown' }), null);
  assert.equal(priceContextKey({ ...CONTEXT, paymentBasis: 'unknown' }), null);
});
test('daily capture idempotency scopes the full pid/variant/context/day key', () => {
  const observation = planPriceObservation(card(), { now: NOW }).observation;
  assert.equal(planPriceObservation(card(), { now: NOW, lastObservation: observation }).due, false);
  assert.equal(planPriceObservation(card({ variantKey: 'M' }), { now: NOW, lastObservation: observation }).due, true);
  assert.equal(planPriceObservation(card({ context: { ...CONTEXT, destination: '-9999' } }), { now: NOW, lastObservation: observation }).due, true);
});
