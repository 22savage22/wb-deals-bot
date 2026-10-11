-- DRAFT ONLY. No auto-migration or production import. Use a separate SHADOW_DB
-- after explicit approval. Prices are comparable only within variant/context.
CREATE TABLE shadow_prices (
  pid INTEGER NOT NULL, variant TEXT NOT NULL, context TEXT NOT NULL,
  day TEXT NOT NULL, observed_at INTEGER NOT NULL, price REAL NOT NULL CHECK(price>0),
  source TEXT NOT NULL, PRIMARY KEY(pid,variant,context,day)
) WITHOUT ROWID;
CREATE TABLE shadow_price_day_budget(day TEXT PRIMARY KEY,observations INTEGER NOT NULL DEFAULT 0 CHECK(observations BETWEEN 0 AND 300)) WITHOUT ROWID;
CREATE TRIGGER shadow_price_budget_before BEFORE INSERT ON shadow_prices
WHEN COALESCE((SELECT observations FROM shadow_price_day_budget WHERE day=NEW.day),0)>=300
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER shadow_price_budget_after AFTER INSERT ON shadow_prices BEGIN
  INSERT INTO shadow_price_day_budget(day,observations) VALUES(NEW.day,1)
  ON CONFLICT(day) DO UPDATE SET observations=observations+1;
END;
CREATE TABLE shadow_candidates (
  pid INTEGER PRIMARY KEY, category TEXT NOT NULL, type TEXT NOT NULL,
  observed_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX shadow_cohort ON shadow_candidates(category,type,observed_at DESC,pid);
CREATE TABLE shadow_taste (
  profile TEXT NOT NULL CHECK(profile IN ('owner','wife')), pid INTEGER NOT NULL,
  action TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(profile,pid)
) WITHOUT ROWID;
CREATE TABLE shadow_audience (pid INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE shadow_comparisons (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX shadow_comparison_time ON shadow_comparisons(at DESC);
-- Retention is a bounded background batch, never every scheduler minute:
-- SELECT pid,variant,context,day FROM shadow_prices
-- WHERE pid=? AND variant=? AND context=? AND day<? LIMIT 28;
