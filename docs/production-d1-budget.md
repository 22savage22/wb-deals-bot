# Production gate before Admin / River modernization

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
