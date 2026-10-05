# Owner Admin Mini App v3 — 2026-10-05

## Scope and production guard

Existing Worker/Workers Builds/D1, main WBmarket webhook and public subscriber
app are retained. Before development: live read-only run 37328885744 confirmed
interval 30 minutes, revision 1791202121046, Cron active, enabled/unpaused,
queue 39, real message 2558, successful WB search, no active backoff/error.
No configure, manual tick, publication, webhook reset or token creation is needed.

The six phone-first screens use the installed Telegram UI + React stack.
Light/dark follows Telegram; no new UI framework. Public frontend unchanged.
Schedule/search first load the exact D1 configuration. Draft changes are local;
debounced preview only calculates the next time. Save uses the original CAS
revision. Inputs lock during requests. Conflicts preserve the user's draft.
Main screen refreshes at 60s while visible; pending tasks at 10s. No history polling.

## Queue and asynchronous actions

Owner-authenticated `/api/admin/queue` reads six cards using the existing
`(state,queued_at,pid)` index and a keyset cursor; LIMIT 7 detects another page.
It is a candidate list, not an invented guarantee of Legacy's selection order.
Skip/remove create persistent inventory tombstones, retaining history/dedup.
An active publication lease/pending request blocks conflicting queue mutations.
Request IDs deduplicate retries and double clicks across devices.

Publish selected creates a durable request and returns 202 without WB/Telegram
network calls. A small opt-in branch in the existing publisher limits selection
to that card, preserving quiet hours, caps, validation, claims and send semantics.
If invalid, it cancels the request instead of silently publishing another item.
Automatic Legacy selection is unchanged when there is no chosen-card request.
The outcome is visible on the home screen; no second sender or polling process.

## Truthful learning

River stays SHADOW; UI cannot enable LEARNING or change mode. Existing training,
weights, features and Legacy choice are unchanged. Only additive comparison
bookkeeping was added to training: paired positive/negative, wins/losses/ties,
mean predicted probabilities and last observed result. These start with new
paired data, not reconstructed/made-up historical wins. Predictions are explicitly
not uplift. Existing 200 observations / 20 products / 7 days eligibility is retained.

Current real channel reactions come from an O(1) summary of `reaction_totals`.
The one-time snapshot is maintained transactionally by delta triggers, including
like→dislike changes; test/non-channel scopes are excluded. Event signals are
shown separately, with Moscow-calendar "today" and explicit vote-change semantics.
Save/click events are not treated as likes in audience observations.

Category/price/time observations require at least 10 like/dislike/buy signals.
They describe reactions, not causal conversion or guaranteed improvements.
Time observations require a prior shadow publication record; unknown prices/time
are not presented as facts. Historical event summaries import at most 100 indexed
events per batch, CAS-guarded, and continue during the existing training update.
New events update small aggregates via a trigger. No per-open full history scan.
Exploration 0–30% edits only existing Legacy topic discovery; actual stored value
is loaded, not initialized to a UI default.

## Auth and operations

Main-bot TG_BOT_TOKEN HMAC initData + owner ID for every admin API; no client ID
trust or public-token fallback. Subscriber API remains MINIAPP_BOT_TOKEN.
`/admin` is a data-free shell until server auth. Diagnostics is a separate screen.
WB 429 backoff is shown as ordinary waiting; next-search display uses persisted
admission/backoff, not the obsolete one-minute underfilled-queue formula.

`native-runtime.yml action=admin_snapshot` is an inspection-only operational
path: settings untouched, no test actors/check requests/sends. It reads the
existing protected admin snapshot and reports RTT. There is no scheduled CI job
added. Use it after checking no overlapping native workflow is active.

## D1 cost and QA

Actual local Miniflare/workerd metadata on 300-card/20-topic fixtures:

| Operation | rows_read | rows_written |
|---|---:|---:|
| Overview | 3 | 0 |
| Overview incl budget ledger | 5 | 6 |
| Queue page (6 + continuation row) | 7 | 0 |
| Learning steady state | 102 | 0 |
| Initial learning migration/bounded import | 628 | 162 |

UI forecast ~18,490 extra reads/day: owner visible **24 hours**, 60s refresh,
10 learning + queue opens, 10,000-row safety allowance. Idle/closed app does not
poll. Continuous overview alone costs ~8,640 actual ledger writes/day; ordinary
short owner sessions much less. These are fixture measurements/estimates, not
account billing or guarantees; search/training/posting are separate existing costs.
Free guard ceilings unchanged; learning UI uses 512 write reservation, read-only
UI 4, instead of reserving 5,000 writes for an ordinary read.

134 Node tests pass: strict auth, stored 30/no defaults, CAS, preview read-only,
indexed paging, tombstones/dedup, live-lease rejection, specific-card validation,
atomic reaction summaries/restart, bounded historical import, normal backoff,
slow-network async check and ambiguous-response request reuse. Build passes.
Native bootstrap Python tests pass. Local Python lacks River; the three real
River tests passed in existing GitHub CI run 37334544568 (full Tests SUCCESS).

Computer Use local-only preview: 390 light, 320 dark, no horizontal overflow;
selected 30/Save disabled on open; temporary selection 5 caused **0 saves**, stored
interval remained 30. No production reactions or messages simulated.
`miniapp/admin/preview.mjs` binds only loopback and is not a deployed asset/auth path.

## Verified production and owner acceptance

Code commit `a60efe8e26b3f06bcb4554c53c1d0c7d0c828e8e` pushed to existing main.
Managed Workers Build `5986e65c-721d-4ef8-b802-5bec5b5c2aaf` succeeded;
runtime `ddc6eef1-90d3-47b8-b2eb-0fb9b9c0d5ac`, admin version 3.
Production admin bundle matches the local build exactly.

Owner personally reopened /admin in WBmarket and confirmed all six sections,
30-minute selection and SHADOW. Read-only owner check run 37335893821 confirms
`owner_admin_open.at=1791215174`, bot=main, owner_verified=true, new runtime.
Webhook OK, pending updates 0, last_error empty. Subscriber auth remains separate.

Final read-only snapshot run 37336536547 (SUCCESS):

- Settings: enabled=true, paused=false, interval=30, revision=1791202121046
  **unchanged**; search enabled, configured interval 20; Cron active.
- Real automatic Telegram delivery message_id=2560, nmId=1175578179,
  last_post_success=1791214588; subsequent independent automatic Cron
  last_automatic_tick=1791215596, matching production_chain_message_id=2560.
- Queue 41; post_running=false, post_retry_at=0, watchdog_overdue=false,
  current scheduler error empty. No manual post/tick was issued for this task.
- WB search success=1791215540, origin=cron, HTTP result successful,
  search_retry_at=0, failures=0, error/code empty. Latest admission receipt
  at1791213924 added two NEW nmIds 168162157 / 217502165, queue40→42; current
  filtered-zero search does not mean the search process stopped.
- Real reaction check run 37335191959: update810945057 on message2560,
  pid1175578179, immediate ACK16ms; D1 dislike1, dirty0, error empty, Telegram
  edit receipt shows 👍0 / 👎1 / 🛒0. No simulated users or feedback inserted.
- Existing SHADOW training run 37335738711 succeeded: cursor66, trained_events66,
  comparison_samples40, publication_control=false; model update1791215307.
  Actual current channel votes:19 likes /48 dislikes /0 bought. Paired observations
  25, minimum200 not met; uplift remains null, learning_allowed=false,
  legacy_fallback=true. No LEARNING switch or new training infrastructure.

Read-only combined snapshot RTT was 2442.2ms in run37335747173; this includes
learning/diagnostics and is **not** proof of sub-second production button latency.
Quick action endpoints return durable acknowledgements without WB/Telegram work;
slow-network/double-click safety is covered by tests, not a fabricated timing claim.
No settings save/default initialization occurred during owner opening or QA.

Production left ON; no recovery automation, old poller, token or manual Telegram
message was created. Owner acceptance gate is satisfied; use the existing /admin.
