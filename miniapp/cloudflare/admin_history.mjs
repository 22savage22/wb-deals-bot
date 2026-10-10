// Owner configuration history only. Never store channel IDs or credentials.
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a);
export const CONTROL_SCHEMA=[
  'CREATE TABLE IF NOT EXISTS admin_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,scope TEXT NOT NULL,before_data TEXT NOT NULL,after_data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS admin_changes_scope ON admin_changes(scope,id DESC)',
  'CREATE TABLE IF NOT EXISTS admin_search_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,ts INTEGER NOT NULL,query_id TEXT NOT NULL,query TEXT NOT NULL,origin TEXT NOT NULL,success INTEGER NOT NULL,found INTEGER,new_count INTEGER,passed INTEGER,added INTEGER,error TEXT NOT NULL,data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS admin_search_query ON admin_search_runs(query_id,id DESC)',
  'CREATE INDEX IF NOT EXISTS admin_search_time ON admin_search_runs(ts)'
];
export async function ensureControl(e){await e.DB.batch(CONTROL_SCHEMA.map(s=>q(e,s)));}
export async function optionalRows(e,sql,...args){try{return (await q(e,sql,...args).all()).results;}catch(error){if(/no such table.*admin_(?:changes|search_runs)/i.test(error.message))return null;throw error;}}
export function auditStatement(e,scope,before,after){return q(e,"INSERT INTO admin_changes(ts,scope,before_data,after_data) SELECT ?,?,?,? WHERE changes()>0",Math.floor(Date.now()/1000),scope,JSON.stringify(before),JSON.stringify(after));}
export async function pruneChanges(e){await q(e,'DELETE FROM admin_changes WHERE id<(SELECT COALESCE(MAX(id),0)-99 FROM admin_changes)').run();}
export async function changes(e,cursor=0){return await optionalRows(e,'SELECT id,ts,scope,before_data,after_data FROM admin_changes WHERE (?=0 OR id<?) ORDER BY id DESC LIMIT 20',cursor,cursor)||[];}
export async function recordDiscovery(e,r){
  const n=x=>Number.isInteger(x)&&x>=0?x:null;
  await q(e,'INSERT INTO admin_search_runs(ts,query_id,query,origin,success,found,new_count,passed,added,error,data) VALUES(?,?,?,?,?,?,?,?,?,?,?)',r.at,r.query_id||'existing:'+r.query,r.query,r.test?'manual_test':r.experiment?'algorithm':r.origin||'cron',r.error?0:1,n(r.found),n(r.new_found),n(r.valid),n(r.added),r.error||'',JSON.stringify(r)).run();
  await q(e,'DELETE FROM admin_search_runs WHERE id<(SELECT COALESCE(MAX(id),0)-499 FROM admin_search_runs)').run();
}
