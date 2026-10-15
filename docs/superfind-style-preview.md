# Superfind + My Style: isolated preview, 2026-10-15

Status: **Draft, local preview only. Not merged or deployed.**

Continuation: the next isolated Telegram staging phase is documented in
`docs/style-staging-rollout.md`. It adds a server-only public-auth factory to
the existing Worker (default production HMAC behavior unchanged), copied public
assets/navigation and a separate staging entrypoint/config. The statements
below describe the initial local checkpoint; they are not a live staging receipt.

## Isolation and reuse

Branch `codex/superfind-my-style-preview-20261014` starts at main
`7a11699aef7de9b029496291cbe48524d9d92085` and reuses the six existing
PR #10 commits (cherry-picked without changing that branch). PR #10's value
assessment, closed reviewed-feature extractor, shrinkage and dedup are reused.
Its first blind test did **not** establish improvement over Legacy; this PR
does not claim otherwise or alter publication ranking.

`miniapp/features/worker.mjs` is a separate opt-in entrypoint. It is **not imported
by the production Worker**, has no scheduler, Telegram sender, WB fetcher or AI
binding. `FEATURE_PREVIEW=1` is mandatory. No production configuration, secret,
Cloudflare resource, existing frontend or admin file was changed. Production
posting interval, search, queue, reactions, River and Vision flags are untouched;
their current live state was not independently probed by this isolated test.

## Local preview

Node 24+ and existing project dependencies:

```powershell
npm run features:preview
```

- My Style: <http://127.0.0.1:8773/style>
- Owner preview: <http://127.0.0.1:8773/superfind>
- Loopback on this PC only, **not a phone/public hosting URL**.
- 80 real previously verified fashion photos, SHA-256 checked on startup and
  frozen in memory; seven reviewed matching visual profiles. These are historical
  photo examples, **not proof of current price/stock or new WB discovery**.
- Separate local subscribers A/B start without the owner's, wife's or audience's
  ratings. Fake local session keys are random per process, never real bot tokens.
  `/preview/session` exists only in the loopback server, not the Worker.
- Ratings/favorites persist in ignored `.test-temp/superstyle/preview.sqlite3`.
  Restart keeps them. This local SQLite adapter does not report D1 billing data.

## Superfind: no invented deal

Current real-data run: **40 candidates checked, zero eligible**. Stale/unknown
price, unknown stock, insufficient trustworthy value evidence and incomplete
publication-history proof correctly block eligibility. No attractive fake
positive example was manufactured to fill this gap. Photos and rejection
reasons are visible in the owner preview. A real verified positive Telegram
preview remains a rollout gate, not a completed result.

The implementation requires:

- Trusted fresh RUB price with exact variant and destination/payment context;
  independently fresh affirmative stock evidence.
- Rating/review gates, no known quality warnings, no unexplained price outlier.
- Real observations across different days or a verified comparable cohort;
  seller crossed-out price alone never establishes savings.
- Verified WB photo and complete publication history with an indexed negative
  lookup for the nmId. Missing history proof fails closed.

Owner UI provides opt-in preview selection, thresholds, candidates/proof,
approve/reject and history. GET never inserts configuration defaults.
Refresh acknowledges HTTP202 and runs a bounded durable task afterwards. A
single atomic lease with an owner nonce and 30-second TTL guards concurrent
refreshes; replay of a completed request does not lock or rescan the catalogue.
Candidate evidence is checked again on display and approval. `approved_preview`
is only a saved decision: **there is no publish endpoint**. Future publishing
must consume one existing slot, never create an extra slot.

## Subscriber privacy and learning

- `/api/style/*`: existing public-bot Telegram initData verification.
- `/api/admin/superfind*`: main-bot signature **and** configured owner ID.
  Public-bot signatures, forged owner IDs, expired sessions and foreign origins
  are denied. Clients cannot submit identity, derived features or a model.
- Per-user aggregate model and votes, favorites, explicit category/budget filters,
  unseen-photo feed, explanations and reset. No cross-user training/import.
- Confirmed photo-matched/reviewed compatible Vision features only. Names never
  provide inferred fit, color, style or print. Unknown stays unknown.
- Visual feature families carry the dominant weight when supported; category
  is a small prior. Negative category ratings never ban a whole category.
  Similar-item suppression requires multiple compatible structural visual facts.
- Minimum five ratings and three distinct supporting products per reported
  preference. Cold start stays diverse and low-confidence. No fabricated uplift.
- One rating per user/product, idempotency receipt and transactional version CAS.
  Concurrent loser gets409; switching replaces aggregates rather than adding a
  second product. Network retry reuses the same request ID. UI disables double
  clicks and refreshes conflicting state.
- Reset removes that user's ratings, derived preferences and filters, preserving
  favorites and only an empty revision tombstone against stale resurrection.
- Real price filters fail closed without fresh verified price/stock/context.
  Historical examples show a clear "price and stock not confirmed" label.

## D1 plan and resource limits

Additive `miniapp/features/schema.sql` is **not applied to production**.
Shared catalogue snapshot: one row, at most120 product/profile pairs. Individual
actions use indexed `(user_id,pid)`, `(user_id,request_id)` and account PK lookups;
feeds query only candidate IDs, not whole personal/publication histories.
Favorites limit100; votes/skips limit500; receipts retained41; returned deck20;
superfind refresh40; candidate list20; decision history30. Plans checked with
SQLite EXPLAIN use indexed SEARCH, not personal-table full scans.

Atomic feature daily reservations: **50,000 reads / 8,000 writes**, additionally
inside the existing shared `optional` budget. Genuine D1 metadata reconciles
reservations; unknown metadata is not treated as zero and keeps the conservative
reservation. Catalogue refresh reserves500 reads/200 writes, normal request500
reads/8 or20 writes, reset1,200 writes. Budget bookkeeping has a small additional
shared-guard charge. These are defensive ceilings, **not measured D1 usage or a
guarantee of capacity for a given subscriber count**. Exhausting this optional
feature returns429 without calling the scheduler. Before real rollout, measure
`rows_read/rows_written` against staging D1 under representative concurrency.

This test's actual external usage: **Cloudflare calls0, remote D1 reads/writes0,
AI calls0 / Neurons0, WB calls0, Telegram sends0**. Browser scenario used356 local
SQL statements including catalogue seed and budget accounting, returned101 rows.
Local rows returned/statements must not be presented as billed D1 rows_read.

## Verification

- 25 new local SQLite/unit/integration tests PASS.
- 203 existing SHADOW tests +209 existing Worker tests PASS (437 total).
- `npm run build`, `npm run check:features`, JS syntax PASS. Isolated browser
  Worker bundle90.8 KiB; no Node SQLite module in that bundle.
- At the initial local checkpoint the production/admin/public source diff was
  empty. See the subsequent reviewed auth-factory-only diff in the staging phase.
- Chromium390x844: real photos decode, no horizontal overflow or page errors.
  Four ratings and one favorite persisted after reload; subscriber B remained
  empty. A server-committed vote whose response was deliberately lost stayed
  exactly one vote after retry; double-click produced one vote.
- Local API load timings7.8–58.2ms, **not Cloudflare/phone latency**.
- Deferred catalogue integration fixture confirms HTTP202 before slow work
  finishes; concurrent refresh, expired lease and stale price tests pass.
- Receipt/screenshots: `docs/superfind-style-preview-20261015/`.

Optional browser QA uses an already installed Playwright/Chromium (no new
dependency), its own disposable DB and port8774:

```powershell
# If Playwright is not resolvable locally, set WB_BROWSER_QA_MODULE to its
# already-installed module directory and WB_BROWSER_QA_EXECUTABLE to Chromium.
node miniapp/features/browser_qa.cjs
```

## Safe next steps — approval required before deployment

1. Review local UX and Draft PR; keep new ranking outside production.
2. With approval, provide isolated staging bindings/assets and real Telegram
   auth; do not use local session endpoints there. Import a bounded shared
   catalogue through the existing verified-source adapter, plus complete
   publication history. No per-swipe WB/AI fetching.
3. Measure actual staging D1 costs, auth/privacy, freshness and job recovery;
   obtain at least one genuinely verified positive superfind preview.
4. Independent unseen-item evaluation before quality/uplift claims. Keep
   subscriber tastes separate; never reuse training items as quality proof.
5. After a separate integration approval, add a public My Style navigation item
   and owner superfind route to the existing apps. No defaults over existing
   settings. Any later approved superfind uses an ordinary30-minute slot.

No merge, production deployment, extra Telegram post, paid service or automatic
Vision/ML activation is part of this preview.
