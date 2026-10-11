# Production selection-save guard — 2026-10-11

The approved integration PR11 merged as
`484df3f65bad9eca1b8a32c93f2d88a9e84b810c`. Workers Builds deployed version
`5d9b95bb-ad15-4322-838b-c7a2b83273ab` at 13:57:30 UTC. Existing runtime
bindings, secrets and production D1 were unchanged. Owner confirmed opening
the new admin from WBmarket: 30 minutes, Vision OFF and River SHADOW.

The ordinary scheduler published product277056309, message2837, at
1791727280; an independent Cron tick1791727834 and
production_chain_message_id2837 confirmed the delivery after deployment.
Queue81, no active leases, no new AI requests. These are real D1 receipts,
not synthetic actors or a manually triggered post.

## Unexpected policy change

Post-rollout comparison detected one new `scheduler_policy.selection` key.
The other policy fields, schedule/revision and River configuration were equal
to the verified backup. Audit record1 at1791727330 records selection
inactive→active; audiences women/men/unisex, diversity disabled. Owner stated
that they only opened the admin and did not save selection.

The audit identifies the write, **not its initiating client**. GET-only local
production-clone tests did not reproduce a save. Do not claim that a particular
browser, person or scheduler caused it without request evidence.

The old save API accepted a valid revision/settings payload with no explicit
confirmation or persistent operation ID. Harden that boundary:

- UI save requires dirty settings and an explicit owner confirmation.
- Server requires `confirmed:true` plus a bounded `request_id` after the
  existing verified Telegram signature and owner check.
- Indexed scheduler_actions receipt and the policy CAS make duplicate/concurrent
  requests persistent idempotent. No new schema or Cron query is required.
- Configuration history retains the confirmation and operation ID.
- Selection restoration requires its own owner-confirmed operation.
- Reads, stale/unconfirmed clients and non-owners cannot activate selection.

Roll back only the proven unexpected selection key through an exact policy CAS
or the owner's existing configuration history. Never restore the whole SQL
backup over new posts, queue items or reactions. Do not overwrite unrelated
concurrent user edits. Record the actual restoration result before DONE.

Owner restored the old policy through the existing admin. A read-only check
at 14:33:08 UTC confirmed audit record2 at1791728903, active→inactive, and
all settings byte-equal to the pre-migration baseline. Only17 D1 rows read.
Normal message2838, product1095105951, at1791729132 and subsequent automatic
tick1791729152 confirmed posting continued; queue81 and error empty.
This evidence predates the hardened save deployment, not its final gate.

Both UI history paths now send fresh confirmation and idempotency intent;
a regression test prevents omission of the inline selection restore path.
Local209 Worker tests and admin asset build passed; remote CI and a normal
post + later independent Cron after this guard's deployment remain mandatory.
Automatic Vision stays OFF, River SHADOW, posting30min. PR10 and the third
agent's work remain untouched. Rollback Worker version and additive D1
preservation procedure are in admin-vision-integration-20261011.md.
