# Personal taste comparison: read-only PR 10 continuation

This stage does not import the SHADOW modules into production. The 30-minute
posting schedule, Telegram, Cron, WB search, River mode, PRs 8/9 and the other
agent's prepared Admin/Vision integration are unchanged. No merge/deploy.

## Reproduce privately

The local server uses `.test-temp/value-taste/ratings.json`. A downloaded
`wb-fashion-taste.json` version 2 is supported by the same bounded reporting
parser. Never replace the current state with an older export containing only
one person's votes. Compare normalized votes and archive first.

```powershell
npm run shadow:taste-analysis -- .test-temp/value-taste/ratings.json "C:\Users\valer\Downloads\wb-fashion-taste (1).json"
npm run shadow:gallery
```

The generated personal report lives in ignored
`.test-temp/value-taste/analysis.json`; raw ratings/exports are not committed.
Opening the gallery, selecting a report profile, expanding photos and refreshing
results are GET-only. Only an explicit rating in the existing calibration flow
may persist a vote. Reports are recalculated from trusted metadata/evidence,
never exported client profile/score/feature claims.

## Three different comparisons, not a fabricated before/after

All algorithms see the same fixed 40-card/photo/price-observation manifest and
clock. The manifest hash and rating revision are displayed.

* **Legacy:** the existing pure production chooser, unchanged, repeatedly run
  over remaining snapshot candidates with the same initial counter and empty
  recent window. This is a counterfactual, not a replay of published posts.
* **New, neutral feature ablation:** the same hard personal exclusions, quality
  checks, direct positive-item memory and duplicate policy as the learned arm.
  Only aggregate feature preferences are neutral.
* **New, with supported features:** those identical constraints plus supported
  category/visual preferences. Exact dislike/block cannot be compensated by a
  positive category, large seller discount or score.

The photo-review slate is separate from publication eligibility. It may show
historical photos without claiming fresh price/availability, but cannot pass
invalid product, known unavailable variant, purchase-condition or quality gates.
The slate is not padded to ten with rejected/unsupported items. Direct positive
matches are labelled memory; unrated proposals and their evidence are labelled
separately. `rankChanges` isolates feature effects, not the effect of remembering
which item was liked. No probability of purchase or uplift is invented.

## Generalisation is unproven

Leave-one-family-out removes the held-out vote and all near-duplicate item/image
family votes from training. Insufficient support/zero direction abstains, never
counts as a successful prediction. It remains a small selected retrospective
sample, not a randomized/prospective evaluation. If a person rated all candidates,
the gallery says there are no new unrated examples for that profile.

Visual evidence must match the exact local photo SHA-256, closed vocabulary and
field-level review. The seven reused PR 9 Gemma profiles are pinned to
`acf12f23cab9b8be7e55253de045e4c4a86969ee`; no model/D1/staging call is needed.
Unchecked fields, subjective style hypotheses and material remain unknown.
Support for a visual preference requires three different products within the
same reviewed group (apparel/shoes/bag/accessory), not a pooled color count
across unrelated categories. Opposite group preferences stay separate.

The two additional `photo-observations.json` entries describe directly viewed
photos. They are explicitly **not Vision outputs or training features** and
do not invent a general style from two examples.

## Fresh bargains

`price-check.json` records one ordinary local public WB search on 2026-10-11:
HTTP 403; no retries, proxies, cookies, credentials or production endpoints.
Fresh offers under 100/200/300 RUB: **not confirmed**. A cached historical price
is never labelled a current discount and never grants publication eligibility.

## Future phone integration

See `taste-admin-handoff.md`: versioned raw-vote transport, existing main-bot
Telegram initData owner gate, preview-first explicit import, optimistic revisions,
idempotent upserts, separate namespaces and bounded indexed storage. There is
no new runtime route, auth bypass or automatic D1 migration in this PR stage.

Regression suites cover transport validation, archive isolation, read-only
results/restart persistence, exact dislike/block dominance, group-conditioned
visual evidence, unchanged publication hard gates, fair neutral ablation,
family holdout and forged/mismatched image/profile claims.
