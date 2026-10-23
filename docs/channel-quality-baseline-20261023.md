# Channel quality audit — 23 October 2026

Status: prepared for review. No merge or deployment. Existing 30-minute autoposting remains enabled. No new features, CPU experiments, AI calls or paid services.

## Verified baseline

Read-only production snapshot at 14:24 Moscow. Main `524fbe8931b911e4c3bc4e05de7caf5003b1decc`; active Worker `21b5e305-e447-4a14-82fb-230b51be6710` at 100%. All 100 D1 successful deliveries matched actual public Telegram messages [3293](https://t.me/WBmarket22/3293) through [3392](https://t.me/WBmarket22/3392), 21 October 10:47:48 to 23 October 13:56:59 Moscow. This is a fixed historical sample; later automatic posts continue.

| Measure | Observed result |
| --- | --- |
| Publication interval | median 1860 seconds; min 1837, P95 1873, max 1882 |
| Repeated article / identical normalized title | 0 / 0 in 100 posts |
| Title similarity >=0.8, preceding eight posts, same WB category | 0 pairs; this does not prove visual uniqueness |
| Owner-excluded educational/stationery/books posts | 0/100 |
| Observed WB CDN category | 100/100; no generic `other` |
| Internal type conflicts with that category | 5/100 posts, 3/70 ready candidates |
| Longest consecutive internal type | old classifier reports 2; category-corrected classifier reveals 3 |
| Snapshot post prices | 219–999 RUB; 0 above configured 1000 RUB cap |
| Complete quote/SKU/time provenance in deliveries | 0/100; price freshness cannot be established retrospectively |
| Current channel votes | 53 likes / 182 dislikes, 235 votes on 215 products, 2 people |
| Votes on sampled 100 posts | 5 likes / 36 dislikes on 41 posts; 12.2% positive among 41 recorded votes |
| Ready candidates with previous item votes | 0/70 |

The two voters are not a representative survey of all readers. Unvoted posts are not positive votes. Native Telegram emoji reactions, clicks, purchases and historical vote-at-send snapshots were not established by this audit.

Observed category distribution: T-shirts 23, dresses 17, skirts 13, longsleeves 13, blouses 10, cardigans 8, trainers 5, jumpers 2, nine other categories one each. The mix is concentrated in clothing; exact item repetition is not the confirmed defect.

## Live settings and queue

Posting ON, paused=false, interval=30 minutes, quiet hours OFF, search ON every 20 minutes, Europe/Moscow. Owner exclusions for textbooks, study aids, notebooks, stationery and books are ON; feedback and fashion priority are ON. River remains SHADOW. Existing style features were not changed.

At the baseline: ready 70, cooldown 2, owner_excluded 6, uncertain 23, rejected 325, expired 271, posted inventory 922. All 70 ready rows were captured; zero expired or owner-banned ready rows. 56/70 had a validation timestamp older than six hours; oldest queue admission was 71.6 hours. Queue age is not proof that an old price was actually sent. Uncertain rows are delivery safeguards and were not reset or resent.

Final read at 14:32 Moscow: ready 69, normal new message [3393](https://t.me/WBmarket22/3393) delivered at 14:27:54; a later independent Cron heartbeat matched that message, errors empty, watchdog=false. All 217 reaction-message records clean (`dirty=0`). Schedule and policy hashes unchanged.

## Source, prices and dislikes

Native Worker uses anonymous WB search v9 and cards v4; current production search receipt shows HTTP-successful discovery of 100 results, one new admitted article. Category enrichment uses matching-nmId WB CDN card metadata. Price request context is RUB, dest=-1257786, spp=30; it is not a signed-in customer's final checkout price.

One direct client cards request for three relevant IDs returned 403 at 14:30 Moscow; no retry or bypass. This does not demonstrate failure of Cloudflare egress. Current shopper prices remain unverified.

Main `cardDeal()` selects minimum price independently of available size and floors kopecks. `validateQueued()` can use a cached product after failed refresh within six hours and update its validation timestamp. Public captions still say the price was checked before publication. These confirmed code defects already have isolated **Draft PR #16**; they are not duplicated here. This sample cannot determine how often production used that fallback.

Current-item votes affect rank, but no ready candidate has such votes. Type/profile generalization requires 5 people, 4 products, 12 votes and Wilson evidence. With only two actual voters it cannot activate. That is an intentional existing policy, not a missing webhook. The patch preserves those thresholds and does not silently turn two people's tastes into a channel-wide category ban. Therefore feedback can be enabled while having no score effect on this ready pool.

## Narrow correction

`productType()` previously searched the concatenated subject and title with a fixed regex order. Seller keywords could override the observed subject: a longsleeve became a T-shirt, a dress became a T-shirt, and a denim skirt became jeans. A verified suit subject was collapsed to trousers. That contaminates type feedback and the existing consecutive-type rotation.

The observed category is now checked first. A non-generic WB CDN subject with no existing type mapping remains its own `wb:<subject>` type. Title fallback remains for missing/unknown categories. Owner exclusions run first as before. No new taxonomy, source, model, table, setting or subsystem.

Verified corrections: 209915042, 1264256627, 400680196, 1200290519, 971598729. Ready corrections: 238850937, 183902826, 581257763. Unknown-but-verified subjects retain the existing generic scoring path; e.g. suits no longer borrow trousers' fashion-type score. No new category is banned.

## Verification and backup

- 229/229 full Worker tests PASS after building required local assets; two new regression tests cover category priority, vote attribution and rotation. Initial missing-asset test failures were resolved by the existing build; no unrelated runtime code was changed.
- Local SQLite staging: real 70-row ready pool, 100 historical deliveries and 235 item-vote aggregates; artificial local labels replace all voter identities. Every HTTP call intercepted. One fixture publication, no duplicate on a second tick, five category/rotation cases pass. No real WB/Telegram/AI requests in staging. This is not a remote Cloudflare or CPU measurement.
- Existing Worker bundle build and Wrangler `--dry-run` PASS; no upload.
- Full 7,584,937-byte production SQL backup restored into local memory: integrity `ok`, zero foreign-key violations, 59 tables and 1350 delivery records. SHA256 `7f08c1a4cc8edefad9831abcd101ee3bf26ed579417d4fa2bbcbe9dbb7f842e9`. SQL and Time Travel bookmark stay private outside Git. D1 export can briefly hold queries; export completed, subsequent independent heartbeat verified. No remote restore.

## PR state checked live

| PR | Current state | Checks / limitation |
| --- | --- | --- |
| [10](https://github.com/22savage22/wb-deals-bot/pull/10) | OPEN Draft | test success; isolated taste/value SHADOW, no production selector replacement |
| [14](https://github.com/22savage22/wb-deals-bot/pull/14) | MERGED 17 October | test success; owner exclusions and feedback present and enabled |
| [15](https://github.com/22savage22/wb-deals-bot/pull/15) | OPEN Draft | test success; broad price/CPU experiments not adopted |
| [16](https://github.com/22savage22/wb-deals-bot/pull/16) | OPEN Draft | test success; isolated price patch, documented Free CPU and source-outage release gates unresolved |

Green CI does not establish current prices, channel satisfaction or Free CPU headroom. No new CPU experiment was run. This branch does not import #10/#15/#16.

## Release and rollback

1. Review this minimal patch separately from the blocked price release. Before any deployment, refresh the active version, backup and schedule/policy hashes. Obtain explicit owner approval for the exact commit and code deployment. Nothing here authorizes merge/deploy or bypasses the existing Free-plan release constraints.
2. Apply no migration or policy changes. Preserve 30 minutes, exclusions, reactions, style and SHADOW settings. No staging deployment has been performed; the staged verification here is local.
3. Code-only rollback: revert this patch in its branch, run the existing tests/build, and request explicit approval before publishing any rollback. If a deployed rollback is needed, first verify the active version still belongs to that release; do not overwrite newer unrelated changes.
4. Never rewind live D1 to the SQL backup or Time Travel point merely to undo code: that would lose new delivery/claim/reaction state and risk duplicate sends. The backup was restored locally only.

After an approved release, evaluate the next 100 ordinary posts against the fixed baseline: zero owner exclusions, repeated IDs or identical titles; zero known subject/type conflicts; report actual category runs and current likes/dislikes with voter counts. Require real fresh quote/SKU provenance before making price-verification claims. No production-after uplift is claimed in this audit.
