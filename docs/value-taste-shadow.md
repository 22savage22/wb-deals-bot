# Value and taste — isolated SHADOW, 2026-10-11

## Status and boundaries

Prepared on `codex/value-taste-shadow-20261011`, independently from main
`f28dd980f111a46bd973874038ad985e6602c8d8`. No changes to production Worker
code, D1, Telegram, Cron, settings, public Mini App, Astra PR8 or Vision PR9.
No deployment, merge, paid services, AI calls or synthetic production feedback.
Production's existing 30-minute schedule and River SHADOW are not overridden.
This document is a source audit, not a new live production health measurement.

This is a **reviewable independent prototype**, not an enabled new search or
publisher. Fresh live-price evidence and personal taste calibration are still
required before claiming better bargain selection.

## Actual causes found in current code

- Native selection loads oldest queued candidates and uses fixed audience/
  accessory rotation, then the first matching item, preferably from another
  query-topic (`miniapp/cloudflare/native_scheduler.mjs:10,19–22,44–54,142–148`).
  Query diversity is not semantic/visual diversity; near-identical designs can
  have different queries and titles. This is a demonstrated capability gap,
  not attribution of every recent repeat to that one cause.
- Native deliberately ignores the seller's crossed-out discount: current
  price becomes `basic`, `discount=0`, `selection_mode=good_price` (`:84–94`).
  But it does not evaluate actual price-history or comparable market cohorts.
  Python's separate genuine-drop heuristic (`smart.py:179–243`) requires three
  observations spanning an hour, default 15% drop, at most seven samples;
  native selection does not call it. Old samples also lack variant/destination/
  payment context, so they cannot establish a trustworthy like-for-like saving.
- Native takes the minimum price over all sizes, but checks availability only
  at product level (`native_scheduler.mjs:85–88`). That can pair an out-of-stock
  cheap size with stock from another size. Missing all quantities also does
  not prove stock. The new isolated normalizer refuses this; production is
  deliberately not patched in this task.
- Feedback is not simply lost: reactions persist learning events
  (`feedback.mjs:79–85`). River SHADOW records a counterfactual and intentionally
  cannot change real publication (`learning.mjs:33–54`, scheduler `:232`).
  Query exploration uses existing topics, not learned visual style (`:88–95`).
  Separate Python feedback boosts (`smart.py:280–298,454–497`) do not make
  the native FIFO chooser a taste-based ranker.
- Current search: one global lease/cooldown, 100 results → eight shortlisted →
  at most three detailed/photo-verified admissions per run (`:280–338`);
  pages1–5, alternating popular/priceup, rating≥4.3/reviews≥20, price cap and
  owner's topic/block settings (`:70–94`). These narrow the supply. Search
  reserves optional D1 budget; a reservation is not measured rows_read
  (`:399–410`). Existing 403/429 backoff is bounded and is not changed here.
- A real bad taxonomy row was confirmed: nmId `497343580`, an OGE textbook,
  had historical topic “Основные части двигателя”; WB CDN says “Учебники”.
  `662768869` is clothing decor, not a product category “Сделано в Иваново”.
  Historical topics now never masquerade as verified taste categories.

## Independent components

All are under `miniapp/shadow/`; none is imported by the production Worker.

| Component | Contract / safety |
|---|---|
| `discovery.mjs` | Explicit injected read-only source. Eight rotating lanes: clothing, footwear, accessories, electronics, home, beauty, brands/popular, unusual items; separate≤100/200/300₽ lane. One source operation per20min by default, parallelism1, ≤100 results/20 details, persistent returned backoff with exponential jitter and Retry-After. No default network. |
| `value.mjs` | `assessValue`, `compareCohortPrice`, `planPriceObservation`, `budgetDiscovery`. Real daily history (≥3days spanning≥7days), ≤28 samples, exact stable size/context/currency/payment match; ≥5 distinct comparable cohort peers. Unknown evidence stays unknown. Seller oldPrice never increases value. |
| `taste.mjs` | Separate owner/wife ratings and audience aggregate snapshots. Like/dislike/more/block_similar, explicit undo, one current vote/profile/product, no double-count on replay. Five distinct products and three observations of a feature before learning. No guessed visual traits. |
| `ranking.mjs` | Hard price/stock/quality/seen/duplicate/block gates **before** weighted score. Value35%, price trust20%, quality20%, taste15%, diversity8%, freshness2%. Reasons and uncertainty are separate from the numerical review score. |
| `storage.mjs`, `schema.sql` | Proposed isolated D1 port only; no automatic migration. Explicit reviewed test database identity required in addition to separate binding. Indexed, bounded reads; atomic global300 new price observations/day; one pid/variant/context/day. Bounded retention. |
| `gallery_server.mjs` | Localhost-only independent calibration UI, not Astra admin. Host/Origin/CSRF checks, trusted server-side products, photo hash verification, serialized atomic saves and revisions. No production credentials. |
| `calibration.mjs`, `fashion_report.mjs` | Exact, confirmed WB fashion-subject allowlist; 40 different pinned real photos, group/category rotation, SKU/photo/family deduplication. Never fill a shortage with books, patches, parts or invented cards. Bounded sequential public CDN GETs; stop on 403/429 or unknown network outcome. |
| `comparison.mjs` | Legacy and SHADOW inspect the same 40 factual snapshots with the same empty recent window. Read-only photo review order is separate from publication eligibility and does not claim a measured uplift. |
| `budget_probe.mjs` | One public price-ascending search up to300₽, encompassing100/200₽ subsets. No retries or endpoint hopping after denial. Search-only results cannot establish matching size/stock/payment context. |

Type/pack/payment context is never inferred from a name or discount. Lower
thresholds cannot bypass quality defaults (rating4.3/reviews20), and an ultra-
budget lane does not restrict the rest of the channel. Current cards without
proven history may be ordinary candidates, **not advertised as a verified deal**.

Visual traits require reviewed/hash-verified cache evidence, confidence≥0.8,
supported vocabularies and observed-field evidence. Material/back-side traits
remain unknown when not visible. No Vision code or model was changed/called.
`block_similar` immediately blocks the explicit product; broader exclusion needs
same verified category and at least three reviewed visual matches, at least two
structural, with no structural contradictions. Category/colour alone cannot ban
a whole category. Personal state is capped100 products/profile/90days; audience
100 products/30days. Server must apply retention when reading as well as writing.

## Real evidence and gallery

`docs/shadow-20261011/report.json` now contains **40 fashion-only photographs**:
clothing30, shoes3, bags3, accessories4, spanning16 confirmed WB subjects.
All40 IDs/categories match exact public WB CDN `info/ru/card.json` metadata;
photos are SHA256-pinned. This correction reused21 verified fashion photos and
obtained19 more, using23 metadata GETs and19 photo GETs, sequentially, no retries.
No books, document inserts, patches or random unrelated fillers are admitted.
Metadata does not contain current price/stock; it is **not** a live bargain receipt.
Some cards are historical already-published products, appropriate for style
calibration but never claimed as newly discovered stock.

Local saved queue100, price records8399, recent photographed posts384,
historical feedback32 products (16likes/21dislikes/0bought). The gallery has
no overlapping audience-feedback products in the new fashion set. No raw Telegram user IDs or
voter identities are exported. Latest historical price observation:
2026-10-03T09:45:41Z. Each displayed queue price retains its OWN timestamp;
a newer unrelated history sample is not relabelled as that price observation.

One local public `card.wb.ru/cards/v4/detail` request returned403; no retry or
endpoint hunt. The authenticated production source credential was not exposed
or copied, and production source/D1 was not used for this offline experiment.
The new separate public search (`футболка`, sort=priceup, ceiling300₽) also
returned **HTTP403** at2026-10-11T12:50:33Z. One request, no retry or bypass.
Lower100/200₽ ceilings are subsets of that search, not extra successful calls.
Therefore today's size-specific price and availability are unconfirmed.

**Legacy on this restricted snapshot:742502965. New publishable choice:none.**
This is reproducible snapshot selection with an empty recent window, NOT full
production replay. All40 fail fresh-price/availability gates, with additional
quality/context reasons where applicable. ≤100/200/300₽:zero fresh confirmed
deals. No fake uplift, new-item discovery receipt, bargain or stock claim.

Open an actual rendered gallery (not the source HTML):

```powershell
npm run shadow:gallery
```

Then `http://127.0.0.1:8772/`. It is intentionally local, not publicly deployed
or accessible from a phone on another device. **Before assessment**, choose
“Мой вкус”/“Вкус жены”, fashion group/category and min/max snapshot price.
The two profiles also retain separate browser view filters after reload.
All40 photographs are eligible for taste review, not for publication.
Existing16 genuine owner ratings were preserved byte-for-byte; three fashion
ratings inform style calibration,13 unrelated ratings remain archived and
excluded from fashion learning. Wife starts with zero ratings, not copied votes.
Ratings persist only in ignored
`.test-temp/value-taste/ratings.json`; opening the page does not initialize
production defaults or write any settings. Export is an explicit local action.
Changing taste now can change SHADOW explanations/review order, not authorize
stale publication. Four explicit actions and undo are one vote/profile/item;
double-click and uncertain network responses cannot silently inflate votes.
No visual traits are invented: five items and three supporting observations
are required for initial evidence; style/fit/color/prints remain unknown until
reviewed Vision evidence exists. Categories come from WB, not search topics.

Rebuild fashion evidence with `npm run shadow:report` (bounded public CDN reads;
cached photos keep their original verification timestamps). Optional explicit
`npm run shadow:budget-probe` does one fresh public search. Neither is Cron or
production code. No automatically recurring source calls are introduced.

## Verification

- Isolated modules:136 Node tests (discovery34, value33, taste23, ranking8,
  storage5, report3, local gallery8, calibration11, comparison8, budget probe3).
  Existing Worker148 tests also pass.
- Local real SQLite: PK/index query plans, daily global cap/idempotency,
  timestamp normalization, bounded28/32/30/20 reads, retention and isolation.
  These are not Cloudflare billing measurements.
- Local HTTP tests: no writes on open, owner/wife separation, double-click,
  switch/undo/restart, lost response/replay, foreign origins/CSRF/arbitrary client
  products denied, tampered photos rejected, wall-clock rollback protection.
  One earlier integration attempt had an uncommitted POST; exact I/O cause was
  not captured. Tests now assert each HTTP receipt, not just later model score.
- Browser: actual HTML rendered with real fashion photos, 390×844 mobile width,
  no horizontal overflow; setup precedes assessment. Category/price filters
  persist after reload, and owner3/wife0 are visibly independent. Lazy-loaded
  photos enable voting only after loading; no broken loaded photographs observed.
  No user taste votes were fabricated during UI testing. Local ratings hash
  unchanged after read-only browser testing.
- Local Python runner is absent from PATH; bundled Python lacks requests.
  Full dependency-installing Python/build checks are provided by Draft PR CI.
  Do not mistake this environment limitation for passed Python tests.
- `npm ci --ignore-scripts` and the existing production bundle **dry-run** pass;
  no upload/deployment. npm audit reports three existing development-tool-chain
  advisories (Wrangler→Miniflare→sharp, GHSA-wq5f-xc86-pv6w); no new dependency
  was added. Tool-chain update is a separate change, not a forced production
  dependency upgrade in this task.

## Additional Cloudflare cost

**Current actual additional D1 reads/writes=0; AI/Neurons=0.** No Cloudflare
deployment is configured. The schema has only been exercised in local SQLite.

Future conservative planning scenario:72 source batches/day×20 details,
but only300 new price observations globally/day. History1440×28=40320;
cohort1440×32=46080 base rows (allow2×for secondary-index/table access);
admission/day/PK probes~3480; bounded prune~16800; two taste profiles~4320;
comparison reads~2880. About160k planned reads, **320k/day reserve envelope**.
Capture mutations≤600 (price+day counter). Allow candidate upserts/indices4320,
comparison144 and worst backlog cleanup8400:≤15k planned writes,
**30k/day reserve envelope**. Normal retention is lower. These are estimates,
not measured D1 metadata; candidate/comparison writers are not yet wired.

Frequency/global read admission must be durably enforced before Cloudflare use.
No optional per-minute history/statistics scan. Record actual D1 metadata and
stop optional SHADOW work on missing/over-budget telemetry. Keep production's
own reserve independent. Free D1 limits and billing semantics:
[Cloudflare pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[query metadata](https://developers.cloudflare.com/d1/observability/metrics-analytics/).

## Safe integration plan — requires a separate approval

1. Owner/wife review the40 fashion-only real-photo calibration; never import synthetic votes.
   Resolve questionable category/style metadata and keep unobservable traits
   unknown. Review this independent Draft PR without merging/deploying.
2. After approved Astra/Vision integration, expose these component interfaces
   in the EXISTING owner-only admin; do not duplicate authentication or UI.
3. Approve a separate test database identity in a pinned manifest; no automatic
   creation, no production binding. Implement and test cross-isolate atomic
   source admission, durable backoff/unknown-outcome settlement and daily D1
   budget before any network runner. Same-process mutex is not enough.
4. Connect a bounded read-only existing source adapter that reports factual
   size/stock/destination/payment context. Obtain fresh real cards and compare
   new IDs to known history. Validate/photo-check before admission; unknown
   bargain evidence remains ordinary/unknown, never “90%off”.
5. Run capped SHADOW, not posting: old/new choice and later real feedback,
   actual query/AI telemetry, duplicates and quality audit. Retain Legacy and
   30MIN production without modification; no promise of uplift until enough
   independently observed outcomes, avoiding exposure/selection bias.
6. Only after explicit approval, bounded evidence and rollback rehearsal may
   production ranking be considered. River remains SHADOW throughout this task.
