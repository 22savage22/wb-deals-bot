# Taste calibration: future Admin Mini App handoff

Status: offline contract only. No new API route, authentication mechanism, D1
table, runtime writer, AI call, production deployment or learning switch is
implemented by this document. River remains SHADOW. Existing production
settings, including the 30-minute posting interval, must not be written during
an import or the first opening of a taste screen.

## Existing authentication must remain the only entry point

The current Worker verifies `X-Telegram-Init-Data` through `telegramUser` in
`miniapp/cloudflare/auth.mjs`. For `/api/admin/*`, `worker.mjs` uses the main
bot's `TG_BOT_TOKEN`, then compares the verified Telegram user ID with
`MINIAPP_ADMIN_ID`. Public Mini App routes use `MINIAPP_BOT_TOKEN` instead.

A future preference-import route must run through this existing owner gate.
It must not accept client-supplied `user_id`, `authenticatedOwnerId`,
`allowedOwnerId`, review flags or an identity scalar as authentication. This
offline parser validates data structure, not ownership or a human's identity.
No Telegram IDs, initData, token, cookie or authorization header belong in a
taste export, report or error log.

## Versioned raw-vote transport

`normalizeTasteInput(input, {products, now, traitsById})` in
`miniapp/shadow/taste_report.mjs` accepts a version-2 `wb-fashion-taste.json`
export or a version-1 local server snapshot. Both carry raw `ratings` rows:

```json
{
  "profile": "owner",
  "participant_id": "local-owner",
  "nmId": 123,
  "action": "like",
  "ts": 1791710400000
}
```

The example is schema-only, not a real vote. Profile namespaces are `owner`
and `wife`, with corresponding local participant labels. They represent the
owner's explicit selection of a personal calibration profile, not claims about
external identities. Audience signals remain a separate aggregate adapter and
are never mixed into these personal profiles. Actions are `like`, `dislike`,
`more` and `block_similar`. Undo removes the stored row; it is not another vote.

The parser requires numeric positive safe nmId and timestamps no later than
the server's supplied `now`. It rejects unknown actions, identity mismatches
and malformed rows. The unique key is `(profile, nmId)`: the latest timestamp
replaces an earlier action, identical replays count once, and conflicting
actions at the same timestamp are excluded rather than guessed. A subsequent
strictly later action can resolve such a conflict. Import validation produces
bounded counts and reason codes, never raw rejected payloads.

Client-computed profiles, scores, counts, labels and `features` are discarded.
`products` must be resolved from the server-pinned verified catalog, not
submitted with a vote. Only confirmed WB fashion categories with
`categoryVerified === true` train this report. Historical query labels are
sampling metadata, never category evidence. The report does not refresh or
confirm prices, stock, discounts or purchase suitability.

## Reviewed visual evidence, not inferred taste

`trustedTraitsForProduct(product, traitsById)` is the shared guard for training
and candidate scoring. The caller must supply a server-owned reviewed manifest.
A profile requires `reviewed === true`, `cacheVerified === true` and the exact
photo SHA-256 matching `product.imageHash`; a supplied nmId must match too.
Use the same guard before `scoreTaste` so training and candidate evaluation do
not silently use different photograph evidence.

Review is field-specific work: a model's confidence or a profile-wide flag does
not make a hypothesis true. Entries explicitly marked `hypothesis: true` are
excluded even from a reviewed profile. The manually reviewed manifest should
contain only fields actually verified against that exact photo, omitting
uncertain style, material, texture, carry method and hidden-back claims.
`tasteFeatures` additionally enforces its closed vocabulary, numeric confidence,
visible evidence, and print/front-back consistency. Unknown remains unknown;
seller titles, category, gender or a background must not fabricate visual traits.

Changing a photo hash invalidates the associated manifest for that product.
Server lookup and image-evidence version must be pinned during an import preview
and rechecked before any future write. No repeated Vision call is needed to
import or report already-reviewed identical images.

## A future import should be preview-first, not an implicit write

After existing owner authentication, an eventual route should:

1. Resolve the trusted catalog and reviewed-image manifest on the server.
2. Normalize the export and return a read-only preview: accepted, archived,
   rejected and ambiguous counts, plus per-profile changes. Default is dry-run.
3. Require a separate explicit owner confirmation referencing a bounded
   idempotency request ID and the preview's catalog/manifest/current-state
   revisions. Opening the screen and downloading a report do not save anything.
4. Re-read those revisions before writing; if they changed, return a conflict
   and a fresh preview. Do not overwrite newer live votes with older imported
   timestamps. Equal-time, different-action conflicts require explicit resolution.
5. Upsert one row per `(profile, nmId)` atomically. Replaying a successful request
   must return its existing receipt, not duplicate votes. Keep owner/wife isolated.
6. Preserve archived non-fashion/expired votes as archived transport history;
   never let them train the active fashion profile or erase them as a side effect.

These are integration requirements, not a substitute toy auth API. No such
writer or request-id persistence is added in this offline stage. Before runtime
integration, add route tests for unauthorized public-bot signatures/non-owners,
preview without writes, replay, concurrent revisions, timestamp conflicts,
field/hash forgery, and preservation of production settings.

## Evidence and privacy boundaries

Current personal retention is at most 100 active rows per profile and 90 days;
the parser accepts at most 1,000 combined source rows and a 1,000,000-character
JSON string (a separate byte limit belongs at any future HTTP boundary).
Archived rows retain only local profile label, nmId, action, timestamp and reason.
No personal Telegram identity is needed for preference summaries. A future
persistent archive must also have an explicit bounded retention/deletion policy;
the offline transport limit is not an unlimited-storage design.

At least three distinct products supporting a feature and five rated products
in a profile are required before reporting a preliminary preference. Repeated
clicks on one item do not increase evidence. For visual features, the three
supporting products must belong to the same trusted `visual.group`; two black
shoes, one black bag and one black dress cannot jointly establish a color
preference. Candidate scoring uses only its own group's sufficient evidence,
not a pooled statistic or another group's preference. `visual.group` itself is
metadata, never a predictor. The report expands sufficient `groupEvidence`
into group-scoped rows/labels, so opposite apparel/shoe preferences stay separate
instead of disappearing into an average zero or transferring across groups.
Category and budget evidence retain their existing sample gates.

Category, clothing gender, color,
style, budget and selection exposure can be confounded: counts are associations
in this chosen sample, not causal taste explanations or improvement percentages.
Agreement between owner/wife is computed only on their actually rated overlap.
Do not invent preferences for an unrated profile or mix audiences to fill gaps.

Current regression coverage: `taste_report.test.mjs` validates raw transport,
deduplication/change conflicts, category gates, action counts, archive roundtrip,
profile separation, exact reviewed-image evidence, hypothesis exclusion,
group-scoped support/reporting, immutability and no I/O. It does not prove a
production import route exists.
