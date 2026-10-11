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

// Pure unit-fixture votes only: no actual calibration files are changed.
const colorTraits = group => ({reviewed: true, cacheVerified: true, group, fields: {color: {value: 'black', confidence: .9, evidence: 'Reviewed black visible product in this exact fixture photo'}}});
const visualOnlyProduct = id => ({...product(id), category: 'unknown', observedAt: undefined});
const rateVisual = (state, id, group, action = 'like') => setTasteRating(state, {profile: 'wife', nmId: id, action, product: visualOnlyProduct(id), traits: group ? colorTraits(group) : undefined}, {now}).state;

test('four black products across shoes/bag/apparel cannot pool support into learned color', () => {
  let state = createTasteState();
  for (const [id, group] of [[1, 'shoes'], [2, 'shoes'], [3, 'bag'], [4, 'apparel'], [5, null]]) state = rateVisual(state, id, group);
  const profile = buildTasteProfile(state, 'wife'), evidence = profile.evidence.find(row => row.key === 'visual.color=black');
  assert.equal(profile.configured, true);assert.equal(evidence.products, 4);assert.equal(evidence.sufficient, false);
  assert.deepEqual(evidence.groupEvidence.map(row => [row.group, row.products, row.sufficient]), [['apparel', 1, false], ['bag', 1, false], ['shoes', 2, false]]);
  assert.ok(profile.unknown.includes('color'));assert.deepEqual(profile.preferred, []);
  for (const group of ['apparel', 'bag', 'shoes']) {
    const score = scoreTaste(profile, visualOnlyProduct(90), {traits: colorTraits(group), now});
    assert.equal(score.score, 0);assert.equal(score.supported, false);assert.deepEqual(score.matchedFeatures, []);
  }
});

test('three distinct reviewed apparel colors support apparel, not the same color in footwear', () => {
  let state = createTasteState();
  for (let id = 1; id <= 5; id++) state = rateVisual(state, id, id <= 3 ? 'apparel' : null);
  const profile = buildTasteProfile(state, 'wife'), color = profile.evidence.find(row => row.key === 'visual.color=black');
  assert.equal(color.sufficient, true);assert.equal(color.groupEvidence[0].products, 3);assert.ok(!profile.unknown.includes('color'));
  const apparel = scoreTaste(profile, visualOnlyProduct(90), {traits: colorTraits('apparel'), now});
  assert.equal(apparel.score, .4286);assert.deepEqual(apparel.matchedFeatures, [{key: 'visual.color=black', group: 'apparel', preference: .4286, products: 3, nmIds: [1, 2, 3]}]);
  const shoes = scoreTaste(profile, visualOnlyProduct(91), {traits: colorTraits('shoes'), now});
  assert.equal(shoes.score, 0);assert.equal(shoes.supported, false);
});

test('opposite same-color preferences in distinct groups never leak or cancel group scoring', () => {
  let state = createTasteState();
  for (let id = 1; id <= 6; id++) state = rateVisual(state, id, id <= 3 ? 'apparel' : 'shoes', id <= 3 ? 'like' : 'dislike');
  const profile = buildTasteProfile(state, 'wife'), evidence = profile.evidence.find(row => row.key === 'visual.color=black');
  assert.equal(evidence.preference, 0);assert.equal(evidence.sufficient, true);
  assert.deepEqual(evidence.groupEvidence.map(row => [row.group, row.preference, row.products]), [['apparel', .4286, 3], ['shoes', -.4286, 3]]);
  assert.deepEqual(profile.preferred.map(row => [row.key, row.group, row.preference]), [['visual.color=black', 'apparel', .4286]]);
  assert.deepEqual(profile.avoided.map(row => [row.key, row.group, row.preference]), [['visual.color=black', 'shoes', -.4286]]);
  for (const [group, expected, ids] of [['apparel', .4286, [1, 2, 3]], ['shoes', -.4286, [4, 5, 6]], ['bag', 0, []]]) {
    const score = scoreTaste(profile, visualOnlyProduct(90), {traits: colorTraits(group), now});
    assert.equal(score.score, expected);assert.deepEqual(score.matchedFeatures.flatMap(row => row.nmIds), ids);
  }
  assert.equal(buildTasteProfile(state, 'owner').sampleProducts, 0);assert.equal(buildTasteProfile(state, 'audience').sampleProducts, 0);
});

test('group metadata alone is never a visual predictor and old unscoped profiles fail closed', () => {
  let state = createTasteState();for (let id = 1; id <= 5; id++) state = rateVisual(state, id, 'apparel');
  const snapshot = JSON.parse(JSON.stringify(state));for (const row of snapshot.ratings) row.features = {'visual.group=apparel': 1};
  const groupOnly = buildTasteProfile(snapshot, 'wife');assert.deepEqual(groupOnly.evidence, []);assert.ok(groupOnly.unknown.includes('color'));
  const old = buildTasteProfile(state, 'wife');delete old.evidence[0].groupEvidence;
  assert.equal(scoreTaste(old, visualOnlyProduct(90), {traits: colorTraits('apparel'), now}).score, 0);
  const profile = buildTasteProfile(state, 'wife');assert.ok(!profile.evidence.some(row => row.key.startsWith('visual.group=')));
});

test('group support uses distinct products, custom minimum and valid single group snapshots', () => {
  let state = createTasteState();for (let id = 1; id <= 5; id++) state = rateVisual(state, id, id <= 3 ? 'apparel' : null);
  assert.equal(buildTasteProfile(state, 'wife', {minFeatureSamples: 4}).evidence[0].sufficient, false);
  const repeated = JSON.parse(JSON.stringify(state));repeated.ratings = Array.from({length: 5}, () => ({...state.ratings[0]}));
  assert.equal(buildTasteProfile(repeated, 'wife').evidence[0].groupEvidence[0].products, 1);assert.equal(buildTasteProfile(repeated, 'wife').evidence[0].sufficient, false);
  for (const conflict of [false, true]) {
    const snapshot = JSON.parse(JSON.stringify(state));
    for (const row of snapshot.ratings) if (row.features['visual.color=black']) {if (conflict) row.features['visual.group=bag'] = 1;else delete row.features['visual.group=apparel'];}
    const profile = buildTasteProfile(snapshot, 'wife');assert.equal(profile.evidence[0].sufficient, false);assert.deepEqual(profile.evidence[0].groupEvidence, []);
  }
});

test('category and budget remain unchanged when visual color is insufficient across groups', () => {
  let state = createTasteState();
  for (const [id, group] of [[1, 'shoes'], [2, 'shoes'], [3, 'bag'], [4, 'apparel'], [5, null]]) state = setTasteRating(state, {profile: 'owner', nmId: id, action: 'like', product: product(id), traits: group ? colorTraits(group) : undefined}, {now}).state;
  const profile = buildTasteProfile(state, 'owner'), score = scoreTaste(profile, product(90), {traits: colorTraits('bag'), now});
  assert.deepEqual(score.matchedFeatures.map(row => row.key).sort(), ['budget=600–1000 ₽', 'category=Футболки']);assert.equal(score.score, .5556);
  assert.equal(profile.evidence.find(row => row.key === 'category=Футболки').products, 5);assert.ok(profile.unknown.includes('color'));
});

test('explicit similar restriction also requires the same trusted visual group', () => {
  const source = traits(), state = rate(createTasteState(), 1, 'block_similar', 'owner', source), profile = buildTasteProfile(state, 'owner');
  const candidate = {...source, group: 'bag', fields: {color: source.fields.color, pattern: source.fields.pattern, style: {value: 'casual', confidence: .9, evidence: 'Reviewed visual style'}}};
  source.fields.style = candidate.fields.style;
  const reviewedState = rate(createTasteState(), 1, 'block_similar', 'owner', source);
  assert.equal(scoreTaste(buildTasteProfile(reviewedState, 'owner'), product(2), {traits: candidate, now}).blocked, false);
  assert.equal(scoreTaste(profile, product(2), {traits: traits(), now}).blocked, true);
});
