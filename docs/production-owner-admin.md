# WBmarket owner commands and Admin Mini App

The main bot handles `/help`, `/status`, `/admin` directly in
`/telegram/main/webhook`, before the legacy owner-update queue. Only a private
message whose sender and chat both match `MINIAPP_ADMIN_ID` can reach this path.
Telegram's webhook secret remains mandatory. Channel reaction handling is unchanged.

`/status` reads one scheduler config row, its counter and the indexed latest post.
No WB call, inventory scan, schedule write, manual tick, or Telegram post occurs.
Replies use `TG_BOT_TOKEN`; three persistent metadata watermarks retain command
receipts and suppress duplicate Telegram redelivery. An ambiguous send is not
automatically repeated. The owner can send a fresh command to retry.

Admin API authentication accepts only initData signed by `TG_BOT_TOKEN`, then
checks `MINIAPP_ADMIN_ID`. Public user APIs still use `MINIAPP_BOT_TOKEN`.
Public-bot owner signatures cannot access admin endpoints. The `/admin` HTML is
only a loading shell: Telegram supplies initData client-side after navigation;
the server verifies it before returning any settings or accepting an operation.
An unauthorized visitor sees an access error and receives no administration data.
No raw initData, credentials or subscriber identifiers are recorded in receipts.

`owner_setup` in the existing native-runtime workflow sets a web_app menu button
and a chat-scoped command list only for the owner's chat with the main bot. It
does not send a message or change webhook/scheduler settings. `owner_check` reads
the webhook status and bounded command/open receipts. Use these existing Actions
secrets; never create new API tokens or restore polling.

Baseline read-only run 37321922832: 30-minute interval, revision 1791202121046,
Cron active, last Telegram post 2557, queue 38, last successful WB search 1791208045.
Local checks: separate bot-token signatures, forged/non-owner denial before D1,
direct webhook responses, duplicate/timeout protection, owner-scoped menu, and
unchanged scheduler configuration. 126 Worker tests passed; asset build passed.

Production acceptance on 2026-10-05: the owner confirmed all three replies and
personally opened the Admin Mini App from WBmarket showing 30 minutes.
Worker build for commit da593264 succeeded; runtime
`96c7b143-53d9-40b3-9dc2-8bb9bf957471`. Owner setup run 37323786401 verified
`@WBmarket22_bot`, the chat-scoped menu, commands and existing main webhook.
Read-only receipt run 37324406444 confirmed:

| Command | Real Telegram update_id | Reply message_id | Handler latency |
| --- | ---: | ---: | ---: |
| /help | 810945046 | 2275 | 265 ms |
| /status | 810945047 | 2277 | 164 ms |
| /admin | 810945048 | 2279 | 117 ms |

Authenticated admin open: at=1791210143, bot=main, owner_verified=true.
Webhook pending updates=0, last_error empty. Production unsigned admin request
returns 401; separate valid non-owner and public-bot signatures are denied in
the automated authorization tests. No synthetic production commands or votes
were used as acceptance evidence.

Post-deployment diagnostic run 37324141205: interval=30, the unchanged revision
1791202121046, enabled=true, paused=false, Cron active, automatic tick=1791210136,
last post=2557, search_success=1791210019 (after deployment), search_retry_at=0,
last_scan_error empty, queue=38. No manual publication was requested.
Read-only feedback run 37324579396 also confirmed the existing real callback on
channel message 2557: acknowledgement 23 ms, dirty=0, error empty, receipt present,
webhook pending updates=0. No test reactions were sent.

Official references:
- https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
- https://core.telegram.org/bots/api#setchatmenubutton
