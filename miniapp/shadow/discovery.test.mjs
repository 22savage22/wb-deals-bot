import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_TOPICS, normalizeWBCard as rawNormalizeWBCard, planDiscovery, nextDiscoveryState, shadowRetryAfter, fetchShadowBatch, createShadowDiscovery } from './discovery.mjs';
const NOW = Date.parse('2026-10-11T12:00:00Z'), M = 60_000;
const CONTEXT = { currency: 'RUB', destination: '-1257786', paymentBasis: 'unknown', spp: '30' };
const normalizeWBCard = (card, options = {}) => rawNormalizeWBCard(card, { context: CONTEXT, ...options });
const detail = (products, context = CONTEXT) => ({ products, context });
const card = (id = 100, patch = {}) => ({ id, name: `Товар ${id}`, subjectName: 'Футболки', brand: 'Brand', reviewRating: 4.8, feedbacks: 40,
  sizes: [{ chrtId: 10001 + id, name: 'M', qty: 2, price: { product: 19900, basic: 620000 } }], ...patch });
const source = (rows = [card()]) => ({ readOnly: true, search: async () => ({ products: rows }), cards: async ids => detail(rows.filter(c => ids.includes(c.id))) });
test('no default network source and read-only adapter contract enforced', () => {
  assert.throws(() => createShadowDiscovery(undefined), /READ_ONLY/);
  assert.throws(() => createShadowDiscovery({ search() {}, cards() {} }), /READ_ONLY/);
});
test('normalization chooses stocked variant, not cheapest unavailable size', () => {
  const c = normalizeWBCard(card(100, { sizes: [
    { chrtId: 1, name: 'XS', qty: 0, price: { product: 100, basic: 10000000 } },
    { chrtId: 2, name: 'M', qty: 2, price: { product: 19990, basic: 620000 } },
  ] }), { now: NOW });
  assert.equal(c.price, 199.9); assert.equal(c.variantKey, '2'); assert.equal(c.available, true);
  assert.equal(c.oldPrice, 6200); assert.equal(c.sellerDiscountIsEvidence, false);
  assert.equal(c.priceSource, 'wb_card'); assert.equal(c.observedAt, NOW); assert.equal(c.currency, 'RUB');
});
test('stock evidence accepts positive qty or stocks, never infers unknown stock', () => {
  const stocks = card(100, { sizes: [{ chrtId: 7, price: { product: 10000 }, stocks: [{ qty: 2 }] }] });
  assert.equal(normalizeWBCard(stocks, { now: NOW }).available, true);
  const unknown = card(100, { sizes: [{ chrtId: 7, price: { product: 10000 } }] });
  assert.equal(normalizeWBCard(unknown, { now: NOW }), null);
  assert.equal(normalizeWBCard(unknown, { now: NOW, allowUnknownStock: true }).available, null);
  assert.equal(normalizeWBCard(card(100, { sizes: [{ price: { product: 10000 }, qty: 0, stocks: [{ qty: 2 }] }] }), { now: NOW }), null);
});
test('malformed IDs, prices, foreign currency, deleted cards remain invalid', () => {
  for (const patch of [{ id: '100' }, { name: '' }, { sizes: [] }, { sizes: [{ qty: 1, price: { product: '10000' } }] }, { sizes: [{ qty: 1, price: { product: -1 } }] }]) assert.equal(normalizeWBCard(card(100, patch), { now: NOW }), null);
  assert.equal(normalizeWBCard(card(), { now: NOW, context: { curr: 'usd' } }), null);
});
test('variant conditions and destination context are preserved, not guessed', () => {
  const c = normalizeWBCard(card(100, { sizes: [{ name: 'L', qty: 1, price: { product: 10000, condition: 'WB wallet' } }] }), { now: NOW, context: { curr: 'rub', dest: '-1', spp: '20' } });
  assert.equal(c.priceCondition, 'WB wallet'); assert.deepEqual(c.priceContext, { curr: 'rub', dest: '-1', spp: '20' });
  assert.equal(c.context.paymentBasis, 'unknown');
  assert.equal(c.type, 'unknown'); assert.equal(c.priceBasis, undefined); assert.equal(c.packCount, undefined);
  const explicit = normalizeWBCard(card(100, { type: 'tshirt', priceBasis: 'pack', packCount: 2 }), { now: NOW, context: { ...CONTEXT, paymentBasis: 'standard' } });
  assert.equal(explicit.variants[0].condition, 'standard');
  assert.equal(explicit.priceBasis, 'pack'); assert.equal(explicit.packCount, 2);
});
test('rotation includes electronics and cosmetics without legacy category exclusions', () => {
  const categories = Array.from({ length: 8 }, (_, cursor) => planDiscovery({ cursor }, {}, NOW).category);
  assert.deepEqual(categories, DISCOVERY_TOPICS.map(t => t.category));
  assert.ok(categories.includes('electronics')); assert.ok(categories.includes('cosmetics'));
});
test('existing topics add a lane without overwriting default category rotation', () => {
  const p = planDiscovery({ cursor: 8 }, { existingTopics: ['Худи', 'Лонгслив'] }, NOW);
  assert.equal(p.category, 'configured'); assert.equal(p.query, 'Худи');
  assert.equal(planDiscovery({ cursor: 17 }, { existingTopics: ['Худи', 'Лонгслив'] }, NOW).query, 'Лонгслив');
});
test('ultra-budget rotates <=100/200/300 independently of channel ceiling', () => {
  const ceilings = [3, 7, 11].map(cursor => planDiscovery({ cursor }, { maxPrice: 50 }, NOW).priceCeiling);
  assert.deepEqual(ceilings, [100, 200, 300]);
  assert.equal(planDiscovery({}, {}, NOW).priceCeiling, null);
});
test('one operation per20min by default, never perminute, minimum gap5min', () => {
  const admitted = planDiscovery({}, {}, NOW).state;
  assert.equal(planDiscovery(admitted, {}, NOW + 19 * M).due, false);
  assert.equal(planDiscovery(admitted, {}, NOW + 20 * M).due, true);
  assert.equal(planDiscovery(planDiscovery({}, { intervalMinutes: 0 }, NOW).state, { intervalMinutes: 0 }, NOW + M).due, false);
});
test('stale lease expires; live lease is not bypassed', () => {
  assert.equal(planDiscovery({ leaseUntil: NOW + M }, {}, NOW).reason, 'lease_busy');
  assert.equal(planDiscovery({ leaseUntil: NOW - 1 }, {}, NOW).due, true);
});
test('Retry-After seconds/date and exponential jitter persist backoff', () => {
  assert.equal(shadowRetryAfter('60', NOW), M);
  assert.equal(shadowRetryAfter(new Date(NOW + 2 * M).toUTCString(), NOW), 2 * M);
  const first = nextDiscoveryState({}, { status: 429, retryAfter: '1800' }, NOW, () => 0);
  assert.equal(first.retryAt, NOW + 30 * M);
  const next = nextDiscoveryState({ failures: 4 }, { status: 429 }, NOW, () => 1);
  assert.equal(next.retryAt - NOW, 100 * M); assert.equal(next.failures, 5);
  assert.equal(planDiscovery(first, {}, NOW + M).reason, 'backoff');
});
test('successful recovery clears failures but retains normal schedule', () => {
  const admitted = planDiscovery({ failures: 3 }, {}, NOW).state;
  const s = nextDiscoveryState(admitted, { ok: true }, NOW);
  assert.equal(s.failures, 0); assert.equal(s.retryAt, 0); assert.equal(s.leaseUntil, 0);
  assert.equal(s.nextSearch, NOW + 20 * M);
});
test('search response capped100, detail request capped20, known/title exclusions first', async () => {
  const rows = Array.from({ length: 140 }, (_, i) => card(i + 1)); let requested;
  const client = source(rows); client.cards = async ids => { requested = ids; return detail(rows.filter(c => ids.includes(c.id))); };
  const r = await fetchShadowBatch(client, { now: NOW, knownIds: new Set([1, '2']), knownTitles: ['Товар 3'] });
  assert.equal(r.receipt.found, 100); assert.equal(requested.length, 20); assert.equal(requested[0], 4);
  assert.equal(r.products.length, 20); assert.equal(r.receipt.calls, 2); assert.equal(r.receipt.rejected.known, 2);
});
test('details cannot substitute unrequested or duplicate cards', async () => {
  const client = source(); client.cards = async () => detail([card(999), card(), card()]);
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.deepEqual(r.products.map(p => p.id), [100]); assert.equal(r.receipt.rejected.malformed, 2);
});
test('local budget is authoritative when source ignores or lacks price filter', async () => {
  const client = source([card(100, { sizes: [{ qty: 1, price: { product: 99900 } }] })]); let params;
  const original = client.search; client.search = async p => { params = p; return original(); };
  const r = await fetchShadowBatch(client, { now: NOW, state: { cursor: 3 }, config: { maxPrice: 50 } });
  assert.equal(params.priceU, undefined); assert.equal(r.receipt.priceCeiling, 100); assert.equal(r.products.length, 0); assert.equal(r.receipt.rejected.budget, 1);
});
test('only explicitly supported source receives priceU', async () => {
  const client = source(); client.supportsPriceFilter = true; let params;
  client.search = async p => { params = p; return { products: [] }; };
  await fetchShadowBatch(client, { now: NOW, config: { maxPrice: 300 } });
  assert.equal(params.priceU, '0;30000');
});
test('429 makes exactlyone search request and no cards/retry/burst', async () => {
  const client = source(); let calls = 0;
  client.search = async () => { calls++; throw Object.assign(Error('Secret raw response must not escape'), { status: 429, retryAfter: '3600' }); };
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.receipt.error, 'WB_HTTP_429'); assert.equal(calls, 1); assert.equal(r.receipt.calls, 1);
  const follow = await fetchShadowBatch(client, { now: NOW + M, state: r.state });
  assert.equal(follow.receipt.reason, 'backoff'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(r).includes('Secret'));
});
test('failed cards request discards whole batch safely and doesnotretry', async () => {
  const client = source(); client.cards = async () => { throw Object.assign(Error('raw'), { status: 503 }); };
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.products.length, 0); assert.equal(r.receipt.calls, 2); assert.equal(r.receipt.error, 'WB_HTTP_503');
});
test('HTTP error returned as a response also honors429 cooldown without retry', async () => {
  const client = source();
  client.search = async () => new Response('raw private error', { status: 429, headers: { 'Retry-After': '1800' } });
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.receipt.calls, 1); assert.equal(r.receipt.error, 'WB_HTTP_429');
  assert.equal(r.state.nextSearch, NOW + 30 * M);
  assert.ok(!JSON.stringify(r).includes('private'));
});
test('missing detail cards count as invalid; current provenance doesnotcreatepack/type facts', async () => {
  const client = source([card(1), card(2)]); client.cards = async () => detail([card(1)]);
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.receipt.rejected.invalidCard, 1); assert.equal(r.products.length, 1);
  assert.equal(r.products[0].type, 'unknown'); assert.equal(r.products[0].priceBasis, undefined);
  assert.deepEqual(r.products[0].context, { currency: 'RUB', destination: '-1257786', paymentBasis: 'unknown' });
});
test('malformed search and details are safely rejected without raw output', async () => {
  const client = source(); client.search = async () => ({ unexpected: 'token must not escape' });
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.receipt.error, 'INVALID_RESPONSE'); assert.equal(r.receipt.calls, 1);
  client.search = async () => ({ products: [null, {}, card()] }); client.cards = async () => ({ data: { broken: [] } });
  const r2 = await fetchShadowBatch(client, { now: NOW + 20 * M }); assert.equal(r2.receipt.error, 'INVALID_RESPONSE');
});
test('concurrent clients sharing one source cannot run parallel operations', async () => {
  const client = source(); let release, calls = 0;
  client.search = async () => { calls++; return await new Promise(resolve => { release = resolve; }); };
  const first = fetchShadowBatch(client, { now: NOW });
  await new Promise(resolve => setImmediate(resolve));
  const second = await fetchShadowBatch(client, { now: NOW });
  assert.equal(second.receipt.reason, 'source_busy'); assert.equal(calls, 1);
  release({ products: [] }); assert.equal((await first).receipt.result, 'success');
});
test('atomic staging admission must succeed before any external operation', async () => {
  const client = source(); let calls = 0; client.search = async () => { calls++; return []; };
  const r = await fetchShadowBatch(client, { now: NOW, onAdmission: async admitted => { assert.equal(admitted.lastAttempt, NOW); assert.equal(admitted.leaseUntil, NOW + M); return false; } });
  assert.equal(calls, 0); assert.equal(r.receipt.error, 'ADMISSION_FAILED');
});
test('unknown slow-source outcome stops, holds shared slot, and leaks no raw error', async () => {
  const client = source(); let release;
  client.search = () => new Promise(resolve => { release = resolve; });
  const r = await fetchShadowBatch(client, { now: NOW, config: { timeoutMs: 10 } });
  assert.equal(r.receipt.error, 'TIMEOUT'); assert.equal(r.products.length, 0);
  assert.equal((await fetchShadowBatch(client, { now: NOW + 20 * M })).receipt.reason, 'source_busy');
  release({ products: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetchShadowBatch(client, { now: NOW + M, state: r.state })).receipt.reason, 'backoff');
});
test('batch rejects insufficient rating/reviews instead of weakening ultra-budget quality', async () => {
  const client = source([card(1, { reviewRating: 3.9 }), card(2, { feedbacks: 0 }), card(3)]);
  const r = await fetchShadowBatch(client, { now: NOW }); assert.deepEqual(r.products.map(p => p.id), [3]);
  assert.equal(r.receipt.rejected.rating, 1); assert.equal(r.receipt.rejected.reviews, 1);
});
test('fetched current cards supply value/taste common input shape', async () => {
  const r = await fetchShadowBatch(source(), { now: NOW });
  const c = r.products[0]; assert.equal(c.price, 199); assert.equal(c.reviews, 40);
  assert.equal(c.title, c.name); assert.equal(c.pid, c.id); assert.equal(c.priceSource, 'wb_card');
  assert.equal(r.receipt.nextSearch, NOW + 20 * M); assert.equal(r.receipt.mode, 'SHADOW');
});
test('normalizer never invents missing currency or destination evidence', () => {
  assert.equal(rawNormalizeWBCard(card(), { now: NOW }), null);
  assert.equal(rawNormalizeWBCard(card(), { now: NOW, context: { paymentBasis: 'standard' } }), null);
  assert.equal(rawNormalizeWBCard(card(), { now: NOW, context: { curr: 'rub' } }), null);
  assert.equal(rawNormalizeWBCard(card(), { now: NOW, context: { dest: '-1257786' } }), null);
});
test('cards adapter receives explicit current price parameters and reports actual context', async () => {
  const client = source(); let actual;
  client.cards = async (ids, options) => {
    actual = options;
    return detail([card()], { currency: options.params.curr.toUpperCase(), destination: options.params.dest, paymentBasis: 'standard', spp: options.params.spp });
  };
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.deepEqual(actual.params, { appType: '1', curr: 'rub', dest: '-1257786', spp: '30', lang: 'ru' });
  assert.equal(actual.signal instanceof AbortSignal, true);
  assert.equal(r.products[0].context.paymentBasis, 'standard');
  assert.equal(r.receipt.cardsValidated, 1); assert.equal(r.receipt.newValidProducts, 1);
  assert.equal(r.receipt.publicationApprovedProducts, 0);
});
test('missing or mismatched adapter detail context stops without fictional provenance', async () => {
  for (const context of [undefined, { currency: 'USD', destination: '-1257786' }, { currency: 'RUB', destination: '-1' }, { currency: 'RUB' }]) {
    const client = source(); client.cards = async () => ({ products: [card()], ...(context ? { context } : {}) });
    const r = await fetchShadowBatch(client, { now: NOW });
    assert.equal(r.receipt.error, 'INVALID_CONTEXT'); assert.equal(r.products.length, 0);
    assert.equal(r.receipt.calls, 2);
  }
});
test('missing stable size ID stays unknown under reordering, never becomes index or size-name key', () => {
  const first = { name: 'M', qty: 2, price: { product: 10000 } }, second = { name: 'S', qty: 2, price: { product: 20000 } };
  for (const sizes of [[first, second], [second, first]]) {
    const c = normalizeWBCard(card(100, { sizes }), { now: NOW });
    assert.equal(c.variantKey, 'unknown'); assert.equal(c.price, 100); assert.equal(c.variants.every(v => v.variantKey === 'unknown'), true);
  }
  const identified = normalizeWBCard(card(100, { sizes: [{ ...first, sizeId: 123 }] }), { now: NOW });
  assert.equal(identified.variantKey, '123');
});
test('validated cards with unknown payment basis are not counted as fully identified value inputs', async () => {
  const r = await fetchShadowBatch(source(), { now: NOW, config: { priceContext: { paymentBasis: 'standard' } } });
  assert.equal(r.products.length, 1); assert.equal(r.products[0].context.paymentBasis, 'unknown');
  assert.equal(r.receipt.cardsValidated, 1); assert.equal(r.receipt.newValidProducts, 0);
  assert.equal(r.receipt.valueContextKnownProducts, 0); assert.equal(r.receipt.publicationApprovedProducts, 0);
  assert.equal(r.receipt.validationScope, 'discovery_cards_only_not_publication_approval');
});
test('conditional wallet price is identified but not called a standard valid value candidate', async () => {
  const client = source(); client.cards = async () => detail([card()], { ...CONTEXT, paymentBasis: 'wallet' });
  const r = await fetchShadowBatch(client, { now: NOW });
  assert.equal(r.receipt.cardsValidated, 1); assert.equal(r.receipt.valueContextKnownProducts, 1);
  assert.equal(r.receipt.newValidProducts, 0); assert.equal(r.products[0].priceCondition, 'wallet');
});
test('separate clients cannot erase same-source admission gap using stale or omitted state', async () => {
  const client = source(); let calls = 0;
  const original = client.search; client.search = async p => { calls++; return original(p); };
  const first = await fetchShadowBatch(client, { now: NOW }); assert.equal(first.receipt.result, 'success');
  for (const state of [undefined, {}, { nextSearch: 0, lastAttempt: 0 }]) {
    const r = await createShadowDiscovery(client).fetchShadowBatch({ now: NOW + M, state });
    assert.equal(r.receipt.reason, 'not_due'); assert.equal(calls, 1);
  }
  const next = await fetchShadowBatch(client, { now: NOW + 20 * M });
  assert.equal(next.receipt.result, 'success'); assert.equal(calls, 2);
});
test('429 same-source cooldown cannot be bypassed by omitting persistent state', async () => {
  const client = source(); let calls = 0;
  client.search = async () => { calls++; throw Object.assign(Error('raw'), { status: 429, retryAfter: '3600' }); };
  await fetchShadowBatch(client, { now: NOW });
  const r = await fetchShadowBatch(client, { now: NOW + 20 * M });
  assert.equal(r.receipt.reason, 'backoff'); assert.equal(calls, 1);
});
