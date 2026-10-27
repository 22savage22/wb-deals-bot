# Six successful publications per Moscow day — preparation only

This branch starts at main `524fbe8931b911e4c3bc4e05de7caf5003b1decc`.
It includes none of PR15/16/17, the fashion selector, or the rotation-cursor fix.
No production code, settings, Cron, Telegram delivery, queue or user data have
been changed. The proposed profile reuses the existing scheduler configuration:

| Existing field | Proposed value |
|---|---|
| timezone | Europe/Moscow |
| mode | interval |
| post_interval_minutes | 120 |
| min_post_gap_minutes | 120 |
| max_posts_hour | 1 |
| max_posts_day | 6 |
| natural_interval_enabled / jitter_minutes | false / 0 |

`daily-six-profile.json` is a patch for a freshly read real configuration, not
a substitute local production configuration. Other fields, search settings,
quiet hours, weekdays and enabled/paused state must be preserved. There is no
new activation flag, table, daily counter service or admin interface. Nothing
applies this patch automatically. Existing general-purpose validation/defaults
remain compatible with the current 30-minute/144-post profile until the owner
approves a configuration change. Clients cannot weaken the configured limits
by supplying a larger max_day or smaller minimum gap in a claim request.

## Confirmed defects and correction

The original claim gate counted successful *claims* on their creation date.
A claim at 23:59:59 Moscow followed by success at 00:00:01 consumed yesterday's
claim count while the actual post belonged to today. A successful-post ledger
imported without claim rows also failed to consume capacity.

The authoritative count now uses indexed `scheduler_posts.ts` ranges for the
actual confirmation timestamp. Existing atomic claim, lease, unique product
tombstone and once-only completion prevent parallel/retry admission. The D1
ledger survives Worker/isolate restarts. No counter resets or new schema are
needed at midnight; the next calendar range is calculated from Europe/Moscow.

Pending/error outcomes reserve capacity separately from confirmed successes.
A pending/error claim in the last 1,800 seconds before midnight is conservatively
reserved in the following day too; 1,800 seconds is the existing maximum post
lease. This may produce fewer than six confirmed posts. It is never reported
as an extra successful post. A timeout/malformed outcome is not automatically
retried. As with any Telegram API without a server-side idempotency key, an
unknown outcome needs operator reconciliation; tests cannot prove the remote
service's actual acceptance timestamp after a lost response. Never erase a
claim or resend the same uncertain product blindly.

A parsed Telegram `ok:false` confirms a failed attempt and no longer consumes
successful/uncertain capacity. The product tombstone and its diagnostic state
remain. A definitive photo URL failure may use the existing upload fallback,
but the live schedule, owner rules, quota, pending claim and lease are checked
again before that second physical send. No new retry route was introduced.

The final owner-policy read now also checks live schedule/caps/lease after
WB/SHADOW work. A pause or cap change before a transport attempt holds the item.
If a day changes while this final read is in flight, the send is deferred.
No quota cache can authorize a post: every admission still uses D1.

## Repeated Cron after six posts

On a six-or-lower configured cap, the existing post-header query checks the
day ledger before WB validation. When full, a skip-only marker in the existing
`scheduler_config.status` lasts until the next local midnight. The marker is
bound to the complete validated schedule, so a settings change invalidates it.
It is also recorded in the existing successful status write when a confirmed
send fills the remaining capacity on the same calendar day.

Subsequent capped ticks do not load posting candidates or revalidate WB. Idle
maintenance, search and reaction repair remain available; reaching the cap is
not marked watchdog-overdue, and next_post points no earlier than midnight.
An absent/stale marker only causes an authoritative recheck; it cannot allow a
seventh post. There is no new D1 table, background process or learned state.

## Local evidence and limits

Eight focused cases cover: Moscow midnight success attribution, six versus
seven, manual 120-minute safety gap, confirmed failure, unknown reservations,
fresh-environment persistence, parallel ticks, changed final caps and paused
photo retries, expiry of the full-day marker and midnight during its precheck.
All network responses are intercepted fixtures; no real
Telegram messages or live price/stock observations are produced.

The read-only 27 October snapshot at 13:03:09 Moscow contains 71 real ready rows
and 100 successful-post rows. Twenty-five belong to the current Moscow day.
A local replay with the proposed profile holds the first due tick and the
following 30-minute tick: zero WB requests, zero Telegram calls, zero new posts.
The first tick used 11 local SQL statements; the subsequent idle/maintenance
tick used 14. Two source rows expired at the virtual replay time, using the
existing expiry rules; production inventory did not change. The replay uses
the actual successful ledger and does not invent or reconstruct historical
claim rows. Last-six actual timestamps are retained in its private receipt.
Fixture detailed prices/stock, if requested, are explicitly synthetic values
from the saved products, not current verified offers.

The existing Worker suite passes 235 cases (227 existing plus eight focused
cases). Local build and `wrangler deploy --dry-run` pass. The generated admin
assets had to be built before the complete suite; the initial three missing-
asset failures were setup errors, not quota failures. No production CPU test,
new load test, official D1 rows_read measurement or Cloudflare deployment was
performed. Local SQL counts do not establish Free CPU/D1 headroom. The main
task's observed CPU release blocker still applies.

## Cron interval is separate and not approved

The real checked-in Cron remains `* * * * *`. The proposed `*/30 * * * *` appears
only as a blocked proposal in the profile document. Simply changing it would
make existing 180-second heartbeat checks report a healthy 30-minute Cron as
stale. The style catalogue job's modulo-20-minute condition would also run at
different times, and search/backoff/repair latency changes. These dependencies
need separate validation and CPU/D1 evidence before a Cron change. A 120-minute
post interval with a six-post day cap is independently compatible with the
current minute checker; fewer actual posts do not mean fewer Cron invocations.

## Activation and rollback after explicit owner approval

1. Review this separate patch and its selected build. Do not automatically
   merge PR15/16/17 or fashion/rotation changes into it.
2. Read and back up current Worker version, scheduler configuration/revision,
   policy and recent successful/uncertain claims; keep a fresh D1 checkpoint.
   An old SQL backup is not a current backup. Keep private data out of PR text.
3. Deploy only after approval and CPU/D1 release evidence. Apply the proposed
   profile through the existing GET + revision/CAS PUT, preserving other real
   fields. Do not change Cron in this release.
4. If the calendar day already has more than six old-profile posts, do not reset
   its history or grant six more. Hold until the next Moscow midnight. The first
   full six-or-fewer calendar day is the following date.
5. Check actual due times, accepted message IDs, D1 success count and callbacks;
   a lack of suitable goods means fewer posts. A six-post allowance never
   authorizes a poor item, cached price, owner-ban exception or AI call.

Rollback changes code/settings after the current invocation/lease completes and
pending manual requests are accounted for. Preserve posts, deliveries, reactions,
claims, admin and Mini App data. Never restore an old D1 database to undo a code
release or resend already delivered products. Switching back to the old
30-minute/144-post settings would contradict the new approved concept; it is not
an automatic rollback. Prefer retaining the safe six/day + 120-minute profile
while reverting code, or hold posting until the owner explicitly resolves the
fault. Old code counts claims imperfectly across midnight, so a known-good
rollback alone is not proof of the new daily guarantee.
