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
