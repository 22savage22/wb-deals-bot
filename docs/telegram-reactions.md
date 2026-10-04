# Persistent live reaction counters

Root cause: admin._feedback incremented JSON feedback and called smart, but
never editMessageReplyMarkup. _buttons also ignored totals. A 30-minute timestamp
gap was not a persistent per-person selection and could not switch votes.

Main channel bot now has its OWN /telegram/main/webhook (miniapp bot's existing
webhook stays unchanged). The secret is domain-separated HMAC of the existing
Worker sync secret; no new Cloudflare token or repository credential. The first
network operation acknowledges the callback, bounded900ms, BEFORE D1 access.
Vote persistence finishes before HTTP200; D1 failure returns503 so Telegram
redelivers. Markup editing runs separately and has its own optional D1 budget.

Reaction votes are PK(scope,pid,HMAC-voter). UPSERT + database triggers update
totals atomically in D1 batch. Like/dislike replace one another; purchase is
independent. Repeating the same action is a no-op, not toggle. Telegram update_id
prevents stale delivery retries reverting a newer choice. No user name/phone or
raw subscriber ID is persisted. The rate limiter runs before database work.

Per-message persisted dirty state and90s lease serialize edits across isolates.
Only editMessageReplyMarkup is called: photo/caption/link/save/outfit buttons
stay intact. Revision recheck repairs a concurrent newer vote. Ambiguous network
outcome leaves the lease charged until expiry; a bounded otherwise-idle Cron
repairs it. Explicit not-found/forbidden ends retries until another interaction;
429 obeys retry_after. Database votes are never rolled back by Telegram failure.

Legacy aggregate feedback is seeded once from existing JSON, with lazy PK
fallback from D1 learning_feedback. Old JSON records contain timestamps but NOT
each person's old choice. They are retained as an immutable historical baseline,
not fabricated into per-person votes. New selections are exact and idempotent.

Owner private messages/menu callbacks are retained in a PK/ordered D1 inbox;
existing Python command handlers consume up to20 every30seconds with a separate
persistent cursor. Native aggregated feedback also reaches Legacy heuristics;
River events dedupe and their import high-water mark avoids double training.
The public Mini App, production scheduler/settings and original bot token stay.

Cost: PK vote/totals/message lookups and reaction_product/dirty indexes, no scans
of vote history. Only otherwise-idle Cron runs a dirty LIMIT2 query and repairs
one message. No reaction work is added to heavy posting/search executions.
Owner bridge adds2880 bounded requests/day; optional lane protects core posting.
Actual D1_BUDGET metadata, not synthetic test read counts, is production evidence.

Live probe feedback_test creates ONE private owner message, idempotency id
feedback-e2e-20261004-v1. Controlled synthetic actors A/B exist ONLY in its test
scope; never inject subscriber votes or training into channel scope. Each step
is a separate bounded request and verifies real Telegram Message.reply_markup
against D1 totals. This proves real editing/storage, not two humans clicking.
It also repairs the last existing channel message using actual totals, without
creating a new channel post. Real webhook acknowledgement latency requires an
actual Telegram click and is exposed by feedback_check, not fabricated by probes.

Verification results and deployment links are appended after the real probe.
