# Isolated Astra + Vision integration — approval still required

Branch: `codex/admin-vision-integration-20261011`.
Own checkout: `D:\WB-Vision-Agent\.test-temp\admin-vision-integration-20261011`.
Nothing merged to main, pushed, deployed, enabled or changed in production.
No new AI calls or Neurons. No edits to another agent's checkout/branch.

## Verified dependencies (GitHub + remote refs, 2026-10-11)

| PR | Base | Head |
| --- | --- | --- |
| 7 | main `f28dd980` | codex/visual-enrichment-v2 `e8ace2f7` |
| 8 | main `f28dd980` | codex/admin-control-center `9c93b243` |
| 9 | codex/visual-enrichment-v2 `e8ace2f7` | codex/visual-staging-agent-20261010 `acf12f23` |

PR7 is an ancestor of PR9 (`merge-base --is-ancestor` succeeds). Integration
starts at PR9, then merges the exact PR8 head only into this isolated branch.
There is one Vision implementation, not a second copy/cherry-pick of PR7.
The integration commit has PR9 and PR8 as parents. No foreign refs changed.

Two conflicts resolved:

1. `admin/app.jsx`: retain Astra query/selection/queue/history/CAS saves and
   Vision counters, stricter sufficient-evidence thresholds, daily caps/OFF gate.
2. `admin/view.mjs`: retain Astra observed-events vs weighted-feedback wording
   and Vision daily-product-limit explanation.

The combined UI also distinguishes unavailable data from zero, describes the
hard OFF gate, shows the actual configured model and four-decimal Neurons,
and labels the ledger as this Worker's usage, not whole-account Cloudflare Usage.
Model confidence is not measured accuracy; subjective style remains a hypothesis.

## Local proof (not production proof)

- 206 Worker tests pass, no failed/skipped tests; admin/public assets build.
- Wrangler 4.146.0 `deploy --dry-run` exits successfully without upload/deploy.
- Integrated preview uses real Worker admin handlers + a LOCAL SQLite adapter.
  It binds only to 127.0.0.1, validates Host/Origin, denies cross-site writes,
  and uses a generated local-only Telegram fixture credential, not a real token.
- `node miniapp/admin/control-preview.mjs --vision-snapshot` starts on a free
  port. The current preview is `http://127.0.0.1:60707/admin` (only this PC).
- Public, verified staging report/photo artifacts are imported atomically once.
  All ten photo hashes match the saved profiles; cache readback is 10/10 with
  zero AI calls. Real feedback is zero in this isolated fixture, not fabricated.
- Snapshot timestamp: 2026-10-11T11:33:36Z. Gemma historical totals 142.2272739410
  Neurons; October 11 ledger 37.5818185806, 3 calls. Dates are not reset on reload.
  These are saved staging results, NOT live production or whole-account usage.
- Historical photo cards lack current verified prices and are marked
  `preview_only`, never promoted to posting-ready inventory.
- Publishing, external checks, inference and activation are denied. CSP prevents
  UI connections/photos to external hosts. Images are served from verified local
  gallery bytes; no new WB requests. Normal public Mini App assets unchanged.
- Owner-only signed initData API remains intact. Non-owner 403; missing auth401.
- First load/repeated reads do not rewrite scheduler data/policy. Interval30 is
  a LOCAL fixture matching the owner's requested production setting, not an
  import of live credentials/settings. Explicit local20 survives a restart;
  cached JSON, original budgets and RiverSHADOW survive too.
- Phone390px: no horizontal overflow; photos load, 10profiles/OFF/SHADOW/30min
  display correctly. No setting saved or publication triggered during UI review.

This replaces the older archive-only probe in `vision-rollout-pr8-pr9.md` with
an actual integration branch. All production gates in that document still apply.

## Recommended rollout, ONLY after explicit approval

1. Review this preview and integrated diff. Re-read current PR/main heads. If
   main or either agent's PR advanced, update ONLY the integration checkout,
   resolve/retest there. Separately review any discount/style-agent change;
   do not silently replace or fold that unfinished work into this rollout.
2. Confirm Workers Builds production tracks only approved main. Push the
   integration branch and create ONE integration PR against main after approval;
   do not independently merge 7+9 as duplicate Vision features. Original draft
   PRs can be marked superseded only after the approved integration is merged.
   Review both source PR histories; retain their original branches unchanged.
3. Before deployment record production Worker version + commit; capture D1
   settings/revision, enabled state, timezone/quiet hours/limits, 30min interval,
   search settings/backoff, RiverSHADOW, queue/claims and last message receipt.
   Establish a recoverable D1 point and quota headroom. Do not expose secrets.
4. Test this exact integrated commit in a NEW isolated environment first, using
   a test database and NO production TG secrets/Cron. The existing Vision staging
   is fetch-only; don't turn it into the production scheduler or reuse production
   D1 bindings. No inference needed for cache/UI checks. Validate additive,
   indexed migrations and their one-time D1 cost; don't import sample ledgers,
   local tokens, fake identities, historical test inventory or cached test
   settings into production. No migrations may replace existing settings.
5. Obtain separate permission for the exact merge/deployment. Merge ONE reviewed
   integration PR into main and allow Workers Builds to deploy that approved
   commit. No secret/token rotation, Paid plan, Cron changes, polling restart or
   schedule migration. Keep VISUAL_AUTOMATIC_ALLOWED=false, effective OFF,
   /activate409 and RiverSHADOW. AutoVision activation is a later, separate task.
6. Immediately verify main-bot owner /help,/status,/admin + non-owner denial and
   public app. Compare settings byte-for-byte/revision before/after opening the
   admin: 30min, enabled, quiet hours and search policy must remain identical.
   Check budgets/holds and cache with no new AI call. Do not infer preferences
   until the existing real-feedback evidence thresholds are met.
7. Observe a NORMAL real Telegram delivery with its message_id and the following
   independent Cloudflare Cron tick; check queue, TTL claims, genuinely new WB
   search additions or justified backoff, reaction keyboard update and D1 budget.
   Do not send duplicate manual test posts. Monitor several 30min cycles before
   declaring production integration successful. No PC dependency.

## Rollback

If any production gate fails, stop the rollout and restore the recorded working
Cloudflare Worker version immediately. Commit a reviewed revert of the approved
integration merge (`git revert -m 1 <approved-main-merge>`) so Workers Builds
doesn't redeploy the failing code. Reverify the old version + normal Cron/post.

Keep additive tables/cache/ledger and production30min settings. Do NOT restore
the whole old D1 database over new votes, post receipts, queue or budgets. Use
the D1 recovery point only for a separately confirmed corruption incident, not
a routine code rollback. Restore individual configuration through its revision
check only if a settings difference was proven. Never clear quota holds to
force AI retries, reactivate the old poller or turn RiverLEARNING on.

Automatic Vision remains hard-disabled even if an old database has enabled=1.
Missing/uncertain cost retains a durable reservation/hold; exhausted free budget
stops the sidecar, not posting/search/reactions. Safe enablement needs separate
owner consent and a whole-account Free headroom check; a local5000/day cap is
not evidence of free quota remaining for other account workloads.
