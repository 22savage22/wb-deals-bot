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

One inference/execution; durable partial view resumes in a later execution,
within waitUntil grace. CLI vision timeout40s is isolated from posting client12s.
Persist profile per nmId and separately each successful photo analysis/hash.
No repeated main-image inference if secondary/retry fails; no vision for a
completed nmId on cron. New inventory INSERT triggers enqueue, existing inventory
seed is bounded100, not a new source of WB products. This
free bounded rate does NOT promise immediate analysis of all newly found cards.
Newest eligible products are prioritized with an explicit queue index. Legacy
cards with no observed photo are skipped, not repeatedly analyzed; a sidecar
trigger can requeue them if normal card validation later repairs their photo.

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

145Worker tests/build pass including11new visual pipeline tests;4real River Python
tests pass locally using existing repo-local environment. Tests cover unknown
fields/category schemas/front/back/conflicts/interactions, durable cache/restart,
future enqueue, racing jobs/stale lease, quota/license gates, unchanged30min,
real-event idempotency/index plan, frozen shadow comparison and Legacy selected.
These fixtures are NOT real WB/vision receipts or synthetic Telegram actors.
Real visual profiles and activation are PENDING OWNER LICENSE APPROVAL, not DONE.

## Real production receipts / license gate

Code through `3ca98935` pushed existing main; managed production build
`38f60526-c06f-4ce2-bded-2acbc983dc14` and full CI37343940060 SUCCESS.
No API management token, manual Telegram post or fabricated feedback was used.

Bounded probes:37341974220 missing observed photo;37343634507 established a real
Workers TypeError (redirect:error unsupported), corrected to manual+explicit
non-2xx rejection. Redirects never followed, tested before any AI call.
Probe https://github.com/22savage22/wb-deals-bot/actions/runs/37344157345 successfully
loaded the REAL photo for NEW nmId1018929124, then Workers AI returned AiError5016:
model agreement required. No agreement request has been sent. Automatic visual
enrichment remains disabled; profile cache is empty. Model license and AUP must
be approved explicitly by the owner before sending the documented agree request.
https://developers.cloudflare.com/workers-ai/platform/errors/
https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
Its actual D1 subtotal31reads/9writes (before ledger settlement), not billing.

### Owner-approved three-product verification: license gate remains

Owner explicitly approved Meta terms on 2026-10-05, with no paid plan, no
payment method and no paid external Vision API. Commits `6299d08e` / `9d9572b8`
add an idempotent agreement receipt, a frozen three-product sample, provider-only
metering and hash-matched photos for human review. Managed build
`3438cb0a-3de5-4ef5-9f29-8545d23a8d4c` and CI37348592183 succeeded;
148 Worker tests and 14 Python unit tests passed.

Live sample run37348900079 sent the documented `prompt: "agree"` via the AI
binding but failed before accepting/storing a receipt or selecting the sample.
Read-only run37349120184 confirms agreement outcome
`VISUAL_MODEL_TERMS_REQUIRED`, request_id
`c58099fb-3558-421d-812a-c5f4c9808774`, elapsed1457ms, terms=null,
sample=null, profiles empty and automatic enrichment disabled. Do NOT claim
terms accepted, tested profiles or actual Neurons from this failed request.
Dashboard page observations (DOM and screenshot) timed out; no UI agreement,
plan change, payment method or new token was created. Do not loop agreement
requests; finish the account-level agreement in the official dashboard first.

Fresh read-only production snapshot37349993925 succeeded at17:39UTC:
30min/revision1791202121046 unchanged, real message2563/nmId325766592 at
1791220161, following automatic tick1791221896 and matching chain2563.
Queue44, last WB search1791221303 found100/added2 NEW IDs10961167,1331848233,
backoff0/error empty. RiverSHADOW, real feedback70events. No manual post.
Bulk activation is gated pending three real profiles plus actual free-budget
verification; missing Neurons must stay unknown, not be replaced by an estimate.

Readonly admin snapshot37344352509 confirms unchanged30min/revision1791202121046,
enabled/unpaused/Cronactive, automatic real message2562/nmId237526454 at1791218301,
independent tick1791219256>post and matching chain2562; queue42/post_retry0/error
empty. WB Cron search1791218423 found100/added3 NEW ids1018929124,987817659,852361305,
queue39→42/no backoff. Visual enabledfalse/last_errorMODEL_TERMS_REQUIRED.
https://github.com/22savage22/wb-deals-bot/actions/runs/37344352509

Real feedback check37344769893: main webhookOK/pending0/error empty; real update
810945058/message2561/nmId82035034 ACK66ms, D1 dislike1/dirty0/error empty, actual
edit receipt markup👍0/👎1/🛒0. No new reaction actor or test message.
https://github.com/22savage22/wb-deals-bot/actions/runs/37344769893
Existing River workflow active07/27/47 UTC but real execution history is delayed.
One dispatch returned GitHub500; active-run check confirmed not accepted before
retry. Existing job37344853563 SUCCESS processed the already-present REAL next
event: cursor/trained67, comparisons41, publication_controlfalse. This was a
manual verification, NOT proof that scheduled GitHub runs execute on time.
https://github.com/22savage22/wb-deals-bot/actions/runs/37344853563

Next step: explicit owner approval for Meta license/AUP; then authorize a guarded
one-time agreement operation, obtain2–3real profiles, verify visible evidence,
activate the independent enrichment and prove its next automatic run. Keep
RiverSHADOW, LegacyACTIVE, publication30min and current production settings.
