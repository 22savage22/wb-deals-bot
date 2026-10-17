-- Explicit isolated price-store migration only. Never run on production DB.
CREATE TABLE IF NOT EXISTS price_watch (
  pid INTEGER PRIMARY KEY CHECK(pid>0 AND pid<1000000000000),
  source TEXT NOT NULL,
  metadata TEXT NOT NULL CHECK(json_valid(metadata)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  tracked_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  current_valid INTEGER NOT NULL DEFAULT 0 CHECK(current_valid IN (0,1)),
  current_code TEXT NOT NULL DEFAULT 'NEVER_CHECKED',
  latest TEXT,
  latest_observed_at INTEGER NOT NULL DEFAULT 0,
  last_good TEXT,
  last_good_observed_at INTEGER NOT NULL DEFAULT 0,
  invalidated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS price_watch_due ON price_watch(active,due_at,pid);
CREATE INDEX IF NOT EXISTS price_watch_source ON price_watch(source,pid);
CREATE TRIGGER IF NOT EXISTS price_watch_insert_cap BEFORE INSERT ON price_watch
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM price_watch WHERE pid=NEW.pid)
  AND (SELECT count(*) FROM price_watch WHERE active=1)>=100
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER IF NOT EXISTS price_watch_reactivate_cap BEFORE UPDATE OF active ON price_watch
WHEN OLD.active=0 AND NEW.active=1 AND (SELECT count(*) FROM price_watch WHERE active=1)>=100
BEGIN SELECT RAISE(IGNORE); END;
CREATE TABLE IF NOT EXISTS price_observations (
  pid INTEGER NOT NULL REFERENCES price_watch(pid),
  variant TEXT NOT NULL,
  context TEXT NOT NULL,
  day TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  price REAL NOT NULL CHECK(price>0),
  source TEXT NOT NULL,
  PRIMARY KEY(pid,variant,context,day)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS price_observations_time ON price_observations(observed_at,pid,variant,context,day);
CREATE TABLE IF NOT EXISTS price_store_stats(id INTEGER PRIMARY KEY CHECK(id=1),history_rows INTEGER NOT NULL CHECK(history_rows BETWEEN 0 AND 9000));
INSERT OR IGNORE INTO price_store_stats(id,history_rows) SELECT 1,count(*) FROM price_observations;
CREATE TRIGGER IF NOT EXISTS price_observations_cap BEFORE INSERT ON price_observations
WHEN NOT EXISTS(SELECT 1 FROM price_observations WHERE pid=NEW.pid AND variant=NEW.variant AND context=NEW.context AND day=NEW.day)
  AND (SELECT history_rows FROM price_store_stats WHERE id=1)>=9000
BEGIN
  DELETE FROM price_observations WHERE (pid,variant,context,day) IN
    (SELECT pid,variant,context,day FROM price_observations ORDER BY observed_at,pid,variant,context,day LIMIT 1);
END;
CREATE TRIGGER IF NOT EXISTS price_observations_insert AFTER INSERT ON price_observations
BEGIN UPDATE price_store_stats SET history_rows=history_rows+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS price_observations_delete AFTER DELETE ON price_observations
BEGIN UPDATE price_store_stats SET history_rows=history_rows-1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS price_sources (
  source TEXT PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  min_gap_ms INTEGER NOT NULL DEFAULT 1200000,
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  failures INTEGER NOT NULL DEFAULT 0,
  last_status INTEGER,
  last_code TEXT NOT NULL DEFAULT '',
  reset_at INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS price_request_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 40)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS price_source_days(source TEXT NOT NULL,day TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 40),PRIMARY KEY(source,day)) WITHOUT ROWID;
