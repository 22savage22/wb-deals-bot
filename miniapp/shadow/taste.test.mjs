import test from 'node:test';
import assert from 'node:assert/strict';
import {createTasteState, setTasteRating, setAudienceSignals, buildTasteProfile, scoreTaste, tasteFeatures, priceBand, selectCalibrationProducts, trimTasteState, TASTE_RETENTION} from './taste.mjs';

const now = 1791705600000;
const product = id => ({id, title: 'Never infer oversize black streetwear from a title', category: 'Футболки', price: 650, observedAt: now, image: `https://images.example/${id}.webp`});
const traits = () => ({reviewed: true, cacheVerified: true, group: 'apparel', fields: {color: {value: 'black', confidence: .9, evidence: 'Visible black cloth'}, pattern: {value: 'solid', confidence: .9, evidence: 'Only visible plain fabric'}, fit: {value: 'oversize', confidence: .9, evidence: 'Reviewed broad visible garment shape'}}});
const rate = (state, id, action = 'like', profile = 'owner', visual) => setTasteRating(state, {profile, nmId: id, action, product: product(id), traits: visual}, {now}).state;

test('empty state does not invent owner, wife or audience preferences', () => {
  for (const kind of ['owner', 'wife', 'audience']) {
    const profile = buildTasteProfile(createTasteState(), kind);
    assert.equal(profile.configured, false);
    assert.equal(profile.sampleProducts, 0);
    assert.equal(profile.lastRatingAt, null);
    assert.deepEqual(profile.preferred, []);
    assert.deepEqual(profile.avoided, []);
    assert.equal(scoreTaste(profile, product(1), {now}).score, 0);
  }
});

test('duplicate personal actions are exact immutable no-ops and switch replaces one vote', () => {
  const empty = createTasteState(), first = rate(empty, 1);
  assert.equal(empty.ratings.length, 0);
  const duplicate = setTasteRating(first, {profile: 'owner', nmId: 1, action: 'like', product: product(1)}, {now: now + 5});
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.state, first);
  const switched = rate(first, 1, 'dislike');
  assert.equal(switched.ratings.length, 1);
  assert.equal(switched.ratings[0].action, 'dislike');
  assert.equal(buildTasteProfile(switched, 'owner').feedbackEvents, 1);
});

test('explicit undo removes rating, duplicate undo does nothing, and no toggle surprises', () => {
  const state = rate(createTasteState(), 1, 'more');
  const undone = setTasteRating(state, {profile: 'owner', nmId: 1, action: 'undo'}, {now: now + 1});
  assert.equal(undone.changed, true);
  assert.equal(undone.state.ratings.length, 0);
  assert.equal(setTasteRating(undone.state, {profile: 'owner', nmId: 1, action: 'undo'}, {now}).changed, false);
});

test('owner and wife ratings remain independent and cannot claim an arbitrary identity', () => {
  let state = rate(createTasteState(), 1, 'like');
  state = rate(state, 1, 'dislike', 'wife');
  assert.equal(state.ratings.length, 2);
  assert.equal(buildTasteProfile(state, 'owner').feedbackEvents, 1);
  assert.equal(buildTasteProfile(state, 'wife').feedbackEvents, 1);
  assert.equal(buildTasteProfile(state, 'audience').feedbackEvents, 0);
  assert.throws(() => setTasteRating(state, {profile: 'wife', participant_id: 'local-owner', nmId: 1, action: 'like', product: product(1)}, {now}), /INVALID_PARTICIPANT/);
  assert.throws(() => setTasteRating(state, {profile: 'audience', nmId: 1, action: 'like', product: product(1)}, {now}), /INVALID_RATING/);
});

test('titles never become visual attributes; cached confidence alone is not review', () => {
  assert.deepEqual(tasteFeatures(product(1), undefined, {now}), {'category=Футболки': 1, 'budget=600–1000 ₽': 1});
  assert.deepEqual(tasteFeatures(product(1), {...traits(), reviewed: false}, {now}), tasteFeatures(product(1), undefined, {now}));
  assert.deepEqual(tasteFeatures(product(1), {...traits(), cacheVerified: false}, {now}), tasteFeatures(product(1), undefined, {now}));
});

test('reviewed visual fields are strict: unknown, enum, data types and weak evidence ignored', () => {
  const visual = traits();
  visual.fields.color.confidence = '0.95';
  visual.fields.style = {value: 'unknown', confidence: .9, evidence: 'Unknown style'};
  visual.fields.material = {value: 'cotton', confidence: .99, evidence: 'Cannot see fiber chemistry'};
  visual.fields.silhouette = {value: 'fitted', confidence: .79, evidence: 'Low certainty'};
  visual.fields.palette = {value: 'dark', confidence: .9, evidence: 'x'};
  const result = tasteFeatures(product(1), visual, {now});
  assert.equal(result['visual.fit=oversize'], 1);
  assert.ok(!Object.keys(result).some(k => /color|material|style|palette|silhouette/.test(k)));
});

test('solid pattern never yields print position/size; back position needs separate review', () => {
  const visual = traits();
  visual.fields.print_location = {value: 'back', confidence: .95, evidence: 'Possible back view'};
  visual.fields.print_size = {value: 'large', confidence: .95, evidence: 'Large visible print'};
  assert.ok(!Object.keys(tasteFeatures(product(1), visual, {now})).some(k => k.includes('print_')));
  visual.fields.pattern.value = 'graphic';
  assert.equal(tasteFeatures(product(1), visual, {now})['visual.print_location=back'], undefined);
  visual.backReviewed = true;
  assert.equal(tasteFeatures(product(1), visual, {now})['visual.print_location=back'], 1);
});

test('price preferences use only real recent numeric catalog price, not fake crossed-out price', () => {
  for (const card of [{...product(1), price: undefined, old_price: 100000}, {...product(1), price: '650'}, {...product(1), price: -1}, {...product(1), observedAt: now + 1}, {...product(1), observedAt: now - 2 * 86400000}, {...product(1), observedAt: undefined}]) assert.ok(!Object.keys(tasteFeatures(card, null, {now})).some(k => k.startsWith('budget=')));
  assert.equal(priceBand(100), '0–100 ₽');
  assert.equal(priceBand(101), '100–200 ₽');
  assert.equal(priceBand(201), '200–300 ₽');
  assert.equal(priceBand(301), '300–600 ₽');
  assert.equal(priceBand(NaN), null);
});

test('insufficient genuine samples remain neutral; supported evidence has sample counts', () => {
  let state = createTasteState();
  for (let id = 1; id <= 4; id++) state = rate(state, id, 'like', 'owner', traits());
  assert.equal(buildTasteProfile(state, 'owner').configured, false);
  assert.equal(scoreTaste(buildTasteProfile(state, 'owner'), product(10), {traits: traits(), now}).score, 0);
  state = rate(state, 5, 'more', 'owner', traits());
  const profile = buildTasteProfile(state, 'owner');
  assert.equal(profile.configured, true);
  assert.ok(profile.preferred.every(row => row.products === 5));
  const score = scoreTaste(profile, product(10), {traits: traits(), now});
  assert.ok(score.score > 0);
  assert.equal(score.uncertainty, 'small_sample');
  assert.ok(score.matchedFeatures.some(row => row.key === 'visual.fit=oversize'));
  assert.ok(profile.unknown.includes('style'));
});

test('feature support needs distinct products, not one product with 1000 audience votes', () => {
  let state = createTasteState();
  state = setAudienceSignals(state, {nmId: 1, product: product(1), likes: 1000}, {now}).state;
  assert.equal(buildTasteProfile(state, 'audience').configured, false);
  assert.equal(buildTasteProfile(state, 'audience').sampleProducts, 1);
  for (let id = 2; id <= 5; id++) state = setAudienceSignals(state, {nmId: id, product: {...product(id), category: 'Другая категория'}, dislikes: 1}, {now}).state;
  const profile = buildTasteProfile(state, 'audience');
  assert.equal(profile.configured, true);
  assert.equal(profile.evidence.find(row => row.key === 'category=Футболки').sufficient, false);
});

test('audience aggregate snapshot is idempotent, can decrease, and never includes personal votes', () => {
  const original = rate(createTasteState(), 1, 'more');
  const input = {nmId: 1, product: product(1), likes: 2, dislikes: 1, bought: 0};
  const state = setAudienceSignals(original, input, {now}).state;
  assert.equal(setAudienceSignals(state, input, {now: now + 1}).changed, false);
  const changed = setAudienceSignals(state, {...input, likes: 1, dislikes: 2}, {now: now + 1}).state;
  assert.equal(changed.audience.length, 1);
  assert.equal(buildTasteProfile(changed, 'audience').feedbackEvents, 3);
  assert.equal(buildTasteProfile(changed, 'owner').feedbackEvents, 1);
  assert.throws(() => setAudienceSignals(state, {...input, likes: -1}, {now}), /INVALID_COUNTS/);
});

test('stronger positive/negative actions do not multiply sample counts and exact block is clear', () => {
  let state = createTasteState();
  for (let id = 1; id <= 5; id++) state = rate(state, id, 'block_similar', 'owner', traits());
  const profile = buildTasteProfile(state, 'owner');
  assert.equal(profile.sampleProducts, 5);
  assert.equal(profile.feedbackEvents, 5);
  assert.ok(profile.avoided.length > 0);
  assert.equal(scoreTaste(profile, product(1), {now}).blocked, true);
  assert.equal(scoreTaste(profile, product(10), {now}).blocked, false);
  assert.ok(scoreTaste(profile, product(10), {now}).score < 0);
});

test('unknown categories and unmatched features do not fabricate taste or category from title', () => {
  const empty = {...product(1), category: 'unknown', observedAt: undefined};
  assert.deepEqual(tasteFeatures(empty, undefined, {now}), {});
  let state = createTasteState();
  for (let id = 1; id <= 5; id++) state = rate(state, id);
  const result = scoreTaste(buildTasteProfile(state, 'owner'), {...empty, id: 10}, {now});
  assert.equal(result.supported, false);
  assert.equal(result.score, 0);
  assert.equal(result.uncertainty, 'no_matching_evidence');
});

test('JSON storage roundtrip retains results; mismatched nmId and lowered sample gates rejected', () => {
  let state = createTasteState();
  for (let id = 1; id <= 5; id++) state = rate(state, id);
  assert.deepEqual(buildTasteProfile(JSON.parse(JSON.stringify(state)), 'owner'), buildTasteProfile(state, 'owner'));
  assert.throws(() => setTasteRating(state, {profile: 'owner', nmId: 2, action: 'more', product: product(3)}, {now}), /ID_MISMATCH/);
  assert.throws(() => buildTasteProfile(state, 'owner', {minSamples: 1}), /SAMPLE_LIMIT/);
});

test('calibration chooses 20–30 unique real-photo cards and alternates metadata categories', () => {
  const cards = Array.from({length: 40}, (_, index) => ({...product(index + 1), category: index < 25 ? 'A' : 'B'}));
  const result = selectCalibrationProducts([...cards, cards[0], {...product(100), image: undefined}, {...product(101), image: 'javascript:alert(1)'}]);
  assert.equal(result.products.length, 24);
  assert.equal(result.available, 40);
  assert.equal(new Set(result.products.map(card => card.id)).size, 24);
  assert.deepEqual(result.products.slice(0, 4).map(card => card.category), ['A', 'B', 'A', 'B']);
  assert.equal(result.shortfall, 0);
  assert.throws(() => selectCalibrationProducts(cards, {size: 50}), /CALIBRATION_SIZE/);
});

test('calibration honestly reports photo shortage instead of generating cards', () => {
  const result = selectCalibrationProducts([product(1), product(2)]);
  assert.equal(result.products.length, 2);
  assert.equal(result.shortfall, 22);
  assert.match(result.note, /не выдумываются/);
});

test('explicit block similar uses reviewed structural evidence without weakening learning gate', () => {
  const state = rate(createTasteState(), 1, 'block_similar', 'owner', traits());
  const profile = buildTasteProfile(state, 'owner');
  assert.equal(profile.configured, false);
  assert.ok(profile.evidence.every(row => row.sufficient === false));
  assert.deepEqual(profile.blockedExamples, [{nmId: 1, features: state.ratings[0].features}]);
  const similar = scoreTaste(profile, product(2), {traits: traits(), now});
  assert.equal(similar.blocked, true);
  assert.equal(similar.blockReason, 'explicit_reviewed_similarity');
  assert.equal(similar.blockEvidence.nmId, 1);
  assert.equal(similar.score, 0);
  assert.deepEqual(similar.blockEvidence.matchingFields.sort(), ['color', 'fit', 'pattern']);
});

test('category and colors alone never block a category; unreviewed or opposing structure ignored', () => {
  const state = rate(createTasteState(), 1, 'block_similar', 'owner', traits());
  const profile = buildTasteProfile(state, 'owner');
  const colorOnly = traits();
  delete colorOnly.fields.fit;
  delete colorOnly.fields.pattern;
  assert.equal(scoreTaste(profile, product(2), {traits: colorOnly, now}).blocked, false);
  assert.equal(scoreTaste(profile, product(2), {traits: {...traits(), reviewed: false}, now}).blocked, false);
  assert.equal(scoreTaste(profile, {...product(2), category: 'Сумки'}, {traits: traits(), now}).blocked, false);
  const opposite = traits();
  opposite.fields.fit.value = 'slim';
  opposite.fields.palette = {value: 'dark', confidence: .9, evidence: 'Visible dark overall palette'};
  assert.equal(scoreTaste(profile, product(2), {traits: opposite, now}).blocked, false);
  assert.deepEqual(buildTasteProfile(state, 'audience').blockedExamples, []);
});

test('explicit similar block rejects a contradictory shared structural feature', () => {
  const source = traits();
  source.fields.silhouette = {value: 'loose', confidence: .9, evidence: 'Visible loose silhouette'};
  const state = rate(createTasteState(), 1, 'block_similar', 'owner', source);
  const candidate = traits();
  candidate.fields.silhouette = {value: 'fitted', confidence: .9, evidence: 'Visible fitted silhouette'};
  assert.equal(scoreTaste(buildTasteProfile(state, 'owner'), product(2), {traits: candidate, now}).blocked, false);
});

test('storage is capped separately at 100 per personal profile and 100 aggregate products', () => {
  let state = createTasteState();
  for (let id = 1; id <= 102; id++) {
    state = rate(state, id, 'like', 'owner');
    state = rate(state, id, 'dislike', 'wife');
    state = setAudienceSignals(state, {nmId: id, product: product(id), likes: 1}, {now}).state;
  }
  assert.equal(state.ratings.filter(row => row.profile === 'owner').length, 100);
  assert.equal(state.ratings.filter(row => row.profile === 'wife').length, 100);
  assert.equal(state.audience.length, 100);
  assert.ok(!state.ratings.some(row => row.nmId <= 2));
  assert.ok(!state.audience.some(row => row.nmId <= 2));
  assert.equal(trimTasteState(state, {now}).changed, false);
});

test('explicit retention trims expired snapshots immutably and writes apply the same TTL', () => {
  let state = rate(createTasteState(), 1);
  state = setAudienceSignals(state, {nmId: 1, product: product(1), likes: 1}, {now}).state;
  const afterAudience = trimTasteState(state, {now: now + TASTE_RETENTION.audienceRetentionMs + 1});
  assert.equal(afterAudience.state.ratings.length, 1);
  assert.equal(afterAudience.state.audience.length, 0);
  assert.equal(state.audience.length, 1);
  const expired = trimTasteState(state, {now: now + TASTE_RETENTION.personalRetentionMs + 1});
  assert.equal(expired.state.ratings.length, 0);
  assert.equal(expired.state.audience.length, 0);
  const newRating = setTasteRating(state, {profile: 'owner', nmId: 2, action: 'like', product: product(2)}, {now: now + TASTE_RETENTION.personalRetentionMs + 1});
  assert.equal(newRating.state.ratings.length, 1);
  assert.equal(newRating.state.ratings[0].nmId, 2);
  assert.equal(newRating.state.audience.length, 0);
  assert.throws(() => trimTasteState(state, {now, personalMax: 101}), /INVALID_RETENTION/);
});

test('unverified historical category never becomes taste even when a topic sounds specific', () => {
  const book = {...product(497343580), name: 'ОГЭ. Обществознание. Новый полный справочник', category: 'Основные части двигателя', categoryVerified: false, historicalTopic: 'Основные части двигателя', observedAt: undefined};
  assert.deepEqual(tasteFeatures(book, undefined, {now}), {});
  assert.equal(tasteFeatures({...book, categoryVerified: true}, undefined, {now})['category=Основные части двигателя'], 1);
  assert.equal(tasteFeatures({...book, categoryVerified: undefined}, undefined, {now})['category=Основные части двигателя'], 1);
  let state = createTasteState();
  for (let id = 1; id <= 5; id++) state = setTasteRating(state, {profile: 'owner', nmId: id, action: 'like', product: {...book, id}}, {now}).state;
  const profile = buildTasteProfile(state, 'owner');
  assert.equal(profile.configured, true);
  assert.deepEqual(profile.evidence, []);
  assert.ok(profile.unknown.includes('category'));
});

test('historical topics balance calibration without leaking into learned feature keys', () => {
  const cards = Array.from({length: 30}, (_, index) => ({...product(index + 1), category: 'unknown', categoryVerified: false, historicalTopic: index < 20 ? 'A' : 'B'}));
  const sample = selectCalibrationProducts(cards);
  assert.deepEqual(sample.products.slice(0, 4).map(card => card.historicalTopic), ['A', 'B', 'A', 'B']);
  assert.ok(sample.products.every(card => Object.keys(tasteFeatures(card, undefined, {now})).every(key => !key.startsWith('category=') && !key.includes('historicalTopic'))));
});
