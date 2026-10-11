# Gemma validator follow-up — 2026-10-11

Existing Draft PR9 / `codex/visual-staging-agent-20261010`, isolated
`wb-finds-visual-staging`, D1 `5779987d-1100-45ad-8cd4-9df9c1436a20` only.
No production deployment, Telegram, Cron, administrative settings, Astra PR8,
merge, Paid plan or bulk inference. River remains SHADOW, enrichment OFF.

## Root cause, reproduced on the failed photograph

nmId **1113687154** returned valid complete JSON with nine evidence-bearing
fields,903characters,finish_reason=stop,provider cost13.518181800842285Neurons.
The rejected field is **neckline=off_shoulder**, outside the closed vocabulary
`round / v_neck / collared / hooded`. The former enum check threw
`VISUAL_INVALID_PROFILE` for the ENTIRE response, losing eight independent
valid fields. This was not a JSON syntax/type/truncation or quota failure.

The original raw response was discarded. This is the actual newly reproduced
failure on identical SHA-256 photograph, same model/full prompt/temperature0;
length,field count,finish and cost match the earlier receipt. Byte-for-byte
identity with the discarded original cannot be proven. No raw output/secrets
are retained in diagnostics.

## Systemic fix, not acceptance of unsupported attributes

The typed normalizer is shared with safe diagnostics. Malformed JSON/root,
wrong category,invalid view/field container and >12fields still reject the
whole response. Individual invalid types,unsupported values,missing or weak
evidence and confidence outside0..1 now leave that attribute **unknown**, not
an invented valid enum. At least two independently accepted fields are still
required before profile/cache persistence. Alias mappings are field-specific:
e.g. a sleeve synonym cannot become a garment length.

No new off_shoulder enum was added merely to pass the test; neckline remains
unknown. Unseen backs/material composition remain unknown. Partial/contradictory
solid-pattern evidence (e.g. “main body”,stripes/logos) is excluded. Styles
remain hypotheses; confidence is model self-assessment, not calibrated accuracy.
Normalization revision3 is separate from cache version2: no reinference of the
seven previously successful identical image/model versions.

Tests cover apparel/shoes/bags/accessories, arrays,naked fields,extra keys,
string/nonnumeric confidence,missing evidence,unexpected enum,category mismatch,
strict complete JSON,visibility,unknowns,old-cache access,one bounded root retry,
atomic reservation/concurrency/unknown-cost/restart/over-reserve holds and
nonresetting historical ledger. Synthetic unit fixtures are NOT live proof.
Final local result: **180/180 Worker tests PASS**, `git diff --check` PASS.

## One isolated additional experiment, cap150

Persistent ID `gemma-schema-20261011-150`; cap150,maximum3calls,exactly three
remaining image SHA-256 hashes. Only one call per hash in this new explicitly
approved validator test; the old500 experiment and failure counters remain.
No timer,Cron,activation,automatic retry or reset at midnight/redeployment.

Stage bundle only: <=4096UTF8 prompt bytes,one image<=1120visual tokens,
4096conservative template allowance,max600completion,no thinking,json_object.
Bounded pricing estimate101.042192Neurons below pre-call reserve110; template
allowance is not a provider contract. Unknown/unfinished expense retains the
reservation and durable hold; above-reserve cost also holds further work.
General production reserve2500 and900completion settings are unchanged.

### Actual results

|nmId|Result|New provider Neurons|Evidence|
|---|---|---:|---|
|1113687154|8valid fields; neckline unknown|13.518181800842285|D1 profile,receipt,immediate cache replay with no AI|
|1138890506|9valid fields|13.818181991577148|D1 profile+receipt after TLS-lost HTTP result; cache replay not completed|
|449731422|NOT analysed|0|Stopped before inference after repeated TLS client failure|

**Additional measured27.336363792419434/150**,2calls,hold empty.
Prior Gemma104.6454553604126 is not reset: combined Gemma131.98181915283203.
Historical Llama cost remains separate, not credited back. These are provider
`cf-ai-neurons`/usage receipts, not token estimates or a whole-account Usage claim.
Current UTC-day staging ledger27.336363792419434; other account use unknown.

Read-only D1 confirms **9profiles/10**, including byte-identical seven old
profiles. Eight immediate cache replay checks total (seven old,one new) with
zero additional AI. Pink dress is durably saved and hash verified, but its
separate replay check is explicitly unconfirmed, not called successful.

The first setup failed before inference; PowerShell TLS and native curl35
errors also interrupted requests. Non-AI session recovery switched Windows
transport; only GET403 propagation reads were retried. No lost POST was resent.
After the repeated TLS error the experiment stopped, with third item unspent.
No additional inference to diagnose transport or recover the pink profile.
Last observed fetch-only staging version12b5ae85-a211-4d3f-8257-a0186fc1ba54.
After test stop, final defensive hardening deployed only to staging,
version**2f709882-f81d-4b08-95a9-f096418b3e7c**; public health confirms pinned
test D1 and `scheduled=false`. This deployment made zero AI calls. The saved
test receipts/gallery correctly retain the earlier actual test deployment ID.

## Photograph review / gallery

`docs/vision-gemma-20261011/gallery.html` is self-contained with all ten real
public photographs, independently SHA-256 checked; `report.json` preserves
safe profiles,provider costs,known/unknown/contested traits and stop reason.
Read-only local browser preview: http://127.0.0.1:8771/ . It serves only the
gallery and pinned public photos,never repo/config/auth/logs. Opened as a
rendered browser page, not a source editor.

38/40 returned frozen controls match,2missing of42 (unanalysed tights).
These controls are small,non-independent and omit many attributes; NOT a95%
general model accuracy claim. Colors9/9match the displayed photos. Black
dress color/short length/fitted torso agree. Pink dress color,small black
heart print,short sleeves,round neck and visible front print agree.

Remaining concerns: shoulder vs crossbody; smooth vs glossy are nonexclusive
properties; whole-sneaker solid pattern is overbroad in an old preserved
profile; romantic/casual style subjective; asymmetric dress neckline omitted.
Materials,absolute size,unseen back and uncertain fit remain unknown.

## Readiness and proposed gated rollout (NOT executed)

**NOT READY for unattended production**: third item and pink cache replay
remain unverified due transport; disputed cached attributes need exclusion.
After a separately authorized remaining staging check and owner photo review:

1. Revalidate existing cached analyses offline,without AI; exclude contested
   fields. Preserve image/model/hash cache and measured budget history.
2. Explicit owner permission for production deployment,additive D1 changes,
   bounded sidecar only; start1–3products/day,SHADOW,not publication ranking.
3. Keep unknown-cost circuit breaker,durable atomic budget,one-image serial
   jobs,cache-first and free-account headroom. Never upgrade to Paid.
4. Compare actual receipts,coverage and sampled photograph accuracy; only
   separately approved growth,with OFF switch. Posting/search/reactions never
   wait for Vision. No autonomous merge or activation.

Official references:
- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://ai.google.dev/gemma/docs/capabilities/vision/image
