# Separate owner admin and bounded River SHADOW

The public `miniapp/static/` files are unchanged. `/admin` bundles React 18 and
the MIT-licensed `@telegram-apps/telegram-ui` 2.1.13. Worker API requests validate
Telegram initData HMAC, expiry, duplicate fields and `MINIAPP_ADMIN_ID`. The HTML
shell is public, but contains no settings or credentials. Non-owner requests
are rejected before any D1 ledger access. `/start admin` and `/admin` in the
existing Mini App bot provide the owner-only web_app button.

## Safe runtime

Minute Cloudflare Cron, D1 schedule/queue, leases, claims, topic/diversity filters
and Telegram delivery remain the production engine. The new UI does not post
or search in its HTTP button handler. It enqueues a durable request and returns
HTTP 202; Cron executes it with the existing schedule, quiet hours, gap/caps and
unknown-delivery quarantine. Per-device sessionStorage IDs protect network
retries; server-side coalescing protects simultaneous clicks on two devices.

Pause/resume uses the existing CAS configuration mechanism. Custom intervals,
fixed times, weekdays, quiet hours, timezone and minimum queue persist in D1.
The owner sees a *planned* next slot: source/product failures and existing safety
limits can delay actual delivery. Search is independent of posting pause;
low reserves accelerate refill using existing bounded backoff.

The diagnostic button accepts an idempotent check and uses `ctx.waitUntil` with
its own D1 reservation. Its result is stored in scheduler status. It performs
getMe, WB card/photo checks, never sendPhoto/sendMessage to the channel. Timeout
cannot hold a permanent lock: the check lease expires after 120 seconds.

Main-channel callbacks still use the existing getUpdates consumer. Every fetched
callback batch is now acknowledged before any slow command is processed. A
main-bot webhook switch is intentionally NOT made: it would disable getUpdates
and lose unsupported legacy admin/message handlers. The new Mini App has no
polling dependency. This does not promise sub-second delivery while the old
poller is offline; only acknowledgement after a fetched update is immediate.

## River, not a replacement scheduler

River 0.26.1 runs in the independent, read-only-publication GitHub learning job
every 20 minutes (GitHub schedule may delay). It transfers bounded JSON weights,
never pickle. Default SHADOW never changes Legacy's actual selection. Failures
in storage, model inference, learning CI or optional quota retain Legacy.
LEARNING is server-blocked until an independent quality review; no automated
switch based on misleading uplift. LEGACY retains learning data but skips model
training. A stopped training job cannot stop Cron/posting.

Product category/query/brand/price/discount/rating/reviews/audience/type/local
hour/weekday and historical category response are used when available. Missing
values remain explicit empty/default values, not fabricated facts. Save/owned
signals from the existing app and aggregated like/dislike/bought feedback are
ingested idempotently. No extra click tracker or personal profile is introduced.
Poll imports strip voter IDs; save/buy deduplication uses an opaque HMAC key.

Each observation stores Legacy's real choice and River's hypothetical choice.
Audience feedback for an unpublished River choice is never invented. The
prequential Brier comparison is River vs historical category-positive baseline
on the same actually posted items, not a causal publication A/B improvement.
Only feedback after that snapshot is eligible. Minimum display threshold:
200 reactions, 20 actually posted products, 7 days; publication uplift is null.

Exploration defaults to 10%, configurable 0–30%. It explores less-represented
topics in the owner's existing search pool and preserves disabled topics/daily
caps. Publication diversity/accessory/audience rotation remains Legacy in SHADOW.

## D1 budget evidence (local workerd/Miniflare, synthetic cards)

`node miniapp/cloudflare/admin_benchmark.mjs` uses actual D1 result metadata:

| Operation | rows_read | rows_written |
| --- | ---: | ---: |
| Owner overview | 4 | 0 |
| Learning screen, 20 categories | 25 | 0 |
| Training batch, 40 existing event records | 122 | 0 |
| 20-product import, 60 new aggregate records | 702 | 501 |
| Shadow selection, 300 candidates / 20 categories | 23 | 2 |

Estimated extra reads/day: **90,818** with the owner screen visible all day
(2,880 refreshes), 144 posts, 72 learning jobs, 10 learning screen opens, plus
10,000 safety margin. This is a scenario estimate, not today's production bill.
Import worst-case writes ~36k/day assumes three NEW feedback counters on every
20-card batch; actual traffic is smaller. Learning uses the OPTIONAL reservation
lane (45k writes), not the production core (35k writes). Existing hard daily
guards remain 1.5m core + 1.5m optional reads and 80k total accounted writes.

All learning lookups use primary keys/indexes and LIMIT (500 new events, 200
Shadow category priors, 30 displayed categories, 20 imported products). Trigger
aggregates avoid history scans. Idle Cron performs zero added ML queries; Shadow
adds three on a post and one on a due search, only after explicit preparation.
Cold pre-learning v2 migration + post remains within the Free 50-query limit.

## Verification

89 Worker tests, three real-River Python tests, existing legacy tests and deploy
dry-run passed locally before publication. Coverage includes owner auth, durable
settings, double-click/offline idempotency, slow checks, no channel posts during
diagnostics, quiet overnight/quarter-hour timezone, Shadow no-selection-change,
model CAS and missing learning storage. Public source diff remains empty.

Browser mobile preview could not be opened by Computer Use (`ERR_BLOCKED_BY_CLIENT`);
Cloudflare Dashboard DOM timed out. No security bypass was attempted. Phone visual
verification and historical 28.6% error-rate attribution are NOT claimed from
these failed browser checks. Fresh production receipts/automatic ticks are the
runtime evidence; deployment/learning/owner invite evidence is recorded separately.

### Production blocker discovered after deployment

Read-only production runs showed real Cron continued but no post after message
2479. Indexed diagnostic run **37198425510** proved selected nmId **875043740**
had a `scheduler_claims.status=error` tombstone (ts1791077086), no corresponding
successful post, yet inventory remained `ready`, retry_at1791077392 already past.
The chooser preferred its verified photo repeatedly, and each claim was rejected
by seven-day duplicate protection. This pre-existing ready/tombstone mismatch
predates the new admin deployment; it is not a new D1 daily-quota outage.

A regression reproduced the loop. On claim conflict the publisher now performs
one primary-key lookup: a recent prior product claim moves that card to
`uncertain` (or `posted` for successful delivery) while retaining the tombstone.
The NEXT normal minute can choose a different product; no blind duplicate retry.
Global hourly/daily limits and safety-gap failures do not evict unclaimed cards.
New Telegram rejections also cannot return a tombstoned card to the ready pool.
90 Worker tests pass including this case. Live post + subsequent independent
Cron after this repair still require explicit production evidence below.
