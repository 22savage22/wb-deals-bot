// River trains in Python; the edge only evaluates its bounded, data-only weights.
// No pickle, credentials or Telegram user identities enter the learning store.
import {adminInsights,maintainAdminSummaries} from './admin_insights.mjs';
const q=(e,s,...a)=>e.DB.prepare(s).bind(...a),now=()=>Math.floor(Date.now()/1000);
export const LEARNING_DEFAULT={mode:'SHADOW',exploration_percent:10};
const schema=[
  'CREATE TABLE IF NOT EXISTS learning_state(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,model TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS learning_events(id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,ts INTEGER NOT NULL,pid INTEGER NOT NULL,kind TEXT NOT NULL,weight REAL NOT NULL,features TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS learning_stats(scope TEXT NOT NULL,key TEXT NOT NULL,positive REAL NOT NULL DEFAULT 0,negative REAL NOT NULL DEFAULT 0,events INTEGER NOT NULL DEFAULT 0,last INTEGER NOT NULL,PRIMARY KEY(scope,key))',
  'CREATE INDEX IF NOT EXISTS learning_stats_rank ON learning_stats(scope,events DESC)',
  'CREATE TABLE IF NOT EXISTS learning_feedback(pid INTEGER PRIMARY KEY,likes INTEGER NOT NULL,dislikes INTEGER NOT NULL,bought INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS learning_shadow(pid INTEGER PRIMARY KEY,ts INTEGER NOT NULL,legacy_pid INTEGER NOT NULL,river_pid INTEGER NOT NULL,legacy_p REAL NOT NULL,river_p REAL NOT NULL,features TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS learning_shadow_time ON learning_shadow(ts)',
  `CREATE TRIGGER IF NOT EXISTS learning_event_aggregate AFTER INSERT ON learning_events BEGIN
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('all','all',CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('day',date(NEW.ts,'unixepoch'),CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
    INSERT INTO learning_stats(scope,key,positive,negative,events,last) VALUES('category',json_extract(NEW.features,'$.category'),CASE WHEN NEW.kind='dislike' THEN 0 ELSE NEW.weight END,CASE WHEN NEW.kind='dislike' THEN NEW.weight ELSE 0 END,1,NEW.ts)
      ON CONFLICT(scope,key) DO UPDATE SET positive=positive+excluded.positive,negative=negative+excluded.negative,events=events+1,last=MAX(last,NEW.ts);
  END`
];
export async function ensureLearning(e){
  const row=await q(e,"SELECT config FROM learning_state WHERE id=1").first().catch(error=>{if(!/no such table.*learning_state/.test(error.message))throw error;return null;});
  if(row)return;
  await e.DB.batch(schema.map(s=>q(e,s)));
  await q(e,'INSERT OR IGNORE INTO learning_state VALUES(1,?,?)',JSON.stringify(LEARNING_DEFAULT),JSON.stringify({version:1,cursor:0,weights:{},intercept:0,trained_events:0,updated_at:0,comparison:{n:0,legacy_brier:0,river_brier:0,posts:[],first_ts:0}})).run();
  await q(e,`UPDATE scheduler_config SET status=json_set(status,'$.learning_initialized',1) WHERE id=1`).run();
}
const clocks=new Map();
export function features(p,ts=now(),prior=.5,zone='Europe/Moscow'){
  const text=[p.title,p.category,p.query].join(' ').toLowerCase();
  if(!clocks.has(zone))clocks.set(zone,new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',hour:'2-digit',hourCycle:'h23'}));
  const wall=Object.fromEntries(clocks.get(zone).formatToParts(new Date(ts*1000)).map(p=>[p.type,p.value]));
  return {category:String(p.category||p.cat||p.query||'другое').slice(0,100),query:String(p.query||'').slice(0,100),brand:String(p.brand||'').slice(0,80),price:Math.log1p(Math.max(0,Number(p.product||p.price||0)))/12,discount:Number(p.discount||0)/100,rating:Number(p.rating||0)/5,reviews:Math.log1p(Math.max(0,Number(p.feedbacks||0)))/12,audience:p.audience||(/женск/.test(text)?'women':/мужск/.test(text)?'men':'neutral'),type:String(p.slot||p.category||'other').slice(0,60),hour:Number(wall.hour),weekday:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].indexOf(wall.weekday),feedback_rate:prior};
}
export function vector(f){const x={};for(const [k,v] of Object.entries(f))x[typeof v==='number'?k:k+'='+v]=typeof v==='number'?v:1;return x;}
export function predict(model,f){let z=Number(model.intercept||0);for(const [k,v] of Object.entries(vector(f)))z+=(model.weights?.[k]||0)*v;return 1/(1+Math.exp(-Math.max(-35,Math.min(35,z))));}
export async function shadowChoice(e,rows,legacy,ts=now(),zone='Europe/Moscow'){
  // A missing/disabled learning store must never run migrations in a posting tick.
  const state=await q(e,'SELECT * FROM learning_state WHERE id=1').first().catch(error=>{if(!/no such table.*learning_state/.test(error.message))throw error;return null;});
  if(!state||JSON.parse(state.config).mode!=='SHADOW')return;
  const model=JSON.parse(state.model);
  const stats=(await q(e,"SELECT key,positive,negative FROM learning_stats WHERE scope='category' ORDER BY events DESC LIMIT 200").all()).results;
  const priors=new Map(stats.map(s=>[s.key,(s.positive+1)/(s.positive+s.negative+2)]));
  const prior=p=>priors.get(String(p.category||p.cat||p.query||'другое'))??.5;
  const candidates=rows.slice(0,300).map(r=>({row:r,p:JSON.parse(r.data)}));
  const actual=JSON.parse(legacy.data),f=features(actual,ts,prior(actual),zone);
  // SHADOW NEVER changes the selected product, diversity or publication gates.
  const best=candidates.map(c=>({...c,score:predict(model,features(c.p,ts,prior(c.p),zone))})).sort((a,b)=>b.score-a.score)[0];
  await q(e,'INSERT OR REPLACE INTO learning_shadow VALUES(?,?,?,?,?,?,?)',legacy.pid,ts,legacy.pid,best?.row.pid||legacy.pid,prior(actual),predict(model,f),JSON.stringify(f)).run();
}
export async function recordEvent(e,{key,pid,kind,ts=now(),weight=1}){
  await ensureLearning(e);
  if(!['like','dislike','buy','save','click'].includes(kind)||!Number.isSafeInteger(pid)||pid<=0||typeof key!=='string'||key.length>180||!Number.isFinite(weight)||weight<=0||weight>1000)throw new Error('Invalid learning event');
  const shadow=await q(e,'SELECT features FROM learning_shadow WHERE pid=?',pid).first();
  let f=shadow?JSON.parse(shadow.features):null;
  if(!f){const row=await q(e,'SELECT data FROM scheduler_inventory WHERE pid=?',pid).first()||await q(e,'SELECT data FROM products WHERE id=?',pid).first();if(!row)return {ignored:true};f=features(JSON.parse(row.data),ts);}
  const r=await q(e,'INSERT OR IGNORE INTO learning_events(event_key,ts,pid,kind,weight,features) VALUES(?,?,?,?,?,?)',key,ts,pid,kind,weight,JSON.stringify(f)).run();return {added:!!r.meta.changes};
}
export async function importFeedback(e,rows){
  await ensureLearning(e);
  const clean=rows.filter(p=>Number.isSafeInteger(p.pid)&&p.pid>0),ids=JSON.stringify(clean.map(p=>p.pid));
  const old=new Map((await q(e,'SELECT * FROM learning_feedback WHERE pid IN (SELECT value FROM json_each(?))',ids).all()).results.map(p=>[p.pid,p]));
  const shadows=new Map((await q(e,'SELECT pid,features FROM learning_shadow WHERE pid IN (SELECT value FROM json_each(?))',ids).all()).results.map(p=>[p.pid,JSON.parse(p.features)]));
  const cards=new Map((await q(e,'SELECT pid,data FROM scheduler_inventory WHERE pid IN (SELECT value FROM json_each(?))',ids).all()).results.map(p=>[p.pid,JSON.parse(p.data)]));
  for(const p of (await q(e,'SELECT id,data FROM products WHERE id IN (SELECT value FROM json_each(?))',ids).all()).results)if(!cards.has(p.id))cards.set(p.id,JSON.parse(p.data));
  const events=[],updates=[];
  for(const p of clean){
    const before=old.get(p.pid)||{likes:0,dislikes:0,bought:0},f=shadows.get(p.pid)||(cards.has(p.pid)?features(cards.get(p.pid)):null);
    if(!f)continue; // Don't acknowledge a counter until its real card is known.
    const values={pid:p.pid};for(const k of ['likes','dislikes','bought']){
      values[k]=Math.max(before[k],Math.min(100000,Math.floor(Number(p[k])||0)));const delta=values[k]-before[k];
      if(delta>0)events.push({key:`poll:${p.pid}:${k}:${values[k]}`,pid:p.pid,kind:{likes:'like',dislikes:'dislike',bought:'buy'}[k],total:values[k],ts:Math.min(now(),Math.max(1,Math.floor(Number(p.ts)||now()))),features:JSON.stringify(f)});
    }updates.push(values);
  }
  const result=await e.DB.batch([
    q(e,`INSERT OR IGNORE INTO learning_events(event_key,ts,pid,kind,weight,features)
      SELECT json_extract(value,'$.key'),json_extract(value,'$.ts'),json_extract(value,'$.pid'),json_extract(value,'$.kind'),MIN(1000,json_extract(value,'$.total')-COALESCE((SELECT CASE json_extract(value,'$.kind') WHEN 'like' THEN likes WHEN 'dislike' THEN dislikes ELSE bought END FROM learning_feedback WHERE pid=json_extract(value,'$.pid')),0)),json_extract(value,'$.features') FROM json_each(?)
      WHERE json_extract(value,'$.total')>COALESCE((SELECT CASE json_extract(value,'$.kind') WHEN 'like' THEN likes WHEN 'dislike' THEN dislikes ELSE bought END FROM learning_feedback WHERE pid=json_extract(value,'$.pid')),0)`,JSON.stringify(events)),
    q(e,`INSERT INTO learning_feedback SELECT json_extract(value,'$.pid'),json_extract(value,'$.likes'),json_extract(value,'$.dislikes'),json_extract(value,'$.bought') FROM json_each(?) WHERE true ON CONFLICT(pid) DO UPDATE SET likes=MAX(likes,excluded.likes),dislikes=MAX(dislikes,excluded.dislikes),bought=MAX(bought,excluded.bought)`,JSON.stringify(updates))
  ]);return {added:result[0].meta.changes};
}
export async function explorationQuery(e,queries,cursor,dailyCounts,disabled){
  const state=await q(e,'SELECT config FROM learning_state WHERE id=1').first().catch(error=>{if(!/no such table.*learning_state/.test(error.message))throw error;return null;});
  const percent=state?JSON.parse(state.config).exploration_percent:0;
  const eligible=queries.filter(t=>!disabled?.includes(t.toLowerCase())&&(dailyCounts.get(t.toLowerCase())||0)<8);
  // Controlled discovery within the owner's existing topics, never bypass caps.
  if(!eligible.length||((cursor*37)%100)>=percent)return null;
  const least=eligible.reduce((a,b)=>(dailyCounts.get(b.toLowerCase())||0)<(dailyCounts.get(a.toLowerCase())||0)?b:a,eligible[cursor%eligible.length]);
  return least;
}
export async function learningRoute(request,e,{payload,fail,json}){
  await ensureLearning(e);const path=new URL(request.url).pathname,method=request.method,state=await q(e,'SELECT * FROM learning_state WHERE id=1').first(),config=JSON.parse(state.config),model=JSON.parse(state.model);
  if(path.endsWith('/feedback')&&method==='POST'){const data=await payload(request);if(!Array.isArray(data.rows)||data.rows.length>20)fail(400,'До 20 товаров за запрос');return json(await importFeedback(e,data.rows));}
  if(path.endsWith('/train')&&method==='GET'){
    const events=(await q(e,'SELECT * FROM learning_events WHERE id>? ORDER BY id LIMIT 500',model.cursor||0).all()).results;
    const ids=events.map(r=>r.pid);const shadows=(await q(e,'SELECT * FROM learning_shadow WHERE pid IN (SELECT value FROM json_each(?)) LIMIT 500',JSON.stringify(ids)).all()).results;
    return json({config,model,events,shadows});
  }
  if(path.endsWith('/train')&&method==='PUT'){
    const data=await payload(request,1024*1024),m=data.model;
    if(!m||m.version!==1||!Number.isSafeInteger(m.cursor)||m.cursor<model.cursor||Object.keys(m.weights||{}).length>8192||!Object.values(m.weights||{}).every(Number.isFinite)||!Number.isFinite(m.intercept)||!Number.isSafeInteger(m.trained_events)||m.trained_events<0||!m.comparison||!['n','legacy_brier','river_brier'].every(k=>Number.isFinite(m.comparison[k])&&m.comparison[k]>=0)||!Array.isArray(m.comparison.posts)||m.comparison.posts.length>1000||!m.comparison.posts.every(Number.isSafeInteger))fail(400,'Некорректная модель');
    const r=await q(e,"UPDATE learning_state SET model=? WHERE id=1 AND json_extract(model,'$.cursor')=?",JSON.stringify({...m,updated_at:m.cursor>model.cursor?now():Number(model.updated_at||0),checked_at:now()}),data.previous_cursor).run();if(!r.meta.changes)fail(409,'Модель уже обновлена');
    // Additive analytics upkeep only; even failure cannot revert a trained model.
    try{await maintainAdminSummaries(e);}catch{console.log('ADMIN_INSIGHTS historical summaries deferred');}
    return json({ok:true,cursor:m.cursor});
  }
  if(method==='PUT'){
    const data=await payload(request);if(!['LEGACY','SHADOW'].includes(data.mode))fail(409,'LEARNING пока закрыт: требуется независимая оценка, не хуже Legacy');
    if(!Number.isInteger(data.exploration_percent)||data.exploration_percent<0||data.exploration_percent>30)fail(400,'Эксперименты: 0–30%');
    await q(e,'UPDATE learning_state SET config=? WHERE id=1',JSON.stringify({mode:data.mode,exploration_percent:data.exploration_percent})).run();return json({ok:true});
  }
  if(method!=='GET')fail(405,'Метод не поддерживается');
  const all=await q(e,"SELECT * FROM learning_stats WHERE scope='all' AND key='all'").first(),today=await q(e,"SELECT * FROM learning_stats WHERE scope='day' AND key=?",new Date().toISOString().slice(0,10)).first(),categories=(await q(e,"SELECT * FROM learning_stats WHERE scope='category' ORDER BY events DESC LIMIT 30").all()).results;
  const comparison=model.comparison||{},enough=comparison.n>=200&&(comparison.posts||[]).length>=20&&now()-Number(comparison.first_ts||now())>=7*86400;
  const insights=await adminInsights(e);
  return json({config,...insights,feedback_events:all?.events||0,feedback_weight:(all?.positive||0)+(all?.negative||0),today_events:today?.events||0,last_feedback:all?.last||0,model_updated_at:model.updated_at||0,trained_events:model.trained_events||0,categories:categories.map(c=>({...c,rate:(c.positive+1)/(c.positive+c.negative+2),reason:c.events<5?'Пока мало наблюдений':c.positive>=c.negative?'Больше положительных сигналов':'Больше отрицательных сигналов'})),comparison:{paired_observations:comparison.paired_observations||0,positive:comparison.positive??null,negative:comparison.negative??null,wins:comparison.wins??null,losses:comparison.losses??null,ties:comparison.ties??null,last_observation:comparison.last_observation||null,legacy_mean:comparison.paired_observations?comparison.legacy_sum/comparison.paired_observations:null,river_mean:comparison.paired_observations?comparison.river_sum/comparison.paired_observations:null,samples:comparison.n||0,minimum:200,minimum_posts:20,minimum_days:7,sufficient:enough,legacy_brier:enough?comparison.legacy_brier/comparison.n:null,river_brier:enough?comparison.river_brier/comparison.n:null,uplift:null,explanation:'River не публикует в SHADOW. Сравниваем его прогноз с исторической долей позитивных сигналов категории для товара, выбранного Legacy. Эффект публикаций River ещё неизвестен.'},legacy_fallback:true,learning_allowed:false});
}
