# Managed deployment and a permanent Cloudflare clock

## Native runtime migration — 2026-10-03

The following older dispatch design is historical. The new opt-in driver is
`SCHEDULER_DRIVER=cloudflare-native` in Worker runtime variables: minute Cron
executes WB card verification, D1 inventory selection and Telegram directly.
The main bot token is the existing `TG_BOT_TOKEN` Worker secret, not the mini-app
token or any Cloudflare deployment credential. Intervals remain D1 settings.

Deploy source from main first. Run `native-runtime.yml` with `action=prepare`
once to copy queue/history and non-secret channel policy using existing Actions
secrets; `action=check` is a safe no-post chain check. Only enable the native
driver after verified migration and checks. Then prove a Telegram receipt and a
subsequent autonomous Cron execution. The admin panel exposes a no-send check,
actual driver/heartbeat and overdue warning; unit tests are not production proof.

Keep the legacy `deals.yml` path ON until native runtime is verified. Set the
repository `SCHEDULER_DRIVER=cloudflare-native` only after that checkpoint; the
workflow excludes both Cloudflare drivers. Preserve callbacks/poller and all
existing secrets. Expiring D1 leases and atomic product claims protect overlap.

Workers Builds is connected to the existing repository, but builds b382c556
and c72d7037 could not initialise their environment, before repository cloning.
Do not repeatedly retry this platform failure. An owner-authorized official
Wrangler OAuth deployment is a recovery option: request only account/user read
and Workers Scripts write with automatic refresh, keep its credential under
ignored project-local configuration. It is never a bot runtime credential.
No new temporary Cloudflare API token, paid plan, Redis or server is needed.

Production migration was verified on 2026-10-03: native Worker sent product
32293087 at 12:49:37 Europe/Moscow, Telegram message_id 2463. Run 37114337157
contains the live receipt, not a mocked test receipt. Run 37114436564 confirms
an independent minute Cron at 12:50:50 after that send. D1 settings: enabled,
not paused, interval 10 minutes, search 20 minutes, quiet hours OFF, Moscow.
Repository driver is now cloudflare-native; the competing legacy run was
cancelled only after the native receipt. The inventory had 118 ready rows then;
that is a buffer count, not a claim that every row has just passed live checks.
Cards are rechecked before sending, and stale buffer rows are checked between
posts without sending. Previously published rows cannot poison selection.
The PC and deployment OAuth are not needed for runtime Cron execution.
An ordinary autonomous Cron then published product 87456438 around 12:59:55,
message_id 2464, about ten minutes after the test post; run 37114978443 records
this receipt and a following independent Cron heartbeat at 13:00:54. There was
no second manual post request. Tests: 59 Worker checks, four migration-helper
checks, and GitHub CI 37114731700 all passed. Stale lease takeover, uncertain
Telegram outcome isolation and cold Free-plan D1 query budgets are covered by
tests; the live receipts are recorded separately from those simulated tests.

Build 383766c3 subsequently succeeded for main 3ac09c9; the earlier build
initialization failures were temporary. Workers Builds remains connected for
future code deployment, while interval changes use D1, not new deployments.

## Selected design

GitHub main → official Workers Builds → existing `wb-finds-miniapp` Worker.
One native Cron Trigger (`* * * * *`, UTC) reads the existing D1 scheduler settings.
Posting/search intervals, quiet hours, days, pause and limits are admin settings,
not Cron edits. The original protected WB source Worker is unchanged.

To avoid rewriting the verified Python selection/filtering/reaction pipeline,
the clock dispatches bounded `post-once.yml` and `scanner.yml` execution jobs.
GitHub executes work; it is no longer the primary clock or a self-restarting
50-minute process. GitHub startup latency still means approximate timing, not a
hard guarantee of a post at an exact minute. The runner rereads D1 and checks
claims/quiet hours/limits immediately before sending. The publishing queue and
history retain the established merge/deduplication path.

## Why these components

- Workers Builds: official Git integration and automatically created build auth.
  No user-maintained temporary deployment key. Its automatically generated token
  has broad default permissions: review/narrow unused KV/R2/routes permissions.
- Native Cron Triggers: managed clock, no polling daemon, Redis or BullMQ.
- Existing D1: atomic dispatch/execution leases, settings and successful-post
  ledger. No replacement database or in-memory-only settings.
- Cloudflare Queues/Workflows and cron-parser were reviewed. No new queue is
  necessary for two existing jobs. Existing tested Python scheduling already
  handles IANA/DST, exact times and jitter; keep it authoritative rather than
  introducing a second calendar library. Worker does only a conservative dispatch
  decision; it never sends Telegram posts itself.
- Free Worker CPU limit is 10ms, 50 subrequests/invocation. Keep catalogue batches
  in existing runners. No paid plan or new server is provisioned.

## Connect the existing Worker

1. Settings → Builds → GitHub: official Cloudflare Workers and Pages app, select
   ONLY `22savage22/wb-deals-bot`. Owner approves Install & Authorize.
2. Repository root `/`, production branch `main`; build `npm run build`, deploy
   `npx wrangler deploy`; use Cloudflare-managed build authentication. Disable
   non-production builds (do not let feature branches deploy to the same D1).
3. Wrangler pins the existing account, Worker name and exact D1 ID; `keep_vars`
   preserves dashboard variables and encrypted Worker secrets are not deleted.
   Build copies only three public frontend files, never Python files/secrets.
   No D1 delete, reset, remote migration or bootstrap credential rotation.

## Runtime authentication is separate

Cloudflare deployment tokens are NOT runtime credentials. Existing bot tokens,
WB_SOURCE_KEY and MINIAPP_SYNC_KEY remain in their current secrets stores.
The dispatch adapter needs `GITHUB_DISPATCH_TOKEN` in Worker Secrets: repository-
restricted GitHub token with Actions read/write. It is not a Cloudflare token.
Never embed any value in Wrangler config, source, logs, notes or commit history.
Do not silently give the Worker all-repository GitHub access.

## Safe activation (not yet claimed live)

- Deploy/verify builds and D1 API with the Worker driver unset (fail-closed).
- Merge verified code only after backend is ready; leave working legacy Actions
  enabled until the new path passes a safe preview and production cycle.
- Add runtime dispatch secret through the secret UI; activate Worker variable
  `SCHEDULER_DRIVER=cloudflare`. Cron propagation can take up to 15 minutes.
- Set repository variable `SCHEDULER_DRIVER=cloudflare` to disable the legacy
  deals loop. Existing active runs must finish or be safely stopped; shared
  `wb-deals` concurrency and D1 product claims protect transition overlap.
- Confirm Cron event, accepted dispatch, new WB results, queue insertion, real
  Telegram success and subsequent automatic cycles. Do not call this complete
  on the strength of unit tests alone.
- Recovery: unset the Worker driver, revert the repository driver variable;
  preserve D1 and all existing secrets. Do not run old bootstrap deploy scripts.

Source docs: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
https://developers.cloudflare.com/workers/configuration/cron-triggers/
https://developers.cloudflare.com/workers/platform/limits/
https://developers.cloudflare.com/workers/wrangler/configuration/
