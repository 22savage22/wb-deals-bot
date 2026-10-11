# Visual audience learning — 2026-10-05

## Current isolated-agent boundary — 2026-10-10

The independent `codex/visual-staging-agent-20261010` branch continues PR #7 in
`D:\WB-Vision-Agent`. Its separate `wb-finds-visual-staging` Worker contains no
production assets/Cron/Telegram credentials and binds only the pinned staging
D1. See `visual-staging-setup.md`; the historical shared-preview instructions
below are not this agent's deployment route. No production deployment or merge
is authorized. Model remains the already-compared Gemma; River stays SHADOW.

Unknown inference cost now creates an indexed durable daily budget hold. This
also detects a crashed unsettled attempt and migrates existing unmetered calls
for the current day. New products/force/restarted isolates cannot spend further
until a new UTC day; automatic processing remains OFF. Cache hits still work.
Provider usage beside a native `result` envelope is retained rather than lost.
An AI allocation/timeout error retains its reserve; it never triggers an
unbounded retry. Staging refuses new inference unless a freshly observed actual
Free-account remainder covers the entire reserved 5000-Neuron test budget.
`/activate` refuses even a reviewed historical receipt while account-wide
remaining usage is unknown. This supersedes the activation steps below.

Local tests/dry-run are not native AI receipts. This independent run has not
yet deployed staging, migrated remote D1, or spent AI Neurons. OAuth owner
authorization and actual account usage observation remain pending. Previous
ten-photo REST quality/cost results are historical, not fresh native evidence.

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
# Isolated quality revision — 2026-10-09

This section describes prepared version 2, not deployed production. Production
remains Visual OFF, posting every 30 minutes, WB Search enabled, Telegram reactions
active and River SHADOW. No deployment, workflow/config edits or mass processing.

## Real evidence and model choice

- Previous Llama output: arrays without evidence/confidence plus trailing period;
  a second response omitted its root closing brace and confused turquoise with
  blue. 35/196 completion tokens against a 600-token request do not indicate the
  requested output ceiling was reached; provider finish reasons were absent.
- New isolated experiment: 10 real WB photographs across shirts, polo, sneakers,
  bags, earrings, dresses and tights. Gemma 4 JSON Mode produced 9/10 usable first
  responses after vocabulary normalization. One format retry fixed an object in
  the earrings' `group`. One additional coverage check recovered the dress's
  print size/location. Final useful profiles: 10/10.
- Manual reference check: 39/39 returned control attributes matched the photos;
  39/42 reference attributes were returned. Color 10/10; unseen-back guesses 0.
  This is a small photo review, not calibrated or broad-category accuracy. Style
  remains a labelled hypothesis. Additional unlisted fields were not scored.
- Three shared photographs: Llama yielded no profile with two useful attributes;
  its output was prose or only a color. Gemma yielded useful structured profiles.
  Gemma 3's former catalog page redirects; Gemma 4 is currently listed as Free
  plan eligible. Paid-only models and AI Gateway billing are not used.
- Actual provider meter: 12 Gemma calls = 141.21817588806152 Neurons;
  4 Llama calls = 160.639774749625; new total 301.85795063768654.
  Known same-day total including the previous test/agreement is 428.9449778260615
  of 10,000. Other account usage is unknown. No repeat `agree` was sent.

## Reliability and native operation

- Full JSON parsing: no substring extraction, Markdown stripping, brace guessing
  or prose acceptance. Validate root/category/view/field types and vocabulary;
  arrays are format failures. Keep only numerical confidence >=0.8 plus visible
  evidence; missing, weak or contradictory evidence stays unknown.
- Synonyms normalize spelling only; never manufacture confidence or evidence.
  Navy, turquoise and metallic appearance colors have explicit values. A side
  view is valid. No claims about actual metal/composition, comfort or centimetres.
- Print placement is limited to shown panels. `all_over` on a front-only photo
  becomes `front`; `front_and_back` needs both views or separate known views.
  An unseen back always stays unknown. Conflicting views lose the feature.
- At most one format retry per product/image SHA-256/model/schema version,
  persisted in `visual_format_failures` across restarts. Each execution has at
  most one inference. Exhausted/empty profiles cannot become successful cache
  records. An absent second photo never creates a back claim.
- Cache identity: product + actual image bytes + model + version; inventory URL
  and explicit image-version changes requeue verification. Same-byte images are
  reused, including duplicate panels. Fresh profile cache needs no image fetch;
  after 24h an explicit run verifies bytes again. A changed version with unchanged
  bytes adds no AI call. Persistent cache replay in a fresh process without a
  credential confirmed 10 hits and zero provider calls.
- Native `env.AI.run` already exists in wrangler.jsonc; v2 selects Gemma 4,
  encodes the public image, requests JSON Mode, caps output at 900 tokens and
  disables thinking. It contains no Cloudflare API token and needs no local
  handoff form. Existing Meta acceptance route still names Llama explicitly;
  ongoing Gemma inference does not call that route. Live v2 binding deployment
  was not performed; binding inputs and response parsing are verified locally.

## Free budget and release gate

- Sidecar cap: 5,000 Neurons per UTC day, plus existing 40-call cap. Atomically
  reserve 2,500 before dispatch, a conservative upper bound from Gemma's 256k
  context and <=900 output-token pricing. Settle only actual provider Neurons.
  Missing metering, transport errors and timeouts retain the reservation.
- Provider quota error 3036 blocks the whole sidecar for the rest of the UTC day;
  the next day uses a new budget row. Model Paid/terms errors disable enrichment.
  Account Free plan remains the hard no-billing boundary; this local ledger does
  not measure other account consumers and never upgrades the plan.
- Initial experiment separately capped at 2,500 Neurons and 25 requests/10 IDs.
  The token existed only in the RAM-only session, then the process exited and
  confirmed credential clearing. Cache/receipts contain no credentials.
- Keep the existing bulk activation gate locked. Photo review and an explicitly
  approved staged release are needed before deploying or enabling production.
  The old fixed-three sample workflow is not a ten-product quality experiment;
  do not run it to repeat agreement or overwrite the isolated test.

Primary references: https://developers.cloudflare.com/workers-ai/platform/pricing/
and https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/ .

## Owner-authorized staging and prepared limited release — 2026-10-09

The owner reviewed the real ten-product gallery. The latest instruction authorizes
a separate free D1, a GitHub branch and a draft PR, plus full isolated staging.
It explicitly requires a NEW owner confirmation before production deployment or
activation. Live staging success by itself is not that confirmation. This release
does not permit bulk processing. The native AI binding needs no local AI token.

- `visual_daily_products` admits at most ten distinct products per UTC day in
  one atomic statement. Failed calls count; retries and a second view retain the
  same slot. A fresh UTC day creates new admission rows. Cache hits need no slot.
- A hash/model/version index reuses identical image bytes across products.
  Explicit image changes still verify the real bytes before accepting a cache.
- Retain the 5,000-Neuron daily cap, 2,500 pre-call reserve and 40-call ceiling.
  Unmetered calls retain their reserve. The `/review` operation charges measured
  external staging/REST consumption to the production budget exactly once for
  its receipt, so a staging test is not ignored by the initial production cap.
- `/review` requires the explicit reviewed-ten-photo approval, report SHA-256,
  measured native staging receipt, zero extra cache calls and actual D1 metadata.
  `/activate` additionally requires River SHADOW and a useful current profile.
  Both use the existing protected scheduler authorization. Neither edits posting,
  search, reactions or admin settings. An absent proof cannot activate the sidecar.
- The Learning page shows profile coverage, real reaction-event/product counts,
  daily product admission and conservative Neuron charge. Preference conclusions
  require at least 20 observations, 20 likes/dislikes and five products per feature,
  plus a Wilson interval showing direction. Unknowns and unconfirmed backs stay
  unknown; model style confidence remains a hypothesis, not calibrated accuracy.

### Isolated native staging path

1. The owner created `wb-finds-visual-staging` and supplied database UUID
   `5779987d-1100-45ad-8cd4-9df9c1436a20`. This is the only accepted staging
   binding; another UUID or the production database fails closed. Reuse the
   existing Workers Builds credential/integration with Account → Workers Scripts
   Edit for this account. The bootstrap no longer lists or creates databases and
   does not require D1 API permissions. Never recover the old WB Vision AI token
   or create a new AI token. An account member allowed to edit Builds must enable
   this preview path. The owner-supplied creation is not remotely verified yet.
2. `bootstrap-visual-staging.mjs` runs only inside managed Workers Builds on
   `codex/visual-enrichment-v2`. It generates the isolated config from that pinned
   database UUID. Transport failures, an unexpected branch and another database
   fail closed. No D1 control-plane API is called.
   No raw CLI/provider error, credential, headers or auth file is printed/saved.
   First enable Worker Settings → Domains & Routes → Version URLs for preview
   access. The bootstrap checks this flag and stops if disabled; it never changes
   that shared service setting itself. Root production config remains unchanged.
3. Allow preview builds only for the release branch. Its preview command is
   `node miniapp/cloudflare/bootstrap-visual-staging.mjs`.
   Preserve the existing production branch/build/deploy command. This uploads a
   version; it does not promote it. The returned immutable version URL is checked
   against the exact uploaded version ID to refuse a stale alias. It reads back
   the uploaded version and checks its actual D1 UUID, native AI binding and
   fetch-only handler before accepting health. The generated config preserves
   existing secret bindings without reading their values.
4. The staging entry point exports no Cron handler or Telegram/search/feedback
   operation. Only existing-sync-key-authorized initialization, fixed public-photo
   seed/run/status routes exist. Health and status identify the pinned database;
   the runner also verifies the actual learning configuration is River SHADOW.
   Four separate initialization requests keep DDL below the Free subrequest
   ceiling. Four SQL exports in `miniapp/cloudflare/staging-migrations/` are
   generated offline from those same initialization handlers and tested twice
   against an empty SQLite database. Regenerate them with
   `node miniapp/cloudflare/prepare-visual-staging-migrations.mjs`.
   The live runner initializes through the protected binding routes, not a D1
   API token or a manually selected Dashboard database.
5. Dispatch existing `test.yml` on the release branch with `visual_staging_url`
   set to the version URL. The runner uses the existing encrypted sync secret,
   analyses all ten reviewed byte versions to verify the native execution path,
   immediately repeats each to prove durable cache, and records provider
   Neurons + D1 row metadata. Already useful staging profiles are never reinferred
   by an ordinary repeat. Known prior same-day experiment usage is charged once
   before staging inference; other account consumers remain unknown.
   It rejects the production URL, redirects, incomplete profiles, missing meter
   and enabled staging. One workflow format retry honors the recorded backoff;
   quota, transport and second format failures stop the workflow. It compares
   42 visible reference attributes, requires every returned reference attribute
   to match, >=85% coverage and all ten colors. Style is excluded; unseen backs
   and composition remain unknown. Changed image bytes invalidate the reference.
   JSON receipt and photo/profile gallery are saved even if that quality gate
   fails. This small sample is not a broad model-accuracy claim. No agreement is
   repeated, posting route exposed or synthetic reactions recorded.
6. Review those actual photos and returned profiles and obtain NEW explicit
   owner confirmation. Only then deploy the identical enrichment modules with the normal root config
   and existing managed main build; preserve all runtime settings/secrets/cron.
   Record reviewed proof and known current-day external cost, confirm a current
   useful profile, then activate the ten-product sidecar. Never run production bootstrap or
   the historical three-sample license workflow for this release.
7. Observe a new autonomous Telegram message and a later independent Cron tick,
   unchanged interval/revision/search/SHADOW/reactions, current AI ledger and D1
   daily row/storage metrics. Test output alone is not deployment evidence.

Current pre-deployment evidence: read-only runs 37937367016 and 37938590525
confirm real message2742 and a subsequent automatic tick, interval30, unchanged
revision1791202121046, WB Search healthy, reactions initialized, River SHADOW,
Visual disabled. On 2026-10-09 the measured Worker ledger reports core112770 +
optional107245 reads and core5921 + optional2135 writes, excluding read-ledger
overhead. This is not a full-account usage or storage measurement.

### Connection audit and current release status

- GitHub branch `codex/visual-enrichment-v2` and draft PR
  https://github.com/22savage22/wb-deals-bot/pull/7 exist; main is unchanged.
- Current local Wrangler reports `loggedIn:false`; no Cloudflare API connector
  or Cloudflare deployment credential is available in the GitHub repository.
  The existing managed Builds credential cannot be exported through GitHub.
- Separate D1 creation was reported by the owner; its UUID is pinned in source
  and migrations. Remote binding verification, live initialization, version
  upload and native ten-product results are PENDING. Local adapter tests and CI
  do not substitute for actual native AI outputs or measured account usage.
- Required next action: enable Version URLs and the exact preview branch/command
  using the existing managed build credential with Workers Scripts Edit. No new
  token or D1 API permission is required by this bootstrap. See
  [Dashboard setup steps](visual-staging-setup.md). Production stays pending NEW
  owner confirmation after live staging and photo review.

Official scope/build references:
https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/
