# Publication quality and current channel feedback — approval gate

Prepared 2026-10-17 on `codex/publication-quality-feedback-20261017`, based on
main `7a11699aef7de9b029496291cbe48524d9d92085`. **Not deployed or activated.**
No PR10/13 checkout, merge, rating import or branch edits. Public app, reaction
write/ack path, schedule settings, automatic Vision and River model are unchanged.

## Verified production diagnosis

Worker `fbfc53e2-7ed0-4b88-a620-ee79bdb294bc`, minute Cron, posting ON/30 minutes,
SHADOW, automatic Vision OFF verified via Cloudflare API. Real message3110
was followed by an independent Cron tick; ready inventory67. Instrumented daily
D1 counters at the first check: core65381/optional84726 reads, not account billing.

There are134 current channel sentiment votes:39 likes/95 dislikes, from2 distinct
pseudonymous voters. Native `learning_events` contains39 likes/95 dislikes plus
one buy. Last stored real callback: message3053, ack53ms; no dirty/error messages.
Legacy imported aggregate baselines are not invented into individual voters.

The real Worker `choose()` uses audience rotation, topic/title caps and metadata
filters. It does NOT call Python `smart.score()`/`record_feedback()`. Native votes
do reach learning, but `shadowChoice()` is observational in SHADOW; its prediction
does not rank actual posts. The old Python consumer is not the native scheduler.
Thus recording feedback or training River was never proof of preference-aware
production selection. Repeated/change events also cannot serve as independent
current votes; this new projection reads `reaction_votes` instead.

Most price endpoint cards have no `subjectName` and were stored as `другое`.
143/165 historical learning events fell into that one broad bucket. The active
query `Химия` returns educational books; historical `Образование` and unrelated
queries exist in delivered goods. Current saved owner words were expanded today
(audit4, timestamp1792232332): тетрад/учебник/книга/канцеляр/пособие/прописи.
Those words do not cover `Таблица Менделеева` or all exam aids. Existing filters
are preserved, never overwritten by the new panel.

Two genuine official WB CDN reads returned HTTP200 with matching nm_id:
360552164 → `Учебники`, root `Книжная продукция и диски`;
405323854 → `Сумки`, root `Аксессуары`.
This is category evidence, not a guessed visual style or fresh price claim.

Graphify local code-only extraction supported tracing the disconnected paths;
SQL AST extraction lacked tree_sitter_sql, so schema/SQL were checked directly
and with SQLite query plans. No graph/LLM/AI service was used for preference data.

## Prepared behavior

Separate `scheduler_policy.audience_quality` starts OFF/empty. GET cannot enable
it. Owner-authenticated, explicitly confirmed CAS/idempotent saves are required.
No initialization writes default rules or changes existing selection settings.

Owner category groups are textbooks, study aids, notebooks, stationery, books.
Explicit WB subject names take precedence; official observed product CDN metadata
fills generic subjects, with matching nm_id, HTTPS allowlist, bounded body,
3-second timeout, one attempt and a current-card cache. School/exam/title fallback
does not manufacture style. Bags for textbooks, school clothes, ebook readers,
home goods and electronics are not implicitly banned. Unknown metadata stays
unknown; do not claim perfect classification of unseen seller mislabelling.

Gates: query strategy → found card → verified queue admission (fresh policy)
→ old queue choice → validation → fresh policy before claim → final pre-send gate.
Bootstrap retains owner rules and filters incoming cards. Manual queue publishing
uses the SAME gates; a forbidden requested product cannot send a substitute.

Five-minute maintenance quarantines banned rows as `owner_excluded`, with their
previous state and card retained. No history/whole-queue deletion. Re-enabling
restores unexpired rows, never admin-removed/posted/uncertain rows. Existing
claims and seven-day dedup still protect restored cards. Old independent word
exclusions may also need explicit removal by the owner when re-enabling a group.

Current-vote item scores are bounded and incorporate likes AND dislikes.
Type/verified visual-trait weights require >=5 people, >=4 products, >=12 current
votes AND Wilson95% evidence on one side of50%. Otherwise multiplier1, no broad
penalty. Never learn `другое` as one category; use a narrow metadata type/query.
An owner ban always wins; scores cannot hard-ban another category. No imported
private owner/wife PR10 scores, staging profiles, fabricated uplift or River change.
Visual features require the existing current-image/model cache checks; unknown
and unconfirmed style hypotheses are excluded. No new AI calls are made.

Optional +15% fashion priority and soft type alternation do not change price,
rating/review thresholds, diversity settings or owner query list. Final captions
still advertise only the checked current price, not seller crossed-out discounts.
No eligible card means skip + recorded reason; search/next Cron remain enabled.

## Offline replay of the fresh full production backup

Full protected SQL export:5725652 bytes,
SHA256 `95035e880e5da298af472ad8202e1ec7ec317dc9d2a7a56aa57b5a1cdeff3842`.
Local restore: integrity_check OK, foreign_key_check0,45 tables. No restore to
production. SQL, credentials and individual pseudonymous vote keys are NOT in Git.
Reproduce locally with `node miniapp/cloudflare/quality_replay.mjs <protected SQL>`.

Snapshot inventory67. New owner rules identify5 educational cards; seven cards
already fail other/current filters. Overlap3, therefore58 pass the combined rules.
Filtering uses the union of rejection reasons, not subtracting overlaps twice.

| nmId | Real snapshot card | New result |
|---|---|---|
|173211562|Химия 9 класс… Рабочая тетрадь|Owner notebook ban|
|155660355|Таблица Менделеева… А6|Owner study-aid ban|
|213852374|Химия в таблицах… ОГЭ/ЕГЭ|Owner study-aid ban|
|104261171|Химия… Тетрадь для практических работ|Owner notebook ban|
|360552164|Учебник. Рудзитис Химия|Owner textbook ban|
|405323854|Сумка мини кросс-боди,753 RUB/4.5/278 reviews|Pass metadata filters|
|566786215|Худи мужское,998 RUB/4.8/1463 reviews|Pass metadata filters|
|983111804|Лонгслив… с принтом,795 RUB/4.8/302 reviews|Replay choice|

Old replay choice1442453121 (storage organizer); proposed choice983111804.
Prices are export snapshots, NOT current bargain/live stock validation. The
next actual choice can change with newer posts, inventory, price, photo and caps.
No group weight is currently penalised: only2 real independent voters. Item
signals, explicit owner exclusions and approved fashion priority are separate.

## D1 cost and failure boundaries

Two additive indexes in `miniapp/cloudflare/audience_quality.sql`:
`reaction_votes(scope,last_event DESC)` and inventory`(state,queued_at,pid)`.
No schema creation/index rebuild in a reaction or idle minute Cron.

Feedback: latest500 CURRENT channel votes by index, PK card joins and existing
bounded profile-cache queries. Once per due publication attempt, not every
minute/callback; admin summary is optional-budget, rate-limited owner-only.
EXPLAIN: SEARCH reaction_votes USING INDEX reaction_votes_quality_recent;
PK seeks for cards, no publication-history scan. `SCAN v` is only that limited
derived window, not the unbounded vote table.

Quarantine: three indexed windows of <=300 rows per5-minute maintenance, one
JSON-driven UPDATE FROM/PK CAS, no quadratic correlated scans or one query per row.
Upper window estimate900*288=259200 scanned candidates/day plus bounded PK
updates on changes. Typical current inventory is much smaller. Feedback joins
at48 posts/day are roughly100k–200k additional indexed visits/day at the500-vote
cap; profiles/admin may add more. Conservative combined planning headroom <600k
additional reads/day under ordinary use, NOT a measured production after value.
Existing 3M internal daily read/80k write guards remain unchanged, leaving room
under account Free limits; other Workers still share the account and require
monitoring. Unknown metering is never treated as zero. Real D1 after-cost must
be measured during the separately approved rollout, no invented row-read proof.

Active-quality cold two-candidate posting and existing cold failover tests stay
<=50 D1 queries. Missing feedback index/metadata falls back only for SOFT scores;
owner bans remain. Missing quarantine index defers maintenance without creating
DDL or bypassing send gates. WB/Telegram timeouts and dedup paths retain tests.

## Safe rollout — requires a separate owner confirmation

1. Review this isolated Draft PR and green CI; compare current main and leave
   PR10/13 separate. No blind merge of their private-taste/public-app components.
2. Refresh Worker version, schedule30min, SHADOW/OFF, config/policy fingerprints,
   queue/real reactions and a new protected verified SQL backup if this one aged.
3. Apply ONLY the two additive indexes to wb-finds-miniapp; verify query plans
   and actual D1 metadata. No other database, data migration or full restore.
4. Deploy approved code with `audience_quality` still absent/OFF. Check real
   phone admin, owner-only auth, no opening writes, search/Cron/reactions and costs.
5. After explicit approval, save ONLY the new quality key: enabled=true,
   five exclusions, feedback_enabled=true, fashion_priority=true. Preserve the
   entire existing policy and30-minute scheduler; CAS avoids overwriting edits.
6. Observe reversible quarantine and actual ready/allowed counts; inspect the
   first NORMAL scheduled post and next independent Cron. No extra test posts.
   Verify persisted explanation, no banned category, reaction markup and budgets.
7. Pause/rollback only the NEW policy if quality/cost fails; production Cron stays
   ON. Keep Vision OFF and River SHADOW throughout.

Rollback first disables ONLY audience_quality through confirmed CAS/history.
New runtime restores unexpired owner_excluded rows on maintenance; verify that
before a code rollback to recorded Workerfbfc53e2. Keep additive indexes and live
posts/votes/receipts. For a broken deployment, review targeted indexed quarantine
restoration against current rows before reverting code; NEVER restore an old
full SQL export over ongoing production writes. No schedule or full-policy reset.

Phone after approved rollout: WBmarket → /admin → Подбор → Качество и реакции.
Read real counts, exclusions, rejected cards and reasons. In История правил
качества restore a prior configuration only after confirming the change.
Preparation alone is not production DONE.
