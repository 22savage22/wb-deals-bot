# Gemma native staging experiment — 2026-10-10

Only `wb-finds-visual-staging`, D1 `5779987d-1100-45ad-8cd4-9df9c1436a20`,
branch `codex/visual-staging-agent-20261010`, existing Draft PR9. No production,
Telegram, Cron, root config, Astra PR8, model activation or merge changes.

## Investigation

The former ignored test bundle replaced Gemma multimodal `messages`, JSON Mode
and disabled thinking with Llama `prompt`/`image`, without constrained JSON output.
Llama is not a successful substitute for the existing structured-profile contract.
The archived REST comparison recorded arrays instead of field objects,
missing confidence/evidence, trailing punctuation, a missing closing brace,
prose and color-only answers. Strict parsing correctly rejected these.

For the latest seven Llama calls, the preserved receipts prove three
`VISUAL_INVALID_JSON`, three `VISUAL_EMPTY_PROFILE`, and one lost HTTP result;
all seven provider costs were known, total283.3623533445001Neurons, zero profiles.
Raw model output was discarded. The precise syntactic defect of EACH of these
seven responses cannot honestly be reconstructed. Empty means fewer than two
accepted fields AFTER confidence/evidence/vocabulary checks, not necessarily an
empty provider response. Service `outcome=success` means metered inference,
NOT a valid profile. The staging catch previously hid runtime errors.

## Changes and safety

Gemma4 `@cf/google/gemma-4-26b-a4b-it` is the original tracked model. Keep its
multimodal image input, JSON Mode,900 completion-token cap and disabled thinking.
Keep strict complete-JSON/schema validation; no brace repair, prose acceptance,
confidence invention or model text used as metering.

The explicitly generated test bundle alone lowers pre-call reserve to200.
Inputs are constrained to one public image and <=4096UTF8 prompt bytes; Google
documents <=1120 visual tokens, plus4096 conservative chat-template allowance.
At9091input/27273output Neurons perM and900output this bounded request estimate
is109.224092, below200. The template allowance is conservative, not a provider
contract. A provider cost above the reserve locks the experiment immediately.
The general production full-context reserve2500 is unchanged.

An independent persistent experiment `gemma-native-20261010-500` caps additional
consumption at500 and at10 distinct image hashes. It never resets at midnight,
init or redeployment. Atomic reservation, pending/unknown-cost hold and hash
uniqueness prevent duplicate inference and unmetered retries. Old daily charges
and failures remain intact. Cache replay bypasses inference and admission.

Safe structural receipts store JSON parse/type/field-count/finish reason only,
no raw answer or credential. Actual D1 metadata is collected; the tiny explicit
staging experiment does not reserve production optional row budget on each run.
First completed requests used39D1queries. Runtime failures now expose safe
subrequest-limit codes rather than a generic hidden exception.

## Actual result, not the previous REST result

First two products:2valid/2,25.263636589050293providerNeurons,2cache hits.
Photos visually confirmed navy solid round-neck tee and turquoise solid polo.

Continued different products: total8calls,7valid profiles,7immediate persistent
cache hits, zero extra AI cache calls. Measured additional total
**104.6454553604126Neurons**. Known staging day ledger includes previous
283.3623533445001 + this104.6454553604126 =388.0078087049127;
other account consumers are unknown.

|nmId|Result|Measured Neurons|
|---|---|---:|
|16001949|cached valid navy tee|12.590909004211426|
|163106569|cached valid turquoise polo|12.672727584838867|
|742502965|cached black sneakers; solid-pattern claim needs caution|14.145454406738281|
|1274857400|cached black sneakers, thick white platform|13.736363410949707|
|1097989569|cached black soft shoulder bag|13.527273178100586|
|812988272|cached brown structured bag; shoulder/crossbody ambiguous|13.390909194946289|
|1023816536|cached rose-gold hoop earrings, visible stones|11.063636779785156|
|1113687154|VISUAL_INVALID_PROFILE; not cached or reinferred|13.518181800842285|
|1138890506|not analysed after stop|0|
|449731422|not analysed after stop|0|

Dress response: parseOK, rootgroupSTRING,9fields with evidence, finish_reasonstop;
therefore this is schema/vocabulary rejection, not malformed/truncated JSON.
The specific rejected value was not retained; do not invent it or rerun this
same image to recover diagnostics. Stop was deliberately stricter than waiting
for repeated model failures. No automatic retry or bulk activation.

Frozen control comparison:27matches/29returned controls;13/42controls absent
(including failed/untested items). Two exact-value disagreements are carry
shoulder vs crossbody and texture smooth vs glossy; these are not mutually
exclusive visual descriptions. Colors7/7match. The sneaker also has visible
logos/stripes, so its whole-item `solid` pattern is overbroad. Styles remain
hypotheses; material/unseen back unknown. This small test is not broad accuracy.

Gemma is a materially better candidate, inexpensive within Free, but **NOT READY
for unattended production activation**: vocabulary rejection, ambiguous carry,
multi-color/pattern scope and incomplete10product gate need review first.

Artifacts `.test-temp/gemma-500-20261010/report.json`, `quality.json`, self-contained
`gallery.html`; ten existing hash-verified public photo files in
`.test-temp/vision-test-20261010/`. `node miniapp/visual_gallery.mjs --serve` opens
http://127.0.0.1:8771/ as rendered HTML, exposing only gallery/pinned public photos,
not OAuth config or the repository. The report clearly distinguishes new native
results from historical references, omitted attributes and untested products.

References:
- https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/
- https://developers.cloudflare.com/workers-ai/platform/pricing/
- https://ai.google.dev/gemma/docs/capabilities/vision/image
- https://developers.cloudflare.com/workers-ai/features/json-mode/
