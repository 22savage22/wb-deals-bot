-- STAGING ONLY: wb-finds-visual-staging / 5779987d-1100-45ad-8cd4-9df9c1436a20
-- Exported from the existing runtime init phase; live runner applies that phase.
CREATE TABLE IF NOT EXISTS learning_state(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,model TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS learning_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,ts INTEGER NOT NULL,pid INTEGER NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL,features TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS learning_stats(scope TEXT NOT NULL,key TEXT NOT NULL,positive REAL NOT NULL DEFAULT 0,negative REAL NOT NULL DEFAULT 0,events INTEGER NOT NULL DEFAULT 0,last INTEGER NOT NULL,PRIMARY KEY(scope,key));
CREATE INDEX IF NOT EXISTS learning_stats_rank ON learning_stats(scope,events DESC);
CREATE TABLE IF NOT EXISTS learning_feedback(pid INTEGER PRIMARY KEY,likes INTEGER NOT NULL,dislikes INTEGER NOT NULL,bought INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS learning_shadow(pid INTEGER PRIMARY KEY,ts INTEGER NOT NULL,legacy_pid INTEGER NOT NULL,river_pid INTEGER NOT NULL,legacy_p REAL NOT NULL,river_p REAL NOT NULL,features TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS learning_shadow_time ON learning_shadow(ts);
CREATE TRIGGER IF NOT EXISTS learning_event_aggregate AFTER INSERT ON learning_events BEGIN
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('all','all',CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('day',date(NEW.ts,'unixepoch'),CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('category',json_extract(NEW.features,'$.category'),CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
  END;
INSERT OR IGNORE INTO learning_state VALUES(1,'{"mode":"SHADOW","exploration_percent":10}','{"version":1,"cursor":0,"weights":{},"intercept":0,"trained_events":0,"updated_at":0,"comparison":{"n":0,"legacy_brier":0,"river_brier":0,"posts":[],"first_ts":0}}');
UPDATE scheduler_config SET status=json_set(status,'$.learning_initialized',1) WHERE id=1;
