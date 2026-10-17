-- Additive; apply ONLY after an approved rollout and a fresh verified backup.
-- No migration in Cron/webhook. Existing PKs serve all card/profile joins.
CREATE INDEX IF NOT EXISTS reaction_votes_quality_recent ON reaction_votes(scope,last_event DESC);
CREATE INDEX IF NOT EXISTS scheduler_inventory_quality ON scheduler_inventory(state,queued_at,pid);
