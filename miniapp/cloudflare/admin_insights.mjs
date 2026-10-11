// Indexed summaries for the owner UI; no per-view history scans.
const q=(e,s,...v)=>e.DB.prepare(s).bind(...v);
const buckets=p=>`CASE WHEN COALESCE(json_extract(${p}features,'$.price'),0)<=0 THEN 'нет данных' WHEN json_extract(${p}features,'$.price')<${Math.log1p(500)/12} THEN 'до 500 ₽' WHEN json_extract(${p}features,'$.price')<${Math.log1p(1500)/12} THEN '500–1500 ₽' WHEN json_extract(${p}features,'$.price')<${Math.log1p(3000)/12} THEN '1500–3000 ₽' ELSE 'от 3000 ₽' END`;
const scopes=p=>`json_array(json_object('s','all','k','all'),json_object('s','day','k',date(${p}ts,'unixepoch','+3 hours')),json_object('s','category','k',COALESCE(json_extract(${p}features,'$.category'),'другое')),json_object('s','price','k',${buckets(p)}),json_object('s','hour','k',CASE WHEN NOT EXISTS(SELECT 1 FROM learning_shadow s WHERE s.pid=${p}pid AND s.ts<=${p}ts) THEN 'нет данных' WHEN json_extract(${p}features,'$.hour') BETWEEN 6 AND 11 THEN 'утро' WHEN json_extract(${p}features,'$.hour') BETWEEN 12 AND 17 THEN 'день' WHEN json_extract(${p}features,'$.hour') BETWEEN 18 AND 22 THEN 'вечер' ELSE 'ночь' END))`;
const aggregate="ON CONFLICT(scope,key,kind) DO UPDATE SET weight=weight+excluded.weight,events=events+excluded.events,last=MAX(last,excluded.last)";
async function summaries(e){
  if(!await q(e,"SELECT value FROM metadata WHERE key='admin_insights_v1'").first()){
    await e.DB.batch([
      q(e,'CREATE TABLE IF NOT EXISTS admin_event_stats(scope TEXT NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL,events INTEGER NOT NULL,last INTEGER NOT NULL,PRIMARY KEY(scope,key,kind))'),
      q(e,'CREATE INDEX IF NOT EXISTS admin_event_rank ON admin_event_stats(scope,weight DESC,key,kind)'),
      q(e,`CREATE TRIGGER IF NOT EXISTS admin_event_summary AFTER INSERT ON learning_events BEGIN
        INSERT INTO admin_event_stats SELECT json_extract(value,'$.s'),json_extract(value,'$.k'),NEW.kind,NEW.weight,1,NEW.ts FROM json_each(${scopes('NEW.')}) WHERE true ${aggregate}; END`),
      q(e,"INSERT OR IGNORE INTO metadata(key,value) SELECT 'admin_insights_backfill',json_object('cursor',0,'end',COALESCE(MAX(id),0)) FROM learning_events"),
      q(e,"INSERT OR IGNORE INTO metadata VALUES('admin_insights_v1','1')")
    ]);
  }
  const progress=JSON.parse((await q(e,"SELECT value FROM metadata WHERE key='admin_insights_backfill'").first()).value);
  if(progress.cursor<progress.end){
    // Bounded historical import; the CAS and batch prevent double counting.
    const end=await q(e,'SELECT MAX(id) AS id FROM (SELECT id FROM learning_events WHERE id>? AND id<=? ORDER BY id LIMIT 100)',progress.cursor,progress.end).first();
    const cutoff=end.id||progress.end,next=JSON.stringify({...progress,cursor:cutoff});
    await e.DB.batch([
      q(e,`INSERT INTO admin_event_stats SELECT json_extract(j.value,'$.s'),json_extract(j.value,'$.k'),e.kind,SUM(e.weight),COUNT(*),MAX(e.ts)
        FROM learning_events e JOIN json_each(${scopes('e.')}) j WHERE e.id>? AND e.id<=?
        AND (SELECT value FROM metadata WHERE key='admin_insights_backfill')=? GROUP BY 1,2,3 ${aggregate}`,progress.cursor,cutoff,JSON.stringify(progress)),
      q(e,"UPDATE metadata SET value=? WHERE key='admin_insights_backfill' AND value=?",next,JSON.stringify(progress))
    ]);progress.cursor=cutoff;
  }
  let votes=null;
  if(await q(e,"SELECT value FROM metadata WHERE key='reactions_schema'").first()){
    if(!await q(e,"SELECT value FROM metadata WHERE key='admin_reaction_summary_v1'").first()){
      // One snapshot of per-product totals, then O(1) transaction delta triggers.
      await e.DB.batch([
        q(e,'CREATE TABLE IF NOT EXISTS admin_reaction_summary(id INTEGER PRIMARY KEY CHECK(id=1),likes INTEGER NOT NULL,dislikes INTEGER NOT NULL,bought INTEGER NOT NULL)'),
        q(e,"INSERT OR IGNORE INTO admin_reaction_summary SELECT 1,COALESCE(SUM(likes),0),COALESCE(SUM(dislikes),0),COALESCE(SUM(bought),0) FROM reaction_totals WHERE scope='channel'"),
        q(e,"CREATE TRIGGER IF NOT EXISTS admin_reaction_insert AFTER INSERT ON reaction_totals WHEN NEW.scope='channel' BEGIN UPDATE admin_reaction_summary SET likes=likes+NEW.likes,dislikes=dislikes+NEW.dislikes,bought=bought+NEW.bought WHERE id=1; END"),
        q(e,"CREATE TRIGGER IF NOT EXISTS admin_reaction_update AFTER UPDATE ON reaction_totals WHEN NEW.scope='channel' BEGIN UPDATE admin_reaction_summary SET likes=likes+NEW.likes-OLD.likes,dislikes=dislikes+NEW.dislikes-OLD.dislikes,bought=bought+NEW.bought-OLD.bought WHERE id=1; END"),
        q(e,"CREATE TRIGGER IF NOT EXISTS admin_reaction_delete AFTER DELETE ON reaction_totals WHEN OLD.scope='channel' BEGIN UPDATE admin_reaction_summary SET likes=likes-OLD.likes,dislikes=dislikes-OLD.dislikes,bought=bought-OLD.bought WHERE id=1; END"),
        q(e,"INSERT OR IGNORE INTO metadata VALUES('admin_reaction_summary_v1','1')")
      ]);
    }votes=await q(e,'SELECT likes,dislikes,bought FROM admin_reaction_summary WHERE id=1').first();
  }
  return {complete:progress.cursor>=progress.end,votes};
}
export async function adminInsights(e){
  const summary=await summaries(e),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const signals=(await q(e,"SELECT kind,weight,events,last FROM admin_event_stats WHERE scope='all' AND key='all' LIMIT 5").all()).results;
  const today=(await q(e,"SELECT kind,weight FROM admin_event_stats WHERE scope='day' AND key=? LIMIT 5",day).all()).results;
  const rows=(await q(e,`SELECT scope,key,kind,weight,events FROM admin_event_stats WHERE scope='category' AND key IN (SELECT key FROM learning_stats WHERE scope='category' ORDER BY events DESC LIMIT 20)
    UNION ALL SELECT scope,key,kind,weight,events FROM admin_event_stats WHERE scope='price'
    UNION ALL SELECT scope,key,kind,weight,events FROM admin_event_stats WHERE scope='hour' LIMIT 150`).all()).results;
  const groups=new Map();for(const r of rows){const key=r.scope+':'+r.key,g=groups.get(key)||{scope:r.scope,key:r.key,positive:0,negative:0,observations:0};if(['like','buy','dislike'].includes(r.kind))g.observations+=r.events;if(['like','buy'].includes(r.kind))g.positive+=r.weight;if(r.kind==='dislike')g.negative+=r.weight;groups.set(key,g);}
  const observations=[...groups.values()].filter(x=>x.key!=='нет данных'&&x.observations>=10&&x.positive+x.negative>0).map(x=>({...x,samples:x.observations,rate:x.positive/(x.positive+x.negative)}));
  return {current_votes:summary.votes,backfill_complete:summary.complete,signals,today_reactions:today.filter(x=>['like','dislike','buy'].includes(x.kind)).reduce((n,x)=>n+x.weight,0),today_timezone:'Europe/Moscow',insights:summary.complete?observations.sort((a,b)=>b.samples-a.samples).slice(0,12):[],insight_note:'Наблюдения по реакциям, не доказанная конверсия. Переходы/сохранения не считаем лайками. Смена голоса — новый сигнал, но не второй текущий голос.'};
}
export const maintainAdminSummaries=summaries;

