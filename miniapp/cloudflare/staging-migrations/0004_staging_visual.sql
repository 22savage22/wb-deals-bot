-- STAGING ONLY: wb-finds-visual-staging / 5779987d-1100-45ad-8cd4-9df9c1436a20
-- Exported from the existing runtime init phase; live runner applies that phase.
CREATE TABLE IF NOT EXISTS visual_queue(pid INTEGER PRIMARY KEY,state TEXT NOT NULL DEFAULT 'pending',retry_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,queued_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS visual_queue_due ON visual_queue(state,retry_at,queued_at,pid);
CREATE TABLE IF NOT EXISTS visual_profiles(pid INTEGER PRIMARY KEY,version INTEGER NOT NULL,analyzed_at INTEGER NOT NULL,profile TEXT NOT NULL,feedback_cursor INTEGER NOT NULL DEFAULT 0,backfill_pending INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS visual_profiles_time ON visual_profiles(analyzed_at DESC);
CREATE INDEX IF NOT EXISTS visual_profiles_backfill ON visual_profiles(backfill_pending,pid);
CREATE TABLE IF NOT EXISTS visual_images(pid INTEGER NOT NULL,image_index INTEGER NOT NULL,url TEXT NOT NULL,hash TEXT NOT NULL,analysis TEXT NOT NULL,PRIMARY KEY(pid,image_index));
CREATE TABLE IF NOT EXISTS visual_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 0,last_run INTEGER NOT NULL DEFAULT 0,last_success INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',lease TEXT,expires INTEGER NOT NULL DEFAULT 0,event_cursor INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO visual_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS visual_usage(day TEXT PRIMARY KEY,calls INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS visual_events(event_id INTEGER PRIMARY KEY,pid INTEGER NOT NULL,ts INTEGER NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL,keys TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visual_stats(key TEXT PRIMARY KEY,likes REAL NOT NULL DEFAULT 0,dislikes REAL NOT NULL DEFAULT 0,bought REAL NOT NULL DEFAULT 0,saves REAL NOT NULL DEFAULT 0,clicks REAL NOT NULL DEFAULT 0,observations INTEGER NOT NULL DEFAULT 0,products INTEGER NOT NULL DEFAULT 0,last INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS visual_stats_rank ON visual_stats(observations DESC);
CREATE TABLE IF NOT EXISTS visual_memberships(key TEXT NOT NULL,pid INTEGER NOT NULL,PRIMARY KEY(key,pid));
CREATE INDEX IF NOT EXISTS learning_events_pid_id ON learning_events(pid,id);
CREATE TRIGGER IF NOT EXISTS visual_new_product AFTER INSERT ON scheduler_inventory WHEN NEW.state='ready' BEGIN INSERT OR IGNORE INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at); END;
CREATE TRIGGER IF NOT EXISTS visual_member_count AFTER INSERT ON visual_memberships BEGIN UPDATE visual_stats SET products=products+1 WHERE key=NEW.key; END;
CREATE TRIGGER IF NOT EXISTS visual_aggregate AFTER INSERT ON visual_events BEGIN
      INSERT INTO visual_stats(key,likes,dislikes,bought,saves,clicks,observations,last)
        SELECT value,CASE WHEN NEW.kind='like' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='buy' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='save' THEN NEW.weight ELSE 0 END,CASE WHEN NEW.kind='click' THEN NEW.weight ELSE 0 END,1,NEW.ts FROM json_each(NEW.keys) WHERE value NOT LIKE 'visual.group=%'
        ON CONFLICT(key) DO UPDATE SET likes=likes+excluded.likes,dislikes=dislikes+excluded.dislikes,bought=bought+excluded.bought,saves=saves+excluded.saves,clicks=clicks+excluded.clicks,observations=observations+1,last=MAX(last,excluded.last);
      INSERT OR IGNORE INTO visual_memberships SELECT value,NEW.pid FROM json_each(NEW.keys) WHERE value NOT LIKE 'visual.group=%' AND NEW.kind IN ('like','dislike'); END;
INSERT OR IGNORE INTO visual_queue(pid,queued_at) SELECT pid,queued_at FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at DESC LIMIT 100;
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v1','1');
CREATE INDEX IF NOT EXISTS visual_queue_latest ON visual_queue(state,retry_at,queued_at DESC,pid);
CREATE TRIGGER IF NOT EXISTS visual_photo_repaired AFTER UPDATE OF data ON scheduler_inventory WHEN COALESCE(json_extract(NEW.data,'$.image'),'')<>'' AND NOT EXISTS(SELECT 1 FROM visual_profiles WHERE pid=NEW.pid) BEGIN INSERT INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at) ON CONFLICT(pid) DO UPDATE SET state='pending',retry_at=0,error='' WHERE visual_queue.error='VISUAL_NO_IMAGE'; END;
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v2','1');
CREATE TABLE IF NOT EXISTS visual_inference_usage(id TEXT PRIMARY KEY,ts INTEGER NOT NULL,day TEXT NOT NULL,pid INTEGER NOT NULL,image_index INTEGER NOT NULL,kind TEXT NOT NULL,outcome TEXT NOT NULL,usage TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS visual_inference_day ON visual_inference_usage(day,ts DESC);
CREATE INDEX IF NOT EXISTS visual_inference_pid ON visual_inference_usage(pid,ts DESC);
CREATE INDEX IF NOT EXISTS visual_inference_pending ON visual_inference_usage(day,outcome,ts);
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v3','1');
CREATE TABLE IF NOT EXISTS visual_neuron_budget(day TEXT PRIMARY KEY,charged REAL NOT NULL);
CREATE TABLE IF NOT EXISTS visual_budget_holds(day TEXT PRIMARY KEY,reason TEXT NOT NULL,request_id TEXT NOT NULL,ts INTEGER NOT NULL);
INSERT OR IGNORE INTO visual_budget_holds SELECT day,'historical_cost_unknown',id,ts FROM visual_inference_usage WHERE day='2026-10-10' AND json_extract(usage,'$.provider_neurons') IS NULL ORDER BY ts LIMIT 1;
CREATE TABLE IF NOT EXISTS visual_daily_products(day TEXT NOT NULL,pid INTEGER NOT NULL,PRIMARY KEY(day,pid));
CREATE INDEX IF NOT EXISTS visual_images_hash ON visual_images(hash);
INSERT OR IGNORE INTO visual_daily_products SELECT DISTINCT day,pid FROM visual_inference_usage WHERE pid>0 AND kind='vision';
INSERT OR IGNORE INTO visual_neuron_budget SELECT day,SUM(COALESCE(json_extract(usage,'$.provider_neurons'),2500)) FROM visual_inference_usage GROUP BY day;
CREATE TABLE IF NOT EXISTS visual_format_failures(pid INTEGER NOT NULL,image_index INTEGER NOT NULL,hash TEXT NOT NULL,model TEXT NOT NULL,version INTEGER NOT NULL,failures INTEGER NOT NULL,PRIMARY KEY(pid,image_index,hash,model,version));
CREATE TRIGGER IF NOT EXISTS visual_image_changed AFTER UPDATE OF data ON scheduler_inventory WHEN COALESCE(json_extract(NEW.data,'$.image'),'')<>COALESCE(json_extract(OLD.data,'$.image'),'') OR COALESCE(json_extract(NEW.data,'$.image_version'),'')<>COALESCE(json_extract(OLD.data,'$.image_version'),'') OR COALESCE(json_extract(NEW.data,'$.image_updated_at'),'')<>COALESCE(json_extract(OLD.data,'$.image_updated_at'),'') OR COALESCE(json_extract(NEW.data,'$.images'),'')<>COALESCE(json_extract(OLD.data,'$.images'),'') OR COALESCE(json_extract(NEW.data,'$.photos'),'')<>COALESCE(json_extract(OLD.data,'$.photos'),'') BEGIN INSERT INTO visual_queue(pid,queued_at) VALUES(NEW.pid,NEW.queued_at) ON CONFLICT(pid) DO UPDATE SET state='pending',retry_at=0,attempts=0,error=''; END;
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v4','1');
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v5','1');
INSERT OR IGNORE INTO metadata VALUES('visual_schema_v6','1');
