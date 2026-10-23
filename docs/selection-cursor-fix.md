# Fix a stalled publication rotation, independently of PR17 and fashion

Current main passes `policy.total_posts + recent.length` into the twenty-slot
selector. `recent` covers only the last 24 hours; its size is not a monotonic
publication counter. With about 46 daily deliveries and the static 1850 seed,
the target stays at slot 16 (`women`).

Read-only evidence on 24 October 00:02 Moscow: reconstructing the prior 24-hour
count for all 46 observed daily posts yields slot 16 in every case. Male search
topics have zero daily deliveries despite eight men's T-shirts ready. This is
a selector-phase defect, not evidence of an audience's gender preference.

The patch seeds the old phase once, then advances `selection_cursor` only on a
confirmed Telegram success. It uses the existing status JSON and persists the
cursor atomically with the delivery/inventory/product batch. The old success
status update is moved into that batch, so the number of SQL statements does
not increase. The status is re-read after acquiring the posting lease.

Failures, skipped posts and early ticks do not advance the cursor. Preflight
and diagnostics use the same phase. The existing owner gates, claims, interval,
queries, price checks, sender and current selection weights are unchanged.
This fixes rotation, not fashion judgement or subscriber-reaction learning.

Base is exact main `524fbe8931b911e4c3bc4e05de7caf5003b1decc`, without PR17 or
fashion changes. Keep their reviews separate. Local tests include stable-window
history, confirmed success, early ticks, Telegram failure and atomic batch
failure. No deployment is authorized. Roll back code only: the extra JSON key
is harmless to old code; never restore D1 to replay sent goods.
