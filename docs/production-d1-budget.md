# Production gate before Admin / River modernization

## 2026-10-05 incident: false write admission failure

Production evidence (Actions 37239914220): last delivery 2493 / nmId 306447205
at 2026-10-04 17:49:02 Moscow; last completed Cron 18:07:57; queue 96,
autopost ON, quiet hours OFF, no live lease. Core ledger: 293505 reads /
31526 writes. The old guard required another 5000 writes against a 35000
ceiling, rejecting every subsequent Cron/status call with HTTP 429.
This was the application's write guard, not the account's 5M read quota.

Fix: ordinary core operations reserve 512 writes; bounded read-only probes 4.
Official D1 metadata is charged even after an application/network failure;
unknown database execution/missing metadata keeps a conservative reservation.
Daily core/optional ceilings remain unchanged. A separate authenticated,
read-only diagnostic lane is limited to 15000 reads / 500 writes per day.

Posting tries up to three candidates, bounded by 45 seconds and a query-count
gate. Definitively rejected photos are skipped; uncertain sends retain their
deduplication tombstone. Maintenance/search use separate ticks, including an
idle recovery tick after failed validation. Poller cannot run in native mode.
Incident recovery uses fixed request_id production-recovery-20261005 and reuses
any already successful autonomous delivery rather than sending a second post.
Tests do not replace the required live Telegram receipt and next automatic Cron.

### Live recovery CONFIRMED

Managed build dc59f250 / runtime a88791d1-e67a-4a79-8e83-211a09eb2d1f.
Exactly one incident delivery: message_id **2495**, nmId **537554851**,
«Мешки для хранения», checked price **149 RUB**, checked image basket-28.
Fresh card checked 2026-10-05 **01:48:58 Moscow**; Telegram receipt **01:49:03**.
Claim request_id production-recovery-20261005 = success; inventory state posted;
no repeat manual tick/send. The earlier manual tick only returned lock_busy.

Read-only proof Actions **37241589907**: next autonomous tick **01:50:57**,
last_automatic_tick=1791154257 > last_post_success=1791154143,
production_chain_message_id=2495, matching D1 delivery; queue **87**,
post_request null, leases empty, errors empty, watchdog overdue false.
Autopost remains ON / interval 10 minutes, timezone Europe/Moscow, quiet OFF;
next scheduled post 01:59:03, no PC/poller required.

Actions **37241468915** additionally checked the next real card 438510224:
title «обложка на автодокументы», fresh price 268 RUB, verified basket-25 image,
Telegram getMe OK, no test messages. Core ledger after settlement: reads 298130,
writes 31803; read-only diagnostic itself measured 194 real rows_read.
Ledger snapshots can include in-flight reservations, not just completed usage.

Remaining source warning: WB search temporarily returns HTTP 429. It now respects
a bounded retry delay and does not try another destination immediately on 403/429.
Already verified/valid queue publication is not disabled by this search error.
109 Worker tests and GitHub full Tests/Workers Builds passed on dc59f250.

2026-10-03: the current production gate FAILED; do not claim RUNNING.

## Confirmed evidence

- Native read-only check: GitHub run 37134261108, failed 15:43:50 UTC.
- The public `/api/health` answered 200; this does not prove scheduler health.
- Actual Cloudflare Cron logs repeatedly report:
  `D1_ERROR: Your account has exceeded D1's free tier daily row read limit.`
- Last-hour events observed around 18:00–18:45 Europe/Moscow were failures.
  The precise first quota-exhaustion time and last successful send remain unverified.
- Poller runs 37121870044 and 37122995768 failed with Scheduler HTTP 503.
- Free D1 reads are account-wide, 5 million rows/day; queries may scan many
  more rows than they return. Daily reset is 00:00 UTC (03:00 Moscow).

## Scoped fixes

- Add indexes for delivery topic/time, inventory title/state/topic, claims
  time/status, and consumed request timestamps. No data or settings deletion.
- Compute capped topics once per housekeeping query, not a correlated full
  history count for each queue row. Pin the timestamp range index to avoid
  SQLite choosing a full ordered-topic scan for the grouped subquery.
- Persist scheduler schema version: a cold invocation reads one marker rather
  than rerunning all CREATE statements. Quota errors must never trigger DDL retries.
- Observe official D1 `meta.rows_read` / `rows_written` without additional SQL;
  Cron logs `D1_BUDGET`. Missing test metadata is labelled unavailable, not zero.
- Return a safe quota error code and Retry-After to the UI instead of generic 503.
- Keep the Telegram poller alive when initial D1 schedule refresh fails; back
  off refresh retries to 2–15 minutes instead of retrying in every polling loop.

## Still required after daily reset

1. Confirm managed Workers Builds deployment of the fix.
2. Confirm additive index migration and settings/queue unchanged.
3. Read real D1_BUDGET metrics across normal, search and posting ticks; project
   daily consumption including public catalogue traffic with substantial margin.
4. Confirm one ordinary automatic Telegram receipt and subsequent autonomous tick.
5. Only then implement separate protected `/admin`, Telegram UI and real River
   SHADOW training. Do not switch selection to LEARNING without sufficient evidence.

No paid plan, new database, API token, driver change or secret rotation was requested
or performed. Code optimization cannot refund an already exhausted daily quota.

Sources: https://developers.cloudflare.com/d1/platform/pricing/
and https://developers.cloudflare.com/d1/best-practices/use-indexes/.

## 2026-10-03 deeper optimization (production recovery still pending)

The account has already hit its **5,000,000 reads/day** limit. The exact
historical per-query attribution is unavailable: previous executions did not
record per-query rows_read. Do NOT label synthetic fixture measurements as
production billing or claim quota has been refunded.

### Reproducible measurements

Run `node miniapp/cloudflare/d1_benchmark.mjs` with project-local TEMP/TMP.
It uses the already installed official Miniflare/workerd D1, its actual
`meta.rows_read`, an ephemeral LOCAL database, 10,000 synthetic catalogue
cards, 10,000 delivery records, 300 active candidates, and 143 recent deliveries.
No real WB requests or Telegram messages are made by this benchmark.

| Operation, same fixture | Before | After |
| --- | ---: | ---: |
| Original correlated topic-cap UPDATE, before missing indexes were added | 3,000,301 | 288 grouped/indexed |
| Same correlated query with the previous patch's indexes | 1,674 | 288 grouped/indexed |
| Two queue counts + two queue loads + two history loads (partial idle tick only) | 2,086 | removed on idle |
| Complete idle tick including new budget ledger | not instrumented historically | 10 |
| Catalogue read per open | 3,000 | 14 on D1 snapshot hit; 0 on edge cache hit |
| 1,000 catalogue opens within one refresh window, no edge cache | 3,000,000 | 16,987 |
| Snapshot rebuild, at most every 5 minutes except explicit owner edits | 3,000 | 3,001 including migration marker |

Forecast from the fixture: approximately **1.41 million reads/day (28% of Free)**
for 144 posts, 288 cleanup ticks, 72 searches, worst-case 288 catalogue rebuilds,
1,000 uncached catalogue opens, all 1,440 heartbeats, and 100,000 spare reads.
This deliberately overcounts idle work already included in heavy ticks and does
not credit edge cache hits. It is an estimate, not a measured production day.
Actual failed-candidate frequency, visitor traffic and initial index construction
can change it; inspect real telemetry after reset.

### Query audit and changes

- `native_scheduler.mjs`: header reads config/policy by id, latest post via ts
  index, queue count via singleton counter. Does not load candidates/history on
  idle minutes or empty queue. Candidate LIMIT 300; delivery history LIMIT 4032
  via timestamp index, only for selection/check. Cleanup every 5 minutes, expiry
  batch LIMIT 500, cooldown inspection LIMIT 300, reactivation limited to remaining
  capacity below 300. Posted reconciliation scans only active ready candidates.
  Preflight at most every 5 minutes. Empty searches and blocked publishing back
  off for 5 minutes. Search topic aggregates run only on a due search, not every
  minute. Insertion uses the persistent count and available-capacity LIMIT.
  Photo lookup skips D1 for an observed image, otherwise uses exact PK + a
  bounded 8-row PK range; no OR/computed catalogue sort.
- `scheduler_api.mjs`: additive schema version 3 and ready counter triggers
  preserve settings/revision/history. New state/expiry, state/queue order,
  state/check timestamp and action timestamp indexes. History snapshot returns
  at most 4032 latest rows in ascending compatibility order. nmId duplicate
  checks remain PK `(pid,ts)` probes, never complete publication-history loads.
  Atomic claim's hourly/day counts use ts indexes and run ONLY on an actual
  send attempt. Two-row lease table is intentionally not over-indexed.
- `worker.mjs` / `catalog_cache.mjs`: Cloudflare Cache API for PUBLIC catalogue
  only, 60 seconds; persistent shared snapshot at 5-minute intervals. Atomic
  expiring refresh lease prevents multiple isolates from rebuilding together.
  Six bounded metadata pages prevent an oversized single D1 JSON row. Private
  saves, initData, preferences and outfits are never placed in shared caches.
  Owner edits explicitly invalidate the persistent snapshot. Saved queries use
  `(user_id,created_at)` / `(user_id,owned,product_id)`, LIMIT 1000. Outfits use
  existing `(user_id,id)` index and cap 50; product lookups use PK.
- `cron_driver.mjs`: legacy driver is not production. Its latest-post lookup is
  indexed, config/runtime are singleton reads and leases have two kinds. No new
  GitHub deployment credential or token is needed.
- `d1_budget.mjs`: both Cron and API report actual rows_read/rows_written plus
  top-three query fingerprints. No SQL text, bound values, tokens or personal
  data is logged. Missing metadata is not claimed as a zero-cost query.
- `read_guard.mjs`: atomic UTC-day budget shared across isolates: 1.5M reads
  reserved for runtime/control, separate 1.5M for catalogue/user traffic. Each
  operation reserves a conservative maximum and settles real D1 metadata.
  Failed/unknown executions retain reservations. Optional traffic cannot spend
  core funds. Separate write guards (35k core + 45k optional) prevent replacing
  the read-limit incident with a bookkeeping write-limit incident. Edge hits
  don't touch either ledger. Budget guards reject expensive work before SQL,
  leave the Cron configured, and reset by a new UTC-date primary key.

These are THIS Worker's protection limits, not an account-wide Cloudflare billing
counter. Ledger overhead, one-time migrations and unrelated account/database
traffic are outside the read aggregate. A reservation-overrun log is actionable;
do not assert an absolute account-wide guarantee under unknown other workloads.

### Reset verification and safe single-post recovery

Reset: **2026-10-04 00:00 UTC = 03:00 Europe/Moscow**. Existing minute Cron stays
ON; it retries without the PC. On the next independent Cron after a Telegram
receipt it persists `last_automatic_tick`, `production_chain_verified_at` and
`production_chain_message_id`, without another query.

Follow-up in this chat is scheduled for 03:15 Moscow (`wb-d1` heartbeat); that
agent follow-up needs the desktop app running, unlike production Cron.
The native workflow has `action=recovery`: it first reuses any ordinary receipt
after reset. Only if none exists does it create fixed action id
`d1-recovery-20261004` and execute one tick. Its bounded wait only reads state,
never sends repeatedly. Retry cannot create a second manual owner request.
It respects enabled/pause, quiet hours, gap and caps. Failed candidate validation
does not justify inventing a successful post; keep the task open until receipt
and following automatic tick are confirmed.

After reset check deployment version, schema_version=3, actual budget metrics,
settings, ready queue, real message_id and next automatic tick. Do NOT run a
series of public tests; a normal Cron receipt is sufficient. `/api/health`
exposes optimization version and Cloudflare runtime version for DEPLOYMENT
verification only; HTTP 200 is NOT scheduler health. No River/Admin UI changes.

### Deployment evidence

Fix commit `a3e5c5e0`, pushed main merge `3a0b9157` after preserving remote
`state.json` updates. GitHub CI run **37140337592 SUCCESS** (78 Worker tests plus
Python/build checks). Managed Workers Build
**43aaee00-4cfb-4e36-9bcf-a1cdd9176ae6 SUCCESS**. Actual public health identifies
`d1_optimization_version=3`, production runtime
`f2580b20-8114-4629-962c-895b906be0be`. One read-only post-deployment check
**37140541805** dispatched with no parallel native check, no Telegram send.
Actual scheduler/database recovery still requires the already-spent quota reset.
