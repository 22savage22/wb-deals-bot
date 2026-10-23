# Fashion baseline: isolated editorial SHADOW

## 24 October update: photograph quality precedes allocation

Category admission is no longer sufficient for a proposal. `chooseFashion()`
requires relevant verified photograph evidence or a recent editorial review of
that exact item and image source version. An editorial review is a bounded
per-item decision, not a learned audience preference; it expires after 24 hours,
and changed photo sources invalidate it. Quotas are evaluated only after this
gate. No review is inferred from a seller's declared cut, keyword, empty bucket,
or two channel voters. The `Кофты` WB category is correctly admitted as clothing,
but still needs the same photograph gate.

The existing localhost gallery now shows 15 actual ready candidates from the
24 October 00:02 Moscow snapshot, with 23 real photographs. Eight are editorial
recommendations and seven are reserve, not a 15-item publication authorization.
The native Worker does not read local gallery ratings/reviews. With the current
zero usable native Vision profiles and no supplied editorial review context,
its passive fashion proposal is empty. This is intentional. The previous
category-only 15-item list is superseded as a publication proposal.

The first live trial is limited to 10–15 owner-approved items, only after enough
qualified supply and separate permission. It can use the existing admin queue's
specific-product selection with per-send checks at least 30 minutes apart; no
new sender, Mini App or learner is needed. Current eight recommendations fall
short of ten. Rehearsal of those eight is local only, with all HTTP intercepted,
on current main and PR17 separately. Reserve items never fill missing slots.

Existing aggregate production Logs show scheduled CPU p50 12 ms / p99 107 ms /
max 172 ms for the preceding 24 hours. These are sampled invocation metrics,
not a benchmark of this branch and not proof of Free headroom. The declared
Free Cron CPU limit is 10 ms; temporary platform flexibility is not a release
guarantee. No production CPU experiment or tariff change was performed.

Search evidence and the limited-pilot checklist are in the task's dated audit.
The separately found rolling-count rotation defect is prepared on another
branch based directly on main, not folded into PR17 or this fashion branch.

The owner set the channel scope to adult men's/women's clothing, footwear, bags
and accessories. This is an editorial policy, not a claim that two voters
represent the audience. No personal style/gallery ratings train this filter.

## Selection

`fashion_selection.mjs` reuses the existing fashion category vocabulary and
selection/owner gates. Only an observed WB CDN category can admit a product.
Books, stationery, household goods and unknown categories are rejected. For this
initial everyday-fashion pilot, underwear, nightwear, swimwear, indoor slippers,
children's/costume/work uniforms are outside scope. A negative title check is
only a safety veto, never positive fashion evidence.

Adult clothing allocation requires the official `Пол` metadata. Search query,
the photographed person's appearance and seller title do not establish gender.
Unisex clothing is assigned to the underrepresented clothing bucket and counted
once. Unknown clothing audience is deferred rather than guessed.

The first 40 **actual** pilot deliveries target 14 men / 14 women / 8 footwear /
4 bags+accessories. Select the available bucket with the largest proportional
deficit; never exceed a bucket's pilot cap or renormalize a missing bucket.
Stop after 40 deliveries for review. Missing supply leaves a shortfall. Existing
topic/title/owner filters remain, with at most two consecutive product types
and a six-item near-duplicate check. No suitable item means no proposal.

Positive visual scores use only the image/model/version-validated existing
`cachedProfiles()`: visible oversize/loose/straight cuts, graphic pattern, fitted
women's silhouette, footwear/bag geometry. A `style` hypothesis is ignored.
Official hoodie/bomber categories are an explicit small editorial preference;
official wide/straight jeans specifications are labelled seller declarations.
Titles never earn style, print placement or cut points. Contradictory confirmed
cut vs photo evidence is deferred. No valid visual evidence means unknown style,
not an invented fashion match. This cannot certify that a generic eligible
T-shirt is contemporary or desirable.

Current item reactions contribute at most ±2.5% in this baseline. No transferred
category/visual audience coefficient or personal ratings are used. Existing
independence/statistical gates are not lowered; the separate audience-learning
branch is not included. Reactions and existing feedback capture are unchanged.

## Integration and guardrails

Default is OFF. This branch contains no live-selection switch. `choose()` and
the final Telegram sender continue to use Legacy in every mode.

Only a separately approved deployment may set `FASHION_SHADOW_ENABLED=1` and an
explicit Unix `FASHION_PILOT_START`. Without both, no pilot proposal is recorded.
On due posting attempts, use existing `learning_shadow.features._fashion_shadow`
for the editorial receipt, without schema migration or a new process. One
bounded existing-deliveries read recovers the first 40 actual pilot items, even
when quiet hours mean they span more than 24 hours. Receipts include unassigned
Legacy deliveries: do not pretend a passive SHADOW controls actual proportions.
River feedback/train exports strip editorial metadata, so it is not a feature.

The existing WB CDN request may additionally retain bounded gender/cut metadata
when it is already fetching a generic category. **No new network request is
made for a known category**, even with SHADOW on. Existing known queue entries
therefore require a separately approved read-only metadata preparation if they
lack gender. The offline audit did that for its sample; it was not written back
to production. No AI inference runs. Runtime and Free headroom have not been
measured by a new CPU experiment; that remains a release limitation.

## Evidence on 23 October 2026

Read-only snapshot 18:07 Moscow: 68 ready items, 235 current channel votes from
two accounts, zero usable candidate Vision profiles. Separate bounded public
CDN reads and inspection cover 27 real candidate photographs/cards.

After offline metadata enrichment: 39 non-fashion products rejected and one
unknown category deferred; 28 broadly thematic candidates remain (8 men's,
3 women's, 1 footwear, 16 bags/accessories). The particular snapshot's existing
topic/diversity limits stop the simulated pilot at 15 items: 8/2/1/4. Missing
slots are not filled. There are no queued jeans, hoodies or bombers in this
snapshot. The ≤1000 RUB budget and real supply remain constraints, not permission
to invent products or prices.

The same 27-item comparison permits seven household items in Legacy and rejects
all seven in fashion SHADOW. This establishes scope correctness, not aesthetic
or subscriber-reaction uplift. All 28 thematic candidates still have unknown
machine-verified styling; human image notes in the audit are not native Vision
profiles and are not represented as automated evidence.

Local Worker staging replays the real 68-item queue, 100 posts and 235 votes with
all HTTP intercepted, a controlled due clock, no real Telegram calls and no
production writes. OFF/ON payloads and external request lists must match; a
second tick must not duplicate the fixture delivery. Synthetic 40-item tests
verify 14/14/8/4 only under adequate diverse supply, not 40 real publications.

## Release and rollback

PR17 remains independently reviewed at `608ab2c`, base main `524fbe89`; this
fashion branch is based on that commit and does not modify PR17. No main merge,
deployment, tariff change, new Mini App, new service, or automated reactions.

Before any approved live pilot: review real current supply/photographs and
metadata gaps; use the existing query administration to retire household
queries and add the missing fashion directions; retain the budget/rating/owner
limits; verify the quoted price/stock send path and remove any unproven discount
claim; check the approved build within Free; obtain owner permission. A passive
SHADOW release also needs explicit permission. This branch does not turn its
proposal into a publication. First review proposed scope/diversity, then the
first 40 actual pilot posts and real reactions without claiming two voters are
the entire audience.

Rollback: disable only the fashion SHADOW flag, or return to the approved prior
Worker code version. Keep posts, claims and votes. Never rewind D1 and resend
already delivered items. The existing private backup was restored and checked
locally; it is not a replay command or permission for production restoration.
