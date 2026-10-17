// Offline-only review: node miniapp/cloudflare/quality_replay.mjs <private SQL>.
// Never connects to Telegram, Workers AI or production D1.
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {ownerReason,QUALITY_CATEGORIES} from './audience_quality.mjs';
import {audienceContext,feedbackSummary,FEEDBACK_SQL} from './audience_feedback.mjs';
import {choose} from './native_scheduler.mjs';import {selectionReason} from './selection_policy.mjs';
const file=process.argv[2];if(!file)throw Error('Pass protected SQL export, never credentials');
const bytes=readFileSync(file),db=new DatabaseSync(':memory:');db.exec(bytes.toString('utf8'));
const integrity=db.prepare('PRAGMA integrity_check').get(),foreign_keys=db.prepare('PRAGMA foreign_key_check').all().length;
if(Object.values(integrity)[0]!=='ok'||foreign_keys)throw Error('Backup integrity/FK verification failed');
const sql='SELECT c.data,c.revision,c.status,p.data policy FROM scheduler_config c JOIN scheduler_policy p ON p.id=c.id WHERE c.id=1',before=db.prepare(sql).get();
const current=JSON.parse(before.policy),proposed={...current,audience_quality:{enabled:true,excluded:Object.keys(QUALITY_CATEGORIES),feedback_enabled:true,fashion_priority:true}};
db.exec(readFileSync(new URL('./audience_quality.sql',import.meta.url),'utf8'));
const wrap=(s,args=[])=>({bind(...v){return wrap(s,v);},async all(){return {results:db.prepare(s).all(...args)};},async first(){return db.prepare(s).get(...args)||null;}});
const context=await audienceContext({DB:{prepare:wrap}}),rows=db.prepare("SELECT * FROM scheduler_inventory WHERE state='ready' ORDER BY queued_at,pid LIMIT 300").all();
const stamp=Number(JSON.parse(before.status).last_scheduler_tick)||Math.floor(Date.now()/1000);
const recent=db.prepare('SELECT topic,title_key,data,ts FROM scheduler_deliveries WHERE ts>? ORDER BY ts LIMIT 4032').all(stamp-86400);
const describe=r=>{if(!r)return null;const p=JSON.parse(r.data);return {nmId:r.pid,title:p.title,query:p.query,price:p.product,rating:p.rating,reviews:p.feedbacks,reason:selectionReason(p,proposed)||'Допущен; остаются live-проверки цены, фото и дубля'};};
const rejected=rows.filter(r=>ownerReason(JSON.parse(r.data),proposed)),alreadyBlocked=rows.filter(r=>selectionReason(JSON.parse(r.data),current)),sample=rows.filter(r=>!selectionReason(JSON.parse(r.data),proposed));
const result={backup:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),integrity:'ok',foreign_keys,tables:db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n},
 snapshot:{last_message_id:JSON.parse(before.status).last_message_id,interval:JSON.parse(before.data).post_interval_minutes,queue:rows.length},feedback:feedbackSummary(context),
 native_learning_events:db.prepare("SELECT kind,COUNT(*) n FROM learning_events WHERE event_key LIKE 'reaction:%' GROUP BY kind").all(),
 preview:{owner_excluded:rejected.length,already_blocked_by_existing_filters:alreadyBlocked.length,allowed:sample.length,old_choice:describe(choose(rows,recent,current.total_posts+recent.length,current)),new_choice:describe(choose(rows,recent,current.total_posts+recent.length,proposed,context)),excluded:rejected.map(describe),allowed_examples:sample.slice(0,8).map(describe)},
 query_plan:db.prepare('EXPLAIN QUERY PLAN '+FEEDBACK_SQL).all().map(p=>p.detail),production_modified:false,telegram_sends:0,ai_calls:0};
if(JSON.stringify(before)!==JSON.stringify(db.prepare(sql).get()))throw Error('Offline review modified settings');
console.log(JSON.stringify(result,null,2));db.close();
