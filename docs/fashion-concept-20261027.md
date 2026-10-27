# Fashion policy preparation — 27 October 2026

Scope: passive SHADOW, owner-approved category budgets, bounded query-price
filters in the existing admin API/import/export, and a pure post-preview
formatter. No production configuration, Cron, queue, ratings, sender activation,
paid service, new model, or marketplace integration is changed by this branch.
Base is the existing isolated fashion branch at `934ea0c`; PR17 remains a
separate dependency, and PR15/16 are not merged here.

## Approved ordinary ceilings

T-shirts/tops 800 RUB; long sleeves/sweaters 1500; jeans/trousers/hoodies 2500;
sneakers/trainers/boots 3500; jackets/bombers 4500; bags/accessories 1500.
Owner clarification: dresses 2500, skirts 1500, shirts 1500, cardigans 2500.
Exact official-category aliases are in `fashion_policy.mjs`. Unmapped subjects
hold instead of inheriting an invented ceiling. These are maxima, not targets;
a small price preference breaks otherwise similar editorial choices.

The under-300 budget-find tag has no quota and bypasses no photo/owner/quality
gate. The exceptional-value option is OFF. Enabling it alone cannot permit an
over-budget item: an explicit higher per-group ceiling, exact item/category,
SKU/currency/known-context binding and the existing fresh-quote/history checks
are required. Seller crossed-out prices cannot create a bargain. No real
exception is claimed; current catalogue observations do not carry this proof.

## Quality, diversity and feedback

Photograph evidence/recent exact-source editorial approval is compulsory. Names
never establish fit, trend, colour, material or back print. Official WB category
and adult audience metadata are required. PR14 exclusions remain first.

35/35/20/10 are bounded soft ranking adjustments over the latest 40 observed
deliveries. A missing bucket does not force a weak thing, and an overrepresented
bucket does not hard-cap a good item. At most two same product types and the
existing recent-similarity veto remain hard gates. Verified visual quality
outranks a quota deficit. Exact-item votes contribute no more than ±2.5%; no
category/facade learner or inference from two voters is introduced. River
remains SHADOW.

Colour/fit/style repetition is considered only when matching trusted profiles
exist for both recent items. The current producer often has no such recent
profiles; this is an explicit limitation, not a claim of colour-aware variety
on unknown images. No additional SQL/profile loading or inference is added.

## Search proposal, not production settings

`node miniapp/shadow/prepare_fashion_policy.mjs snapshot.json proposal.json`
reads an actual production snapshot and writes an unapplied review draft.
It uses 31 targeted fashion phrases, archives the 15 replaced/obsolete phrases
(including the five household phrases), and preserves real IDs and owner rules.
Every phrase has a 1–4500 RUB ceiling through the existing query API. The
effective search limit is the minimum of query and existing global/selection
ceilings. Both initial cards and detailed/admission checks enforce it locally,
including a lowered/archived query during I/O. WB ignoring `priceU` cannot
admit an over-ceiling card. Export/import and old-editor saves retain the limit.

The live global ceiling is still 1000. Proposed 4500 is an outer discovery
ceiling, not permission to publish a T-shirt at 4500. Do not apply this draft to
Legacy without a strict fashion sender. The selection draft is deliberately
`confirmed:false`; each API save requires a fresh revision after the preceding
save and an explicit release authorization. Neither the generator nor tests
send an admin request to production.

One proposed real WB query on 27 October returned403; the probe stopped. The
before/after receipt is therefore only a local replay of the actual 71-row
queue through the existing API. It proves preservation and filters, not new
supply or improved subscriber reactions. Legacy proposed1522183967; the native
fashion context had no sufficient visual proof and proposed no item. Real
stock/size retail observations from this probe: zero.

## Price/acceptance and post format

`fashionQuoteState` checks exact available SKU, size, price, currency, observation
time and source context against the variants and provenance. Contradictory
identity or stock, stale data, search-only evidence and fallback are rejected.
`fashionAcceptance` recomputes the current budget; an old budget result cannot
authorize an updated item. Style, fresh API observation, ordinary-retail
confirmation, owner acceptance and publication readiness remain distinct.
Current PR16 explicitly retains unknown payment/retail confirmation: do not
turn those fields into confirmed retail facts.

`fashionCaption` is a prepared preview helper, not connected to the live sender.
It includes WB, a short title/reason, actual quote size and Moscow observation
time, known rating/reviews and no unsupported discount claim. Existing WB link
and reaction buttons remain the sender's responsibility. Runtime connection,
PR16 integration/provenance preservation and exact final send-gate verification
remain release work; this Draft does not pretend to have finished them.

## Validation and release gates

Focused rule/API tests and a real-snapshot SQLite replay use intercepted HTTP;
synthetic prices are not new real observations. Independent review reproduced
and then verified fixes for query-limit races, portable settings, cross-SKU
exception history, contradictory quotes and stale budget results.

The six-success Moscow-calendar limit and >=120-minute profile are prepared in
a separate main-based Draft. Its proof is independent; it is not merged here.
The existing minute Cron cannot simply become a 30-minute Cron: watchdog and
the modulo20 My Style refresh need separate compatibility proof. Current
sampled all-Cron CPU has no demonstrated Free headroom; no CPU experiment or
tariff change was performed.

Before any live use: current price/stock proof, >=10/15 real owner approvals,
strict final fashion send gates, separate PR16/17 decisions, schedule staging,
Free headroom, fresh recovery evidence and explicit owner command «Внедряй».
Until then all new selection remains passive/off. Roll back code/settings after
draining leases/requests; preserve D1 posts/claims/votes and never resend by
rewinding the database. Fresh Time Travel checkpoint and historical SQL dump
must not be described as the same kind or age of backup.
