# Cloudflare deployment

Production URL: https://wb-finds-miniapp.valeramyakishev000.workers.dev

The existing Python bot/scanner continues on GitHub Actions. This Worker serves
the existing frontend and a compatible API backed by persistent D1. No paid
Workers plan, custom domain, external AI, or payment service is required.

## Runtime

- `DB`: D1 database `wb-finds-miniapp`; initialize with `schema.sql`.
- `ASSETS`: `index.html` at `/index.html`, CSS/JS under `/static/`; route through
  Worker first with `html_handling: none` for consistent security headers.
- `RATE_LIMITER`: namespace 1001, 60 authenticated API calls/minute per user,
  approximate per-location burst protection, not a global billing quota.
- Secret bindings: `MINIAPP_BOT_TOKEN`, `MINIAPP_SYNC_KEY`, `MINIAPP_WEBHOOK_SECRET`.
- Plain bindings: `MINIAPP_BOT_USERNAME`, `MINIAPP_ADMIN_ID`.

Tokens are never committed. `cloudflare_setup.py` is a one-session loopback
handoff holding the deployment token only in RAM; stop it after setup. The token
needs Workers Scripts Edit and D1 Edit for the selected account only, and can
expire/revoke without stopping runtime traffic. Updates later require a new
deployment credential. `cloudflare_deploy.py` is an owner-run bootstrap, not an
automatic workflow: it replaces its own Mini App sync/webhook keys on deployment
and updates the matching GitHub secret and Telegram settings.

The bot menu opens the application. Channel links use `MINIAPP_LINK_MODE=bot`
(`?start=save_ID` / `?start=look_ID`) and the new bot's secret-checked webhook
sends a web_app launch button. This works without configuring a Main Mini App in
BotFather. The `startapp` mode remains available after that optional setup.
The original channel bot's callbacks/webhook are untouched.

GitHub variables: `MINIAPP_API_URL`, `MINIAPP_BOT_USERNAME`, `MINIAPP_LINK_MODE`,
and `MINIAPP_ENABLED=1` only after successful live checks. GitHub secret:
`MINIAPP_SYNC_KEY`. Catalog scanner runs at minute 23 every six hours; posting and
queue scanning also sync products. Scheduled GitHub runs may be delayed.

## Verification / recovery

Run `node --test miniapp/cloudflare/*.test.mjs` with Node 24. These tests use real
SQLite behind a D1-compatible adapter. Run the existing Python tests too.
`python -m miniapp.cloudflare_smoke` checks the live deployment (requires the
owner token file and `MINIAPP_ADMIN_ID`); it creates/deletes only its synthetic
test user's saves, never the owner's data.

D1 Free has automatic Time Travel point-in-time recovery for seven days. This is
not an independent long-term backup. Restore only after owner approval; a restore
can overwrite newer saves. Never place user saves in this repository.

Free plan limits apply: Workers 100,000 requests/day and 10ms CPU/request; D1
5 million rows read/day, 100,000 rows written/day and 500MB per database. Apps may
stop serving on quota exhaustion; do not automatically upgrade billing. Sync
skips unchanged products and uses bounded batches. Inspect usage periodically.
These are provider limits, not availability guarantees.

The outfit engine is category/keyword based, not visual styling or size fitting.
Only recently verified prices are used. Older catalog items may lack photos;
the dedicated scanner gradually adds verified images and category coverage.

## Catalog and outfit refresh (September 2026)

The scheduled scanner reads the current public catalog first, skips photos and
prices checked in the last 24 hours, and rotates three search pages and candidate
windows. Its 11-query plan includes male and female outfit foundations on every
run, plus two rotating categories; groups with fewer fresh photos run first.
Unknown audience labels remain unknown rather than being guessed from a query.
The Mini App explicitly uses a 15,000 RUB per-item cap without changing the
channel's default price filter.

Backfill alternates missing photos with photographed items due for a daily price
refresh, up to 48 candidates per run, balanced by audience and category. Existing
photo URLs are downloaded and checked before trying basket-host discovery again.
Failed price/photo checks never advance freshness, and each verified item is
uploaded immediately. Scan/backfill have bounded work windows; a slow WB request
can still use the underlying request retries before the next deadline check.

Both Python and Worker outfit engines reserve space for affordable candidates
and filter compatibility before truncation. They return up to three distinct
clothing foundations: the main choice, a lower-cost alternative when available
(without optional accessories), and an alternative selected for fewer repeated
pieces. Owned items cost zero; freshness, audience, style and budget gates remain
in force. Labels describe the actual result and never promise visual matching.

Publishing to GitHub updates future catalog jobs. Worker code and UI still need
a separate `python -m miniapp.cloudflare_deploy NONCE update` with the temporary
RAM-only credential handoff. Do not use bootstrap for an existing deployment.
