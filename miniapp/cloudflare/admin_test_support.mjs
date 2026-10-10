import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import worker from './worker.mjs';
import {ensureScheduler,DEFAULT_SCHEDULE} from './scheduler_api.mjs';
export async function adminEnvironment(t,{path=':memory:'}={}){
  const db=new DatabaseSync(path);t?.after(()=>db.close());db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  let calls=0;const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},async first(){calls++;return db.prepare(sql).get(...args)||null;},async all(){calls++;return {results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}};},async run(){calls++;const result=db.prepare(sql).run(...args);return {meta:{changes:Number(result.changes),rows_read:1,rows_written:Number(result.changes)}};}});
  const e={db,get calls(){return calls;},TG_BOT_TOKEN:'456:owner-fixture-not-a-real-token',MINIAPP_BOT_TOKEN:'123:public-fixture-not-a-real-token',MINIAPP_ADMIN_ID:'11',SCHEDULER_DRIVER:'cloudflare-native',DB:{prepare:wrap,async batch(ss){db.exec('BEGIN');try{const result=[];for(const s of ss)result.push(await s.run());db.exec('COMMIT');return result;}catch(er){db.exec('ROLLBACK');throw er;}}}};
  await ensureScheduler(e);if(!db.prepare('SELECT id FROM scheduler_policy WHERE id=1').get()){
    db.prepare('UPDATE scheduler_config SET data=? WHERE id=1').run(JSON.stringify({...DEFAULT_SCHEDULE,post_interval_minutes:30}));
    db.prepare('INSERT INTO scheduler_policy VALUES(1,?)').run(JSON.stringify({chat_id:'-1234567',queries:['худи мужское','кроссовки','сумка'],disabled_topics:['сумка'],max_price:1000,min_rating:4.3,min_feedbacks:20,blocked_words:[],blacklist:[],total_posts:42}));
  }
  return e;
}
export function signedAdmin(e,id=11){const f={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})},check=Object.keys(f).sort().map(k=>k+'='+f[k]).join('\n'),secret=createHmac('sha256','WebAppData').update(e.TG_BOT_TOKEN).digest();return new URLSearchParams({...f,hash:createHmac('sha256',secret).update(check).digest('hex')}).toString();}
export const adminRequest=(e,path,method='GET',body,id=11)=>worker.fetch(new Request('https://isolated.example'+path,{method,headers:{'Content-Type':'application/json',...(id?{'X-Telegram-Init-Data':signedAdmin(e,id)}:{})},...(body?{body:JSON.stringify(body)}:{})}),e,{waitUntil(){}});
export const rawPolicy=e=>e.db.prepare('SELECT data FROM scheduler_policy WHERE id=1').get().data;
export const testCard=(id=777)=>({id,name:'Худи хлопковое '+id,brand:'Fixture',subjectName:'Худи',reviewRating:4.9,feedbacks:100,sizes:[{qty:10,price:{product:70000,basic:100000}}]});
export function discoveryFixture(calls=[]){return async url=>{const u=new URL(url);calls.push(u);if(u.hostname==='search.wb.ru'||u.hostname==='card.wb.ru')return Response.json({products:[testCard()]});if(u.hostname.endsWith('.wbbasket.ru'))return new Response('local image fixture',{headers:{'content-type':'image/webp'}});throw new Error('External side effect forbidden');};}
