# My Style / Superfind — product readiness (PR13, staging only)

## Scope and current-main compatibility

Current main `0181c179` (merged PR14) was integrated into this isolated branch
as `4e0091f9`. Existing owner exclusions/current-vote Legacy rules are retained.
PR10's already shared evidence/ranking modules are reused, not merged twice.
No production merge/deployment, scheduler settings, bot menu/webhook, channel
ranking, automatic Vision or River mode are changed. Production remains on the
original checked-in `miniapp/cloudflare/worker.mjs` entrypoint.

The existing staging URL and private public-bot launch button remain valid:
https://wb-finds-style-staging.valeramyakishev000.workers.dev/style
Open it using the existing private **web_app** button in @WbPodborr_bot. A plain
browser visit intentionally has no Telegram identity or private account access.

## What now works

- Explicit audience, multiple fashion groups and budget onboarding. First open
  is read-only; no guessed preferences or production defaults are saved.
- Four rating actions, independent favorites, changeable interests, reset with
  favorites retained, or full deletion. D1, not browser memory, owns the profile.
- Unseen recommendations use each user's confirmed evidence; reviewed visual
  traits must match product, image hash and category. No style guessed from a
  product name. Dislikes are narrow evidence, not whole-category bans.
- Similar photo/family suppression and labelled20% exploration. Historical
  rating/review counts are not misrepresented as a freshly verified quality score.
- Ambiguous/lost write response retries the SAME idempotency key. Concurrent
  identical requests return one durable receipt; post-delete in-flight writes
  cannot recreate a deleted account's history.
- Public Mini App functions and strict owner/admin separation are preserved.
  An optional owner-only Superfind preview can use main-bot Ed25519 in staging;
  public-bot initData cannot authorize it. Future production keeps original HMAC.
- Future admin integration lazily embeds the existing preview rather than
  duplicating settings. Its server flag defaults OFF. No publishing button is
  added; Superfind cannot send a channel post from this feature implementation.

## Catalogue and current prices

The bootstrap contains80 actual photographed fashion products and seven already
reviewed visual profiles. Official same-product WB metadata was checked for all
80:63 explicit audience labels,17 unknown. Category/gender metadata is not a
Vision result and is not evidence of price, stock, fit, color or print.

A separate LIVE staging proof obtained three previously absent products from
the existing public native catalogue: `223923220`, `1497934845`, `963741655`.
Each was independently checked against official WB metadata AND actual WebP
bytes, hashed, admitted to staging D1, increasing the snapshot to83. Six serial
normal requests, no retries/bypass/AI; official D1 meta388reads/25writes for this
one operator run. Prices remain unknown, not copied from the cached catalogue.

The prepared continuous adapter reads at most120 native cached rows every20min,
then independently verifies at most3 new candidates /6 normal serial requests.
403/429 persists exponential backoff+jitter20min–6h. No WB/AI per swipe. Active
catalogue cap300, recommendation snapshot120; archived saved cards are retained
and reclaimed after the last favorite is removed. A controlled same-origin photo
proxy validates nmId/host/path, bytes, MIME, WebP and hash, then caches the result.
No AI calls are made and no new source or publishing scheduler is installed.

One fresh price-card request returned HTTP403. No repeated endpoints, cookies,
proxies or challenge bypass. Therefore fresh-price/stock-qualified Superfind is
**WAIT**, not a fabricated discount. Unknown price with an explicit budget
produces an honest empty result rather than silently ignoring that budget.

## Verification and evidence limits

- Full final Node Worker/SHADOW/features/admin regression:550PASS, including
  native Workerd redirect200/302/cache/source regression (not just Node mocks).
- Existing `tests/run_all.py`: ALL TESTS PASSED.
- Independent focused security pass:42PASS.
- Mobile product browser scenarios:15PASS at320x740/390x844, including lost
  response AFTER commit, double click, offline/retry, slow response, close/reopen,
  A/B isolation, reset, full deletion and actual local server/SQLite restart.
- Existing rated profiles with old empty filters can still read both decks
  without onboarding/default writes. A dedicated reopen regression confirms
  no extra settings PUT and an identical persistent profile. New users still
  explicitly choose their first interests.
- These browser users and signatures are explicitly LOCAL FIXTURES. They are
  not two actual Telegram accounts, and no fake votes were added as real users.
- Main independently inspected narrow-screen onboarding/card/favorites images.
- Actual account evidence now includes opening the existing private public-bot
  button through Computer Use in Telegram Desktop, reading the real profile,
  fully closing/reopening into a NEW Mini App window and reading the same saved
  ratings/summary. No preferences were fabricated or submitted by the agent.
  Actual favorite persistence and a second consenting real account still need
  acceptance; personal counts/receipts are kept private, not in this public repo.
- Worker CPU/phone p50/p95 and recommendation-quality uplift are not claimed.
  Unseen selection is tested mechanically; relevance needs future user feedback
  on new items, not retesting training examples as an uplift measurement.

Live integration found a defect missed by Node's mock fetch: this Workerd
runtime rejects `redirect:'error'` before contacting WB. Sanitized phase/type
diagnostics plus a REAL local Workerd fixture reproduced the exception without
external network. Worker requests now use `manual` and reject all non-2xx,
including redirects, without following Location. Native-runtime tests cover
200 photo/source, cache and302 rejection with zero foreign redirects. All three
new real photos subsequently returned200/image-webp from LIVE staging with
matching SHA256. No repeated WB source search or auth scope expansion was used.

## Genuine D1 cost measurements

Official REMOTE STAGING D1 metadata from SQL replay of the actual API/store code,
including physical indexes and all three budget ledgers. This is **not** a live
Telegram-authenticated HTTP acceptance test. The inaccessible negative technical
user and its separate old-day ledgers were removed and cleanup verified.

| Action | Queries | Rows read | Rows written |
| --- | ---: | ---: | ---: |
| Open profile |7|5|9|
| Explicitly save interests |12|12|11|
| Load20-photo deck |10|171|6|
| Like |15|14|13|
| Favorite |15|14|14|
| Retry same committed request |7|8|6|
| Switch like→dislike |15|16|12|
| Read favorites |7|10|6|
| Unseen recommendation deck |10|331|6|
| Delete this history+favorites |15|30|16|
| Reopen after deletion |7|8|6|

No median/p95 is inferred from single measurements. Cold public-cache init and
future production costs can differ. Headers/log counters distinguish HTTP from
separately budgeted background jobs; missing metadata stays UNKNOWN, never0.

Official D1 Free is5Mreads/100kwrites per UTCday, SHARED by all account DBs;
index writes count: https://developers.cloudflare.com/d1/platform/pricing/ .
Staging-wide admitted dynamic work is conservatively limited to100kreads/8kwrites
perUTCday, including core public APIs and background tasks. The lower50k/8k
feature guard and existing optional guard remain; unknown costs retain the full
reservation. Guard overhead/admission failures still cost rows. This is not a
claim that independent production traffic or a hostile flood has zero cost.

Illustration, not capacity SLA:20likes plus6other small reads consume roughly
20×13+6×6=296writes peractive/day (before first setup, deletes, cache or retries).
An8kwrite cap therefore supports only about25 such active subscribers/day with
headroom, NOT unlimited growth. Observe real usage and quotas before wider
rollout; do not silently raise caps or upgrade to Paid. Static assets are cached;
one deck fetch serves20 ratings, no full history read per swipe.

## Production package — PREPARED, NOT APPLIED

`node miniapp/features/prepare_production.mjs` generates a separate ignored
package/config and performs an official Wrangler **dry-run only**:

- Original production config/bindings/Cron are retained; prepared composition
  runs the original scheduler first. Optional enrichment cannot stop posting.
- `SUBSCRIBER_STYLE_ENABLED`, `SUPERFIND_PREVIEW_ENABLED`,
  `STYLE_CATALOGUE_REFRESH_ENABLED` all default `'0'`.
- Additive migration creates only new feature tables/indices/triggers and public
  bootstrap examples. It does not copy personal histories, rewrite core products,
  owner settings, scheduler state/inventory/deliveries or learning state.
- Migration is checked twice locally for idempotency. Only later explicit flag
  activation would expose navigation/new endpoints. Runtime secrets are reused,
  never copied into source or sent to a staging Worker.

Before an approved production rollout: refresh main; capture previous production
version and a fresh consistent recovery/export point without exposing personal
data; confirm30min/autopost/search/reactions/SHADOW/autoVision settings; inspect
additive migration; apply only with approval, deploy allflagsOFF; recheck old
paths/Cron; then enable public style alone and observe costs/errors. Superfind
publication and autoVision remain OFF. Independent new-item evaluation and real
account persistence must not be represented as passed until observed.

Rollback: first disable only the three new flags/hide navigation, restore the
recorded preceding Worker version if necessary. KEEP additive personal data;
never overwrite fresh queues/delivery receipts/votes with an old whole-D1 dump.
No token rotation or production scheduler disabling is required.

A private ignored staging export was restored locally with integrity/foreign-key
checks before migration. It contains no production data. Backup files, personal
IDs/initData and real-user receipts must not be committed to this public repo.

**Final production gate remains the owner's exact command `Внедряй`; no merge or
production deployment is authorized by this report.**
