-- Additive schema only; isolated preview first, production requires explicit approval.
CREATE TABLE IF NOT EXISTS admin_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,scope TEXT NOT NULL,before_data TEXT NOT NULL,after_data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS admin_changes_scope ON admin_changes(scope,id DESC);
CREATE TABLE IF NOT EXISTS admin_search_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,query_id TEXT NOT NULL,query TEXT NOT NULL,origin TEXT NOT NULL,success INTEGER NOT NULL,found INTEGER,new_count INTEGER,passed INTEGER,added INTEGER,error TEXT NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS admin_search_query ON admin_search_runs(query_id,id DESC);
CREATE INDEX IF NOT EXISTS admin_search_time ON admin_search_runs(ts);
CREATE TABLE IF NOT EXISTS admin_health_events(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,service TEXT NOT NULL,state TEXT NOT NULL,code TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS admin_health_bound AFTER INSERT ON admin_health_events BEGIN DELETE FROM admin_health_events WHERE id<(SELECT MAX(id)-199 FROM admin_health_events); END;
CREATE TRIGGER IF NOT EXISTS admin_post_health AFTER UPDATE OF status ON scheduler_config
    WHEN COALESCE(json_extract(OLD.status,'$.last_error'),'')<>COALESCE(json_extract(NEW.status,'$.last_error'),'')
    BEGIN INSERT INTO admin_health_events(ts,service,state,code) VALUES(CAST(strftime('%s','now') AS INTEGER),'publication',
      CASE WHEN COALESCE(json_extract(NEW.status,'$.last_error'),'')='' THEN 'recovered' ELSE 'error' END,
      CASE WHEN COALESCE(json_extract(NEW.status,'$.last_error'),'')='' THEN 'OPERATION_RECOVERED'
      WHEN json_extract(NEW.status,'$.last_error_code') IN ('D1_QUERY_LIMIT','D1_DAILY_LIMIT','D1_SQL_ERROR','WORKER_EXECUTION_LIMIT','TELEGRAM_UNKNOWN','TELEGRAM_SECRET_MISSING','TELEGRAM_REJECTED') THEN json_extract(NEW.status,'$.last_error_code') ELSE 'RUNTIME_UNEXPECTED' END); END;
CREATE TRIGGER IF NOT EXISTS admin_cron_health AFTER UPDATE OF status ON scheduler_config
    WHEN COALESCE(json_extract(OLD.status,'$.watchdog_overdue'),0)<>COALESCE(json_extract(NEW.status,'$.watchdog_overdue'),0)
    BEGIN INSERT INTO admin_health_events(ts,service,state,code) VALUES(CAST(strftime('%s','now') AS INTEGER),'cron',
      CASE WHEN json_extract(NEW.status,'$.watchdog_overdue') THEN 'error' ELSE 'recovered' END,
      CASE WHEN json_extract(NEW.status,'$.watchdog_overdue') THEN 'POST_OVERDUE' ELSE 'OPERATION_RECOVERED' END); END;
