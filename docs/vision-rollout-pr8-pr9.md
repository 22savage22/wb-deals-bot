# PR8 / PR9 safe integration plan — 2026-10-11

This is a proposed rollout, NOT a merge/deployment/activation authorization.
Production, Telegram, Cron,30-minute posting, WB search, reactions, Astra's
branch and River configuration were not changed by this preparation.

## Verified inputs and live evidence

- main: f28dd980f111a46bd973874038ad985e6602c8d8.
- Astra PR8:9c93b243d4753988eb11fa2c55ef855663ed439f,base main.
- Vision PR7:e8ace2f72b05f8fe4e556227e285d94def17e7fa,base main.
- Draft PR9:e9146b5dd9a8106f5f4c5aa7706ee7d12d83de05 before this finalization,
  base **codex/visual-enrichment-v2 (PR7)**,not main.
- `git merge-tree --write-tree PR9 PR8` (no actual merge/ref changes) returned
  exit1/tree37a07e124f19ed57c5e002b5ca2e670ad8109234: two UI conflicts.
- All9previous profiles persisted unchanged in isolated D1
  5779987d-1100-45ad-8cd4-9df9c1436a20. Cache replay9/9:zero AI/Neurons/writes,
  36actual D1 rows_read. Tenth449731422 saved after ONE authorized call:
  10.245454788208008Neurons. Persistent150ledger37.58181858062744,calls3,hold empty.
- Cache-first route before `visualRun`; hashes/model/cache/source-version match.
- Stage has no scheduled/TG/search handler; AI remains OFF,RiverSHADOW.
  Reports/photographs: [gallery](vision-gemma-20261011/gallery.html) and
  [provider/cache evidence](vision-gemma-20261011/report.json).

## Compatibility conclusion and exact conflict resolution

Compatible **after** resolving these conflicts and retesting the final commits.
Do not click both Merge buttons blindly. PR9 alone cannot bring its parent
PR7 changes to main. GitHub's individual "mergeable" status is not combined proof.

1. `miniapp/admin/app.jsx`: keep PR8's query/selection/queue/history screens and
   revision-aware saves. In the conflicting visual panel keep PR9's stricter
   `sufficient` evidence filter,real-feedback/product counters,10-products/day
   and Neurons/unknown-cost budget indicators. No enable switch/default write.
2. `miniapp/admin/view.mjs`: keep PR8's `insightText` distinction between observed
   events and weighted votes. Keep PR9's `VISUAL_DAILY_PRODUCTS` error text too.
   Neither count a vote change as a new person nor discard Vision limits.

No backend schema/route conflict detected at these exact heads. PR8 modifies
learning revision/audit and native selection; PR9 changes shared visual
normalization/cache/quota. Keep both: never replace Astra's scheduler/admin
backend wholesale with an older Vision file.

Local proof: archive of the merge-tree into own ignored `.test-temp` snapshot,
only these two resolutions applied there,plus PR9's final hard-OFF regression.
UI assets generated first; **201 Worker tests passed,0fail/skip**,admin esbuild
bundle succeeded. The first preview test needed generated assets; after build
it passed. This is local integration proof,not deployed-production proof.
No PR8 branch edit,real merge,production deployment or AI call during tests.

## Required sequence (only after explicit merge/deployment approval)

1. Re-read current main/PR7/8/9 heads. Re-run the combined probe if any changed.
   Verify Workers Builds deploys production only from the approved production
   branch; integrating PR9 into PR7 must not unexpectedly deploy a branch.
2. In a protected integration/staging environment,build/test PR8 first using a
   test database without production TG secrets/Cron. Verify owner-only initData
   auth via TG_BOT_TOKEN,subscriber denial and no settings writes on first load.
3. With approval,merge/deploy PR8 to main. Before/after record deployed version,
   scheduler_config revision/data,30-minute interval,timezone/quiet hours,
   autopost state,search settings,queue/claims,learningSHADOW and latest receipt.
   Back up persistent settings and establish recoverable D1/Worker rollback.
4. Verify PR8 production without generating extra posts: next independent Cron,
   normal channel delivery receipt,search/backoff/reactions,owner mobile admin.
   If it fails,stop the Vision rollout; keep/restore the last working Worker.
5. After approval,fold PR9 into its parent PR7 branch,then bring updated main
   into that **Vision/integration branch**,not Astra's branch. Resolve the two
   UI conflicts as above. Run full CI,build and isolated cache-only checks;
   no whole AI experiment/reinference is required.
6. Review the combined PR7+9 diff against new main. Apply only additive indexed
   Visual D1 schema changes,no table replacements/queue resets/settings defaults.
   Measure one-time migration reads/writes within D1 headroom before production.
   Do not import experiment ledgers/pinned test inventory/OAuth into production.
7. With separate approval,merge the Vision parent PR7 containing PR9 and deploy
   that approved main commit. Keep `VISUAL_AUTOMATIC_ALLOWED=false`,effective
   enabledfalse,`/activate`409,RiverSHADOW,posting30min. No new Cron trigger,
   paid plan,external Vision API or runtime Cloudflare management token.
8. Run the post-deployment gates below. Only later consider **separately
   authorized** automatic enrichment. Successful code merge is not activation.

## Post-deployment gates (do not run now)

- Owner WBmarket `/help`,`/status`,`/admin` work;Admin shows30min loaded from D1.
  Non-owner/missing/tampered/expired initData denied before D1;public bot unchanged.
- Opening/reloading admin does not save defaults or change scheduler revision.
  Explicit saves/double clicks/lost network retain CAS/idempotency behavior.
- Cloudflare Cron independent of PC;new automatic tick after a normal real
  Telegram post,matching delivery message_id/receipt;no duplicate manual post.
- Queue remains nonempty,invalid candidate skipped,claims expire;WB discovery
  adds genuinely new nmId or honours429backoff without stopping posting.
- Real human channel reaction ack/count/edit update remains correct;do not
  synthesize production votes just to test another component.
- Visual status effectiveOFF even if the old stored flag is1. Cron causes
  **0automatic AI calls**. Unit gate also exits before optional Visual DB reads.
- Cache reads reuse known identical image/model versions. Offline revalidate
  legacy cached analyses **without AI**,exclude ambiguous sneaker pattern/carry/
  texture from confirmed feature keys before using them in preference/ranking.
  Preserve original evidence/meter receipts;unsupported/invisible stayunknown.
- Durable atomic budget admission,leaseTTL,UTC quota reset and unknown-cost
  hold remain. Tests cover3036Free quota,missing meter,crashed call,concurrency,
  replay and cache. Unknown/timeout cost keeps reserve and disables further AI;
  quota sends queue retry to next UTC day,never Paid/external fallback.
- Review actual D1_BUDGET rows_read/written after migration and ordinary ticks.
  No full history/queue scans on likes or every minute;optional-lane budget stays
  independent of core posting. Failures must not disable scheduler or reactions.
- No River LEARNING/visual publication selection enabled by either rollout.

## Later activation gate and rollback

Not authorized here. Owner must review the photo gallery/contested attributes
and independently confirm current **whole-account** Free headroom. Staging's
provider-metered37.5818 is our ledger,not total account Usage or a safe future
whole-account remainder. Existing5000/day and2500reserve are conservative local
ceilings,not a promise to consume the account's entire10000Free allocation.
Retain hard-OFF until that policy/explicit permit is reviewed;then start a serial
1–3products/day sidecar with a lower bounded budget and existing caching/holds.
No posting/search/reaction request waits for Vision,no automatic paid upgrade.

For failure after deployment: turn Vision OFF first (it starts OFF),roll back
Worker to the recorded working version;keep additive tables/ledger/cache and
30-minute D1 settings. Do not revert/reset production queue or votes,delete
budgets,reactivate legacy poller or reset unknown-cost holds blindly.

Official quota/model references (checked2026-10-11):
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
