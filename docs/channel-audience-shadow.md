# Channel audience SHADOW — separate from PR17

This branch adds a bounded proposal to the existing native selection/learning path. PR17 remains unchanged at 608ab2c; its category correction is the explicit base dependency. Personal galleries, owner/wife taste, `style_votes`, clicks, saves and synthetic assessments are never audience training inputs. No new Mini App, service, schema, inference or active ranking mode.

## Measured current limitation

Read-only production on 23 October 2026: 235 current channel votes, 53 likes / 182 dislikes, on 215 products from two voting accounts. They are account identities, not proof of independent people or a representative sample. No current ready item has an item vote; native Vision profiles for the captured candidates are absent. Existing trait transfer has zero active supported traits. Removing all feedback leaves the next Legacy choice unchanged. This is insufficient evidence to change selection on the audience's behalf.

At 15:17 Moscow, deployed Legacy, PR17 alone and this proposal all chose article 1259137087, “Облегающий лонгслив skims”, queued snapshot 998 RUB. The later normal channel post3395 confirmed that Legacy actually published it. There were no subsequent channel votes at the follow-up read; it is not evidence of improved audience satisfaction. A later queue read chooses article1504498836 under all three methods. Price snapshots are not checkout guarantees.

## What can affect the proposal over time

- Current unique `(scope=channel, voter, pid)` sentiment only; repeated button presses cannot create extra people or trials. No personal aliases or inferred subscribers.
- Semantic types require an observed WB CDN subject. Unknown subjects remain unknown, rather than getting a type from title keywords for training.
- Visual keys must come through the existing current-image/model/version guarded `cachedProfiles` adapter. Hypothetical style and combination keys are excluded. Group namespaces prevent footwear color from training clothing color. Missing visual fields cannot become negative reference examples. No model is called.
- Each subscriber contributes one directional comparison per feature: their like rate on at least two products with the feature versus at least two comparable products without it. Reference products require a known other type or a verified alternative value of the same visual field. A generally critical subscriber does not automatically make every category negative.
- At least five directional voting accounts, four feature products, four reference products and twelve feature votes are necessary but not sufficient. A two-sided exact binomial sign test must pass with a Bonferroni correction over observed feature keys. Wilson intervals only describe account-direction consensus, not a calibrated probability that the whole channel likes an item. Multiple ratings from one subscriber are not independent binomial trials. [NIST: binomial confidence methods](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm), [NIST: exact binomial limits](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm).
- Accepted evidence supplies a shrunk soft adjustment capped at ±15% overall. Correlated fields are averaged, not multiplied. There is no learned hard category ban.
- Without accepted matching evidence, proposal and tie order remain exactly Legacy. No random shuffle or forced alternate “personalization”. Owner PR14 exclusions, validation, final owner gates, topic/title duplicate rules and current safety checks still apply. With active proposal evidence, an eligible alternative is preferred after the configured consecutive-type run.

The first small group of accounts is not the entire audience. These are conservative selection heuristics awaiting independent outcomes, not certified population preference estimates.

## Existing runtime integration, default OFF

Only `AUDIENCE_SHADOW_ENABLED=1` prepares the additional evidence, using the already fetched maximum500 unique channel rows and already validated visual cache. At most64 traits receive detailed tests; multiplicity correction still counts all observed keys. There are no additional D1 reads for the model and no new table.

The actual publisher continues selecting Legacy in both modes. The opt-in proposal, frozen time, training counts, novel cohort and explanations are stored inside the existing `learning_shadow.features._audience_shadow` payload on the same write. This metadata is explicitly stripped from River training events and train exports; it is not a model feature. Existing River SHADOW columns retain their meaning. No configuration flag is set by this branch and no LIVE mode is introduced.

The extra computation has not been measured against Cloudflare Free CPU; no CPU experiment was performed. Optional SHADOW deployment is itself a production Worker change and requires owner approval and the existing release constraints. Default OFF is not evidence of Free-plan headroom with the feature enabled.

## Prospective outcomes

Freeze before observing test outcomes: code/model version, snapshot time separately from freeze time, selected Legacy/proposed IDs, training IDs/hash, source and novel IDs. IDs with training votes are excluded from the cohort. The local first manifest was frozen at15:25:49 Moscow from a15:17 snapshot; a timestamp-label correction used its original file creation time, leaving all predictions unchanged before follow-up was fetched.

The twenty novel candidates have zero overlap with training. Current Legacy and proposal agree. Post3395 subsequently exposed one candidate naturally; zero subsequent votes means the result is **insufficient follow-up**, not a win or loss. Unpublished candidates are unobserved, not dislikes. Personal gallery responses must never fill these missing outcomes.

After approved passive SHADOW, use the existing records and current channel votes to report natural delivery/exposure, unique reacting accounts, likes/dislikes and outcome coverage at a fixed24/48-hour window. Evaluation votes must not enter the frozen model for that cohort, although a later production decision may learn from newly available current votes. If a proposed-only item was never published, its counterfactual outcome is unknown. Comparing only the rated intersection introduces selection bias; do not claim causal uplift or treat missing reactions as approval. Different next-item predictions alone do not prove improvement. A later owner-approved rollout with adequate independent outcomes is needed before changing actual selection.

## More real reactions with existing buttons

Propose one pinned explanation and a short line in ordinary captions: “Нажмите 👍, если хотите больше таких находок, или 👎, если меньше. Оценку можно изменить.” Use the existing callback buttons; no new app, rewards, fake accounts, automated clicks or invented ratings. Publish only with owner approval. Measure growth in distinct reacting accounts and posts with several distinct reactions; total button presses are not the target.

## Correctness and activation conditions

Focused tests cover one prolific voter, two voters/hundreds of votes, genuine separate accounts, unknown/reference visual fields, group separation, owner bans, no-data exact fallback, metadata isolation and unchanged Telegram send payload when SHADOW is enabled. Synthetic tests establish implementation behavior only, never audience uplift.

Keep PR17 as its own release. This learning branch is reviewed against PR17 and cannot be merged into its approval silently. No migration, deployment or tariff change is performed. For rollback of an approved passive release, disable the new SHADOW flag or restore only the owned Worker code version; never rewind live D1 over new posts/reactions/claims. Before any active ranking: sufficient independent channel evidence, honest held-out outcome coverage, preserved bans/diversity, verified operating limits, and separate owner permission. With the present two accounts and zero follow-up votes, active ranking is **NO-GO**.
