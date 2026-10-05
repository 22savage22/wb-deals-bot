# Visual audience learning — 2026-10-05

## Production boundary

Baseline read-only run37337857101: interval30, revision1791202121046,
Cronactive, queue43, automaticpost2560 and subsequent tick1791216196,
WBsuccess1791215903/no backoff, RiverSHADOW. Preserve these settings.
No manual Telegram send/vote, tokens, old polling or public frontend edits.

Visual enrichment is a separate D1 queue and Workers AI binding; no CF management
token at runtime. The scheduler's publication/search implementation is unchanged.
An independent optional waitUntil phase after posting runs only at03/23/43 UTC.
Cron Trigger itself remains minute-based. Phase disabled until a useful real
profile is confirmed and explicitly activated by the deployment verification.
Its error cannot reject or stop a production publication; optional D1 budget,
separate180s lease, per-card retries300s exponential+jitter/max6h/five attempts,
quota wait until UTC reset. No background job needs the owner's PC.

## Cost before activation

Primary model `@cf/meta/llama-3.2-11b-vision-instruct` using the existing account's
Workers AI binding. No paid plan upgrade, API token or paid-model fallback.
Official free allowance10000neurons/day; input4410/M, output61493/M.
https://developers.cloudflare.com/workers-ai/platform/pricing/
https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/

Hard local cap40inference ATTEMPTS/day shared persistently, failures included.
At most2photos/product,512KB/photo,600outputtokens/inference,22s timeout.
Example estimate with6000inputtokens/inference: (6000*4410/1M +600*61493/1M)
*40≈2534neurons/day. This is an assumption/estimate, NOT actual account metering
or a hard neuron bound. Account-level Free quota is authoritative; on exhaustion
defer, never upgrade. Other account AI usage shares the free allowance.
Dashboard read twice timed out; account-plan/account-wide neuron billing has not
yet been freshly verified through that UI. Do not call this confirmed billing.
If provider requires new license/paid permission, stop visual activation at that
gate; do not accept a new binding legal agreement silently.

Persist profile per nmId and separately each successful photo analysis/hash.
No repeated main-image inference if secondary/retry fails; no vision for a
completed nmId on cron. New inventory INSERT triggers enqueue, existing inventory
seed is bounded100, not a new source of WB products. Backlog is visible; this
free bounded rate does NOT promise immediate analysis of all newly found cards.

## Evidence, features, combinations

Closed typed vocabulary: universal color/palette/pattern/style/texture/complexity
plus apparel, shoes, bag, accessory, home, beauty, electronics and other schemas.
Only visible fields with evidence and model self-confidence>=.8 accepted.
Missing/contradictory fields excluded; front-only image cannot establish back print.
Exact material composition/comfort/physical dimensions unknown, never inferred
from titles. Image URLs restricted to observed WB basket shards; redirects refused.
No user IDs or personal recommendations. Product images are public catalog data.

At most18fields +8 predefined interactions, no combinatorial explosion.
Examples: color+fit+print location; pattern+print location; style+shape;
color+shape+sole; color+carry. River retains existing metadata/time/history features.
Cached visual features attach to new feedback and still-untrained real events.
No event generation, duplicate feedback, replay of trained category observations,
or replacement of stored pre-delivery comparison probabilities.
Shadow candidate evaluation reads profiles by PK set/LIMIT300. Legacy remains
the real selected row. Missing cache/table/model always retains current behavior.

## Honest owner insights and cadence

Visual event aggregates use event_id idempotency, small incremental batches5,
PK/rank indexes, unique explicit-reaction products. Per-profile historical replay
is also bounded5 with cursor; future/new profiles can link old REAL reactions
descriptively without rewriting ML feedback/training history.
Like/dislike/bought/save/click counts separate. Preference direction requires
20explicit like/dislike signals, >=20observations, >=5different reacted products,
and Wilson95% interval entirely above/below .5. Otherwise insufficient data.
No invented uplift or causal sales conclusion. Model visual confidence is
self-assessment, not a calibrated statistical probability.

Existing River learning.yml already scheduled07/27/47 UTC (20min); its schedule,
concurrency and training process retained. Actual history has long GitHub delays;
Admin shows actual last reaction/model update, next PLANNED slot and delayed
warning, not a false promise of exact execution. Production Cron independent.

## Verification

142Worker tests/build pass including8new visual pipeline tests;4real River Python
tests pass locally using existing repo-local environment. Tests cover unknown
fields/category schemas/front/back/conflicts/interactions, durable cache/restart,
future enqueue, racing jobs/stale lease, quota/license gates, unchanged30min,
real-event idempotency/index plan, frozen shadow comparison and Legacy selected.
These fixtures are NOT real WB/vision receipts or synthetic Telegram actors.
Real profiles, activation, production continuation and deployment receipts pending.
