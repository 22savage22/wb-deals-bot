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
- Honor configured 20 minutes even when the queue is under target. Manual search
  retains a five-minute minimum gap and cannot bypass upstream cooldown.
- Persist admission before network I/O so killed executions cannot retry each minute.
- Exponential 300-second base (900 for 403), positive 0–25% jitter, six-hour cap;
  honor Retry-After seconds or HTTP date (up to one day). No immediate alternate
  destination on 403/429. Auto resume after cooldown; success clears old error/code.
- Skip saturated topics, preserve existing rotation, policy, history and SHADOW.
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
