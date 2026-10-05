# WB discovery: persistent pacing and upstream 429

## Evidence before changes (2026-10-05)

Read-only Actions run 37298813937: WB search **already returned 100 cards** at
1791196320, query `костюм женский`, 10 known / 0 admitted. `last_scan_error` was
empty, but `last_scan_error_code=WB HTTP 429` from an earlier attempt remained.
`source()` constructs that code only from the external fetch response status;
the Mini App user limiter and D1 admission guard do not construct `WB HTTP ...`.
The historical response headers were not recorded: no unsupported claim about
WB's internal threshold or whether its edge returned the response.

The search interval was configured to 20 minutes, but underfilled inventory
overrode it to 60 seconds after success / 300 after no results. A fixed 300-second
retry never grew after repeated throttling. Different queries shared neither a
persisted minimum spacing nor an exponential failure streak. A global search
lease already existed; no evidence establishes parallel WB fetches as the cause.
The separate Mini App catalog workflow uses another WB egress Worker: it is not
the native D1 search lease and was not disabled on speculation.

## Narrow changes

- Cron Trigger, posting selection/claims/send/retry and schedule data unchanged.
- One search globally under a TTL lease; re-read state after acquisition.
- Honor configured 20 minutes after replenishment even when queue is under target.
  A healthy zero-admission response rotates one query after 5 minutes (never 1).
  Error backoff takes priority over this bounded recovery. Manual search
  retains a five-minute minimum gap and cannot bypass upstream cooldown.
- Persist admission before network I/O so killed executions cannot retry each minute.
- Exponential 300-second base (900 for 403), positive 0–25% jitter, six-hour cap;
  honor Retry-After seconds or HTTP date (up to one day). No immediate alternate
  destination on 403/429. Auto resume after cooldown; success clears old error/code.
- Skip saturated topics, preserve existing rotation, policy, history and SHADOW.
- Pass the owner's existing price ceiling as search `priceU` (kopecks), keep
  the local price/quality filter authoritative; rotate popular/priceup instead
  of unrated newly-created listings. New means absent from our three databases,
  not necessarily newly listed on WB. Log separate filter rejection reasons.
  Live run37302763677 proved old WB v9 ignored priceU (71 over-budget/2 rating/
  27 known); never trust the request filter without rechecking actual card prices.
- At most three newly found products: live detail batch, current real price,
  sequential verified image GETs, 28-second image deadline / six probes per card.
  Known IDs and title duplicates checked with existing indexed keys.
- Persist actual INSERT RETURNING IDs and a bounded receipt with source, origin,
  found/known/filter counts, queue before/after, prices and verified image URLs.
  Read-only diagnostic verifies those exact inventory rows.
- Discovery's measured D1 work uses the optional lane instead of posting funds.
  Same aggregate ceilings: 3M reads and 80k writes; split 2M/1M reads and 50k/30k
  writes (core/optional), plus unchanged tiny diagnostics. No ledger reset or
  erased usage. This avoids an underfilled queue consuming the posting allowance.
- Source error provenance stores host/path/status/Retry-After and bounded server/
  content-type only; never raw responses, cookies, auth headers or secret URLs.

## Production acceptance gate

Normal Cloudflare Cron must create `last_search_add_receipt.origin=cron` with
`added>0`, new IDs absent from all three indexed historical/local catalogs before
insertion, verified prices/images, matching D1 inventory rows, queue > 0 and a
future next_search. Local fixtures, manual ticks and HTTP health are not proof.
Do not create manual Telegram posts for this task.

## Verified production acceptance (2026-10-05 14:31:37 Europe/Moscow)

Read-only Actions https://github.com/22savage22/wb-deals-bot/actions/runs/37303717920
SUCCESS, source-code commit88c853e23736cecd91207ef05c7393f9b8216205,
Workerf829319b-c42a-4a52-87e7-ec3a75e30c73. Ordinary automatic Cron, no manual
search request, tick or Telegram publication was used in this task.

- WB SEARCH SUCCESS: `украшения женские`, `popular`, found100, already-known24.
- Eight new policy-approved candidates; three independently detailed and
  image-GET verified; INSERT RETURNING admitted3 genuinely new IDs.
- Queue41 →44; all three persisted inventory rows `ready`, queued_at and
  checked_at1791199891; search receipt1791199897, origin`cron`.
- 1175578179, «Подвеска бижутерная крылья ангела на цепочке»,153₽.
- 1161397082, «Женское ожерелье из нержавеющей стали D White-Necklace»,623₽.
- 1141501376, «Серьги каффы без прокола на уши бижутерия»,546₽.
- All verified images: basket-43.wbbasket.ru, each nmId's own
  `/vol.../part.../<nmId>/images/big/1.webp`; links use those same IDs on WB.
- Next search1791201097 (14:51:37 Moscow); search_retry_at0, error empty,
  active leases empty; next ordinary tick1791199996 (14:33:16) > receipt.
- Official D1 metadata for completed discovery before receipt-write:22queries,
  1387rows_read/31rows_written (not mocked metadata or a whole-history scan).
  This representative cycle×72 =99864reads/day for discovery, far below its1M
  guard; this is an estimate, not a claim every query has identical cost.
- Posting remained autonomous: ordinary posts2549/2550/2551 verified during
  work; no posting branch/config/Cron trigger/reaction/UI/River changes.
- 119 Worker tests passed, full CI37303181476SUCCESS, Workers Builds managed
  deployment03a7cbba-911d-4f14-8d09-89acd869598fSUCCESS.

The historical429 was an upstream HTTP response, not the Mini App private
limiter. Its exact server-side threshold cannot be reconstructed from absent
historical headers. Main verified local faults were stale429 status after
success, overly frequent refill requests, fixed retry, and over-budget results
that WB v9 did not exclude despite priceU. Do not claim the remote market will
never throttle again: cooldown/persistent queue preserve normal operation.
