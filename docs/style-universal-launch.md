# Universal My Style — launch contract (PR13)

## Audience, identity and persistence

My Style is available to **every verified user of the existing public Mini App**,
not a special owner/wife function. No allowlist, Telegram-ID form, manual
registration, owner approval per user or second-account ID is required.

The server verifies public-bot Telegram initData (production: existing HMAC;
isolated staging: official Telegram Ed25519). It derives user.id ONLY from the
verified signed payload. The empty personal profile is returned automatically;
its first explicit choice/rating/save atomically creates its own persistent row.
Opening alone does not save defaults. Primary keys scope profiles, votes, saved
items and idempotency receipts to that user, never to a shared owner/wife slot.

Query/body user_id cannot choose another account. Main-bot signatures cannot
authenticate the public profile; public-bot signatures cannot administer the
application. MINIAPP_ADMIN_ID is exclusively an admin guard and is not required
for public profile creation or use. Personal preferences do not update channel
ranking, audience reactions or either owner's private training profile.

## Automated evidence

- 554 Node tests PASS, including native Workerd and all existing PR14 tests.
- New dedicated universal regression: 8 different non-owner IDs use the prepared
  production API, share request IDs without collisions, each save distinct
  filters/votes/favorites, close SQLite and reopen with identical separate data.
- Forged selectors cannot read/update another profile. Erasing one history keeps
  other profiles intact. Unsigned, tampered, expired and wrong-bot sessions are
  rejected BEFORE D1 access. Public users cannot access owner APIs.
- 32 diverse Ed25519 identities verified with LOCAL FIXTURE keys; official staging
  key deliberately rejects those self-signed fixtures. These are not 32 real
  Telegram accounts. Additional cases persist profiles with no admin ID at all.
- 16 mobile browser scenarios PASS at 320/390px, including restart, offline, slow
  response, committed-response loss, double click, old-profile migration, privacy
  deletion and production-vs-staging labels. Only loopback fixtures, no remote
  user writes, AI or new software. Main inspected the public-release screenshot.
- Prior real-account evidence: actual Telegram Desktop launch, existing ratings,
  new recommendations and a disclosed technical favorite survive full close and
  fresh launch. No taste votes were invented. A second live consenting account
  has not been tested; it is an **optional additional acceptance check**, NOT an
  access restriction or a blocker requiring the owner to find somebody's ID.

The graph map helped locate route→auth→account/feed/mutate; it uses an older node
scheme and source offsets, so authorization statements were checked against
current source and executable regressions, not assumed from the old graph.

## Safe production package (not deployed)

`prepare_production.mjs` builds a separate copied asset set, additive/idempotent
migration and `release-plan.json`; default mode performs official dry-run only.
`--assets-only` is the non-deploying build mode for future Workers Builds.
The copied public UI has ordinary "My Style" labels, not "test" or "isolated"
claims. Staging and the owner Superfind preview retain their explicit labels.

After the owner's final **Внедряй**, the implementation sequence is:

1. Refresh main and preserve PR14; capture production Worker version, settings
   baseline and a protected fresh D1 recovery/export point. No secrets in Git.
2. Make the new entrypoint/assets build reproducible in the EXISTING Workers
   Builds connection: tracked main=`miniapp/features/production_worker.mjs`,
   assets.directory=`.test-temp/style-production/assets`, build.command=
   `node miniapp/features/prepare_production.mjs --assets-only`. Never leave a
   one-off CLI deployment that the next main build overwrites with the old app.
3. Apply only the reviewed additive feature migration; no scheduler/core catalogue,
   learning, owner-policy or personal-history imports. First deploy new flags OFF,
   check existing routes/Cron and unchanged 30-minute settings.
4. Enable public style for EVERY valid public-bot user and its bounded optional
   catalogue refresh. Persist activation in the tracked build config so the next
   build cannot replace it with OFF defaults. Do not enable/change Superfind,
   automatic Vision, River SHADOW or channel selection. Existing bot menu/root
   remain; the universal My Style button is shown inside the public app.
5. Observe auth/save errors, optional D1 usage/headroom and existing scheduler;
   use normal posting receipts, not additional public test messages. Do not claim
   an independent recommendation uplift without a new blinded sample.

Rollback disables only the new flags/navigation or restores the recorded Worker
version. Keep additive personal tables/data; do not restore an old whole D1 dump
over current posts, reactions, queue or subscriber history. The original posting
handler still runs first, optional refresh errors cannot fail its completed tick.

The EXISTING production config, main branch and deployed Worker are unchanged
at this preparation stage. Superfind still WAITs for trustworthy current price,
stock and savings. This task adds no paid service or AI calls.

## Free budget is not an access allowlist

Existing optional caps remain 50k reads/8k writes per UTC day; isolated stage also
has its all-dynamic 100k read/8k write guard. These limits are account-protection
quotas, not a 25-user registration list. Any signed subscriber can create a profile;
when a budget is exhausted, optional work responds with a visible retryable 429
without disabling the channel. No silent paid upgrade or unlimited-Free promise.
Measured prior remote D1 SQL replay includes indexes/ledgers: like 14 read/13 write,
favorite 14/14, unseen deck 331/6. Roughly 20 likes + 6 small reads ≈ 296 writes/active/day:
about 25 such active users/day under the conservative 8k cap, not a capacity SLA.
Real volume/CPU must be observed before increasing caps; existing production
traffic shares the same account quota. No tokens/user IDs need to be supplied.

**Only final production permission is requested. Two live accounts are not
claimed as verified and are not imposed as an additional owner chore.**
