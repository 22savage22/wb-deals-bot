# My Style: real Telegram staging / production gate

> Current product hardening, measured costs, catalogue proof and rollback:
> [style-product-readiness.md](style-product-readiness.md). The dated entries
> below are historical checkpoints, not the latest capability/quota report.
> Latest audience/approval contract is `style-universal-launch.md`: no per-user
> ID registration; second real-account testing is supplementary, not a blocker.

## Audit 2026-10-15

- PR13 remains Draft, main at7a11699a, PR10 at ea72c2d2, PR9 at acf12f23.
  Six PR10 commits were already cherry-picked into PR13; do not merge them twice.
  `git range-diff`/patch comparison and current public/admin/Vision handlers were
  inspected before extending this branch. No other branch was edited.
- Production read-only `/api/health` returned runtime version
  `fbfc53e2-7ed0-4b88-a620-ee79bdb294bc`, configured=true, admin_version3.
  Cached public catalogue returned3000 items and bot `WbPodborr_bot`.
  These are architecture/health observations, not a new posting receipt or a
  claim that scheduler settings were independently revalidated in this task.
- Official getMe using the owner-provided existing credential confirmed public
  bot ID8636930701. No token was printed/copied into staging or changed.
- Admin uses main-token+owner ID; existing Vision implementation is already in
  main. Neither is duplicated. River/automatic Vision/search/posting unchanged.

## Staging composition

Exact resources: Worker **wb-finds-style-staging**, separate D1 with the same
name. Production D1 d73d252d-3948-425b-b7c3-b65d0f5c6e5f and existing Vision D1
5779987d-1100-45ad-8cd4-9df9c1436a20 are explicitly rejected. No routes/custom
domains or bot menu/webhook are changed. No main merge/deploy.

`staging_worker.mjs` composes the existing public Mini App API with My Style;
existing catalogue, saves, preferences and outfit routes remain in use. Copied
public assets receive a navigation button and same-origin overlay; production
static files are unchanged. Parent passes signed initData to its own frame only
after a same-origin/source-checked handshake. No trusted identity is passed from
the client: backend revalidates the signature on each private API operation.

Staging uses Telegram's official **Ed25519 third-party verification** with its
production public key, pinned bot_id, duplicate-field rejection and1-hour expiry:
https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
It does not need a bot token. Old clients without a signature fail closed, not
fall back to client user_id. Production auth remains its original HMAC default;
a server-only `createWorker(publicAuth)` factory avoids duplicating public routes.
Admin auth never uses this injectable public verifier.

Only DB/assets/version/rate-limit/public-ID/feature flags may be bound. No AI,
TG token, sync key or service binding; no scheduled export and no Cron triggers.
`/admin`, all admin APIs, both webhooks, sync, scheduler, superfind and the local
session signer are denied before D1. Uploaded binding/handler attestation plus
a DB canary are required. A wrong DB is not initialized by HTTP traffic.

The seed contains80 real photo-verified fashion examples and seven already
reviewed matching visual profiles. It copies **no personal production/owner/wife
history**. Staging prices/stock are not freshly verified and are labelled as
such; no superfind, discount or independent recommendation-quality claim.
No WB/AI request is made per user/swipe; auto-Vision remains unchanged.

## Persistence and privacy

Individual Telegram IDs key all profile, vote, favorite, revision and idempotency
rows. Browser storage is not the source of truth. Close/reopen with a fresh valid
Telegram launch should load the same D1 profile. Never accept a user_id, model or
Visual evidence from a client. A/B synthetic fixtures prove code isolation only;
they do **not** count as tests of two real Telegram accounts.

Two explicit My Style actions: reset training while retaining its favorites;
or delete ratings/preferences/filters **and** My Style favorites. Existing
public "delete my data" additionally clears My Style. Indexed per-user deletes
are atomic inside the style store, preserve other users and an empty revision
tombstone only (to prevent stale in-flight writes resurrecting erased data).
Public saves and My Style favorites are separate labelled collections in this
staging; production unification is a reviewed integration decision, not a
silent replacement of existing saves.

## Free-budget model — estimates, not billing evidence

Official D1 Free quotas:5M reads/day,100k writes/day,5GB across the account;
indexes add writes, and all databases share the account allowance. Source:
https://developers.cloudflare.com/d1/platform/pricing/

The existing bot has already exhausted this quota once. A separate database
does **not** supply a separate free account budget. Keep optional feature caps
at50k reads/8k writes per UTC day plus the existing optional guard, until real
staging metadata is measured. An exhausted feature budget returns429; it does
not turn off posting or silently drop an accepted rating.

Shared snapshot≤120 candidates;20-card decks are loaded once, not on each swipe.
Votes use indexed point lookups, aggregate updates and bounded receipts. No
history scan/AI call/full catalogue reread per swipe. Favorites≤100, votes≤500.
Static photos/scripts bypass Worker-first routing, reducing dynamic requests.

Planning illustration only: with20 votes plus6 other private requests/day per
active subscriber, assuming15 row-writes/vote and4/other request gives324
writes/person/day (50 active≈16,200;100≈32,400;300≈97,200). These assumptions
must be replaced with measured D1 meta, including indexes and budget ledgers.
At this conservative8k feature cap even50 such active people will be throttled;
**unlimited growth inside Free is not promised**. Do not raise the cap or pay
automatically. Measure p50/p95 reads/writes per endpoint in staging, add normal
production usage and a large safety margin, then review capacity with owner.

Remote public-catalogue costs were measured on 2026-10-17 (below); private
rating costs, phone latency, two-real-account persistence and Worker CPU are
still **unverified until real sign-in**. Local SQLite statement/returned-row
counts are not Cloudflare rows_read. No fake Neurons or invented subscriber
success metrics are reported.

## Reproducible setup

Preparation verification:444 Node tests PASS, public/admin build PASS, isolated
staging Wrangler dry-run PASS. Chromium390x844 integrated local UI: navigation,
same-origin frame auth handoff and close/reopen persistence PASS, no page errors
or overflow. This is an explicitly labelled local fixture, **real Telegram
accounts tested=0**. A combined highly-parallel regression run once had a timing
assertion fail (2 vs3); separate suites and the final444-test combined run passed.
No production behavior was changed to suppress this timing-sensitive test.

The first actual Device Flow request expired after5 minutes without confirmed
authorization. No API token or temporary account was created; do not treat
authorization intent or a displayed code as a successful login/deployment.

```powershell
npm run style:staging:prepare
npm run style:staging:check  # dry-run only, no upload
node miniapp/features/staging_tool.mjs --deploy
```

The deploy helper requires the exact PR13 branch and clean committed source,
finds/creates only the exact staging DB, guards its UUID, seeds only public
examples and new tables, deploys only the staging Worker, then checks real
bindings/handlers/health and unauthorized denials. Credentials are official
Wrangler OAuth in Windows keyring/encrypted local auth, never source/arguments.
All CLI/API calls have finite timeouts and failures stop without blind retries.

The owner explicitly authorized account-level `workers_scripts:write` and
`d1:write` ONLY for this staging work. These OAuth scopes cannot be constrained
to one resource; script guards constrain actual operations. No Paid/AI/KV/zone
or deployment-control scope is requested. Account-level grant is not permission
to modify other resources. A device code expiring is not a completed login.

## Phone proof and final deployment approval

Once deployed, verify the real staging receipt before sharing its URL. Send a
single private **web_app** launch button from existing @WbPodborr_bot to the
owner (not a channel post, not a bot-wide menu change). A plain HTTPS browser
link alone does not supply Telegram initData. Keep the ordinary bot menu public
app URL unchanged. Do not call setWebhook/getUpdates.

Real-account checklist (only with safe human access):
1. Owner launches the staging button, likes2 items and saves1 favorite, closes
   the Mini App fully, opens again; verify same real D1 state.
2. A second consenting account independently opens the staging launch; verify
   no owner's ratings/favorites/preferences are visible and its own survive.
3. Delete one account's My Style history; verify its data gone, other account
   unchanged, stale write rejected. Do not impersonate either account.
4. Record actual D1 meta/latency/CPU, not raw initData or personal event logs.

Before production: current Worker version/commit + D1 backup/recovery point,
auth and negative-access proof, additive migrations/cost, real two-account
checks, quota headroom, reviewed navigation/integration diff and owner approval.
Rollout must preserve30-minute config/revision, search, reactions, SHADOW and
Vision flags byte-for-byte. New channel selection remains OFF.

Rollback: restore the saved previous Worker version, revert only the approved
integration commit, remove/hide the My Style navigation feature flag. Keep
additive user tables/data; do not restore an old full D1 snapshot over fresh
votes, queues or delivery receipts. No scheduler or bot-token rotation.

**Production deployment remains a separate explicit final approval gate.**

## Live staging evidence — 2026-10-17

Official Device OAuth completed, with only the already approved staging scopes.
No API token, account-read scope, paid resource or production deployment added.
The isolated deployment is live:

- URL: https://wb-finds-style-staging.valeramyakishev000.workers.dev/
- D1: `43861c0c-aa50-4e5e-9014-7b36bd319e5b` (name matches the Worker).
- Worker version: `5980b585-8664-4d8c-b4dd-3781358e6ddc`.
- Deployed source: `74aa6729b27c3514bfc04342134138fcee44d108`.
- Uploaded bindings/handler attestation PASS: only `fetch`, no AI, Cron,
  credential, service or Telegram sender. Admin/webhook/scheduler/local session
  routes denied; unsigned private style route returns401 before D1 access.
- Remote database:80 public products,80 photo cards,80 snapshot entries;
  **0 real style accounts/votes** at the pre-phone baseline. No synthetic
  remote accounts were created. Seven reviewed visual profiles reused,0 AI calls.

Initial import contained a definite defect: a152,863-byte single SQL literal
exceeded D1's100,000-byte statement limit. The provider returned the opaque
`D1_RESET_DO` import error; the DB remained empty. Rather than retrying OAuth or
changing production, the generator now constructs the bounded shared snapshot
from existing catalogue rows with SQLite JSON aggregation. Largest SQL statement
is3318 UTF-8 bytes. The same80-card seed imports successfully. A regression test
checks the statement ceiling, structured JSON, visual count and absence of users.

Latest focused feature suite:34 PASS. This is not a real-account acceptance test.
Graphify AST update traced the shared generator to both preview and deploy;
SQL was checked directly because the optional SQL parser was not installed.

Actual HTTP request D1 metadata (not estimates or returned-row counts):

| Request | Queries | Rows read | Rows written |
| --- | ---: | ---: | ---: |
| Health including DB canary |2|1|0|
| First public catalogue initialization |17|unknown|unknown|
| Repeated public catalogue |1|1|0|

Initialization did not provide complete metadata, so its cost is explicitly
unknown, never reported as zero. The separate remote diagnostic counting seed
rows cost161 reads/0 writes; it is not a per-user action or daily recurring query.
All staging API responses expose complete request costs in `X-Style-D1-*` when
metadata exists, otherwise `unknown`. Metrics add no SQL and logs contain only
endpoint/counters, never initData, Telegram IDs, votes or personal preferences.
Private rating p50/p95 and free subscriber capacity remain pending real use;
feature caps remain50k reads/8k writes/day, not an unlimited Free-tier promise.

The public bot and the administrative bot are intentionally different.
Phone launch must be a private web_app button from **@WbPodborr_bot**, not
@WBmarket22_bot: the staging verifier is pinned to the public bot's identity.
No global bot menu/webhook change is required. A direct HTTPS browser visit
is useful for public UI only, not proof of authenticated persistence.

The private invitation was delivered (message_id23). Owner reported opening
the app but could not identify the new section. A real390x844 unsigned-browser
check found the ordinary catalogue discovery dialog obscuring the My Style
entry. It showed no page errors/overflow, and the private API correctly denied
unsigned access. A scoped remote read found0 owner style ratings/favorites and
cost3 reads/0 writes; no preferences were invented or submitted on their behalf.

The SAME private message was edited (no additional message) to open `/style`
directly rather than `/`. The standalone page now explains the rating/favorite
steps and has a same-origin return button preserving Telegram's launch fragment;
the embedded path retains its checked parent handshake. Both launch paths,
return fragment and close/reopen persistence PASS in local390x844 fixtures;
8 focused staging tests PASS. Current real Telegram session/account acceptance
still requires the human phone interaction. No synthetic remote ratings added.

Remaining gates: owner close/reopen test via the updated direct launch button,
second consenting real account isolation/deletion test, measured private request
cost/headroom, then ask for separate final production approval. Do not merge,
deploy production, enable superfind publication or change channel selection.
