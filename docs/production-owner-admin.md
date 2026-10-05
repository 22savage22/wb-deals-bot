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

Production acceptance is pending until the owner sends the three commands and
personally opens the button in WBmarket. Do not treat fixture tests or a public
HTTP health response as this acceptance.

Official references:
- https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
- https://core.telegram.org/bots/api#setchatmenubutton
