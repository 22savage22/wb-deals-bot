import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensureScheduler} from './scheduler_api.mjs';
import {ensureReactions,seedLegacy,vote,registerMessage,refreshMessage,repairReactions,processCallback,handleMainUpdate,webhookSecret,reactionChannel} from './feedback.mjs';
import worker from './worker.mjs';
import {handleOwnerCommand,setupOwnerMenu} from './owner_commands.mjs';
const markup={inline_keyboard:[[{text:'WB',url:'https://www.wildberries.ru/catalog/123/detail.aspx'}],[{text:'👍 0',callback_data:'l123'},{text:'👎 0',callback_data:'d123'},{text:'🛒 Купил 0',callback_data:'b123'}],[{text:'Сохранить',url:'https://t.me/test_bot?start=save_123'}]]};
async function env(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 const meter={queries:0};const wrap=(sql,args=[])=>({bind(...v){return wrap(sql,v);},first(){meter.queries++;return Promise.resolve(db.prepare(sql).get(...args)??null);},all(){meter.queries++;return Promise.resolve({results:db.prepare(sql).all(...args),meta:{rows_read:1,rows_written:0}});},run(){meter.queries++;const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),rows_read:1,rows_written:Number(r.changes)}};}});
 const e={db,meter,DB:{prepare:wrap,batch:async ss=>{db.exec('BEGIN');try{const r=ss.map(s=>s.run());db.exec('COMMIT');return r;}catch(x){db.exec('ROLLBACK');throw x;}}},TG_BOT_TOKEN:'test:not-real',MINIAPP_SYNC_KEY:'s'.repeat(40),MINIAPP_ADMIN_ID:'42',SCHEDULER_DRIVER:'cloudflare-native'};
 await ensureScheduler(e);await ensureReactions(e);db.prepare("INSERT INTO scheduler_policy VALUES(1,?)").run(JSON.stringify({chat_id:'-1001'}));
 return e;
}
const counts=e=>e.db.prepare("SELECT likes,dislikes,bought FROM reaction_totals WHERE scope='test:x' AND pid=123").get();
const cast=r=>({...r});
async function send(e,voter,action,event_id){return vote(e,{scope:'test:x',pid:123,voter,action,event_id});}
async function saved(e){await registerMessage(e,{chat:'42',message_id:50,scope:'test:x',pid:123,markup});}
const good=async(url,options)=>Response.json({ok:true,result:{message_id:50,reply_markup:JSON.parse(options.body).reply_markup}});
test('main webhook replies to owner help/status/admin directly, deduplicates and preserves production schedule',async t=>{
 const e=await env(t),ts=Math.floor(Date.now()/1000),sent=[];
 e.db.prepare("UPDATE scheduler_config SET data=json_set(data,'$.post_interval_minutes',30),status=json_set(status,'$.last_post_success',?,'$.last_search_success',?,'$.search_retry_at',?)").run(ts-60,ts-120,ts+300);
 const before=e.db.prepare('SELECT data,revision FROM scheduler_config').get(),secret=await webhookSecret(e),original=globalThis.fetch;
 globalThis.fetch=async(url,o)=>{assert.ok(url.endsWith('/sendMessage'));assert.ok(url.includes('/bot'+e.TG_BOT_TOKEN+'/'));sent.push(JSON.parse(o.body));return Response.json({ok:true,result:{message_id:100+sent.length}});};
 const update=(id,text,user=42)=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:user,type:'private'},text}});
 const invoke=u=>worker.fetch(new Request('https://example.test/telegram/main/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(u)}),e,{waitUntil:()=>assert.fail('basic commands need no poller or background jobs')});
 try{
  for(const [i,command] of ['help','status','admin'].entries())assert.equal((await invoke(update(200+i,'/'+command))).status,200);
  assert.equal(sent.length,3);assert.match(sent[1].text,/Интервал публикации: 30 мин/);assert.match(sent[1].text,/WB backoff: до/);
  assert.equal(sent[2].reply_markup.inline_keyboard[0][0].web_app.url,'https://example.test/admin');
  await invoke(update(202,'/admin'));assert.equal(sent.length,3);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM reaction_admin_updates').get().n,0);
  assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config').get(),before);
  for(const command of ['help','status','admin'])assert.equal(JSON.parse(e.db.prepare('SELECT value FROM metadata WHERE key=?').get('owner_command_'+command).value).state,'sent');
  await invoke(update(203,'/admin',43));assert.match(sent.at(-1).text,/только у владельца/);assert.equal(sent.at(-1).reply_markup,undefined);
 }finally{globalThis.fetch=original;}
});
test('owner menu is scoped to owner; ambiguous send never duplicates on redelivery',async t=>{
 const e=await env(t),calls=[];
 const fetcher=async(url,o)=>{const method=url.split('/').at(-1),body=JSON.parse(o.body);calls.push({method,body});return Response.json({ok:true,result:method==='getMe'?{id:1,username:'WBmarket'}:method==='getChatMenuButton'?{web_app:{url:'https://example.test/admin'}}:true});};
 assert.equal((await setupOwnerMenu(e,'https://example.test',fetcher)).menu_ok,true);
 assert.equal(calls.find(c=>c.method==='setChatMenuButton').body.chat_id,42);
 assert.deepEqual(calls.find(c=>c.method==='setMyCommands').body.scope,{type:'chat',chat_id:42});
 const update={update_id:600,message:{from:{id:42},chat:{id:42,type:'private'},text:'/admin'}};let sends=0;
 const timeout=async()=>{sends++;throw Error('timeout');};
 assert.equal((await handleOwnerCommand(e,update,'https://example.test',timeout)).uncertain,true);
 assert.equal((await handleOwnerCommand({...e},update,'https://example.test',timeout)).duplicate,true);assert.equal(sends,1);
});
test('channel username resolves to persistent numeric identity without changing scheduler policy or sending votes',async t=>{
 const e=await env(t);
 e.db.prepare('UPDATE scheduler_policy SET data=? WHERE id=1').run(JSON.stringify({chat_id:'@example_channel'}));
 e.db.prepare('INSERT INTO reaction_messages(chat,message_id,scope,pid,markup) VALUES(?,?,?,?,?)').run('@example_channel',88,'channel',123,JSON.stringify(markup));
 let calls=0;
 const getChat=async(u,o)=>{calls++;assert.ok(u.endsWith('/getChat'));assert.equal(JSON.parse(o.body).chat_id,'@example_channel');return Response.json({ok:true,result:{id:-1001,type:'channel'}});};
 assert.equal(await reactionChannel(e,getChat),'-1001');
 assert.equal(await reactionChannel({...e},getChat),'-1001');assert.equal(calls,1);
 assert.equal(e.db.prepare('SELECT chat FROM reaction_messages WHERE message_id=88').get().chat,'-1001');
 assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_policy WHERE id=1').get().data).chat_id,'@example_channel');
 assert.equal(e.db.prepare('SELECT COUNT(*) n FROM reaction_votes').get().n,0);
});
test('A like, B like, A switches; repeated votes and bought are idempotent across isolates',async t=>{
 const e=await env(t);await saved(e);
 await send(e,'A','l',1);assert.deepEqual(cast(counts(e)),{likes:1,dislikes:0,bought:0});
 await send({...e},'B','l',2);assert.deepEqual(cast(counts(e)),{likes:2,dislikes:0,bought:0});
 await send({...e},'A','d',3);assert.deepEqual(cast(counts(e)),{likes:1,dislikes:1,bought:0});
 await send(e,'A','d',4);await send(e,'A','l',1); // retry of old update must not revert
 assert.deepEqual(cast(counts(e)),{likes:1,dislikes:1,bought:0});
 await send(e,'B','b',5);await send(e,'B','b',6);assert.equal(counts(e).bought,1);
 const receipt=await refreshMessage(e,'42',50,good);
 assert.deepEqual(receipt.reply_markup.inline_keyboard[1].map(b=>b.text),['👍 1','👎 1','🛒 Купил 1']);
 assert.deepEqual(receipt.reply_markup.inline_keyboard[0],markup.inline_keyboard[0]);assert.deepEqual(receipt.reply_markup.inline_keyboard[2],markup.inline_keyboard[2]);
});
test('atomic parallel votes produce correct totals without history scans',async t=>{
 const e=await env(t);
 await Promise.all(Array.from({length:25},(_,i)=>send(e,'v'+i,'l',100+i)));
 assert.equal(counts(e).likes,25);
 await Promise.all(Array.from({length:25},(_,i)=>send(e,'v'+i,'l',200+i)));
 assert.equal(counts(e).likes,25);
 const plan=e.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM reaction_votes WHERE scope='test:x' AND pid=123 AND voter='x'").all();assert.ok(plan.some(r=>/SEARCH.*INDEX/.test(r.detail)));
 const p=e.db.prepare("EXPLAIN QUERY PLAN UPDATE reaction_messages SET dirty=1 WHERE scope='test:x' AND pid=123").all();assert.ok(p.some(r=>/reaction_product/.test(r.detail)));
});
test('slow editor cannot overwrite the final newer revision; second isolate coalesces',async t=>{
 const e=await env(t);await saved(e);await send(e,'A','l',1);
 let release,started;const began=new Promise(r=>started=r),gate=new Promise(r=>release=r);const seen=[];
 const slow=async(u,o)=>{seen.push(JSON.parse(o.body).reply_markup);if(seen.length===1){started();await gate;}return good(u,o);};
 const first=refreshMessage(e,'42',50,slow);await began;
 await send(e,'B','l',2);assert.equal((await refreshMessage({...e},'42',50,slow)).pending,true);
 await send(e,'A','d',3);release();const receipt=await first;
 assert.deepEqual(receipt.totals,{likes:1,dislikes:1,bought:0});assert.equal(seen.length,2);
 assert.equal(e.db.prepare('SELECT dirty FROM reaction_messages').get().dirty,0);
});
test('Telegram edit failure preserves votes; stale lease/unknown delivery recovers',async t=>{
 const e=await env(t);await saved(e);await send(e,'A','l',1);
 await refreshMessage(e,'42',50,async()=>{throw Error('timeout');});assert.equal(counts(e).likes,1);
 const row=e.db.prepare('SELECT dirty,lease_until FROM reaction_messages').get();assert.equal(row.dirty,1);assert.ok(row.lease_until>Date.now()/1000);
 e.db.prepare('UPDATE reaction_messages SET lease_until=0,retry_at=0').run();await repairReactions(e,good);
 assert.equal(e.db.prepare('SELECT dirty FROM reaction_messages').get().dirty,0);
});
test('legacy baselines survive and an old message updates only markup',async t=>{
 const e=await env(t);await seedLegacy(e,[{pid:123,likes:7,dislikes:2,bought:3}]);await seedLegacy(e,[{pid:123,likes:0}]);
 const methods=[];const cb={data:'l123',from:{id:9},update_id:101,message:{message_id:88,chat:{id:-1001},reply_markup:markup}};
 const r=await processCallback(e,cb,async(u,o)=>{methods.push(u.split('/').at(-1));return good(u,o);});
 assert.deepEqual({...r.totals},{likes:8,dislikes:2,bought:3,revision:1});assert.deepEqual(methods,['editMessageReplyMarkup']);
 assert.equal((await processCallback(e,{...cb,update_id:102},good)).totals.likes,8);
});
test('main webhook acknowledges before ANY D1 call and persists before HTTP200',async t=>{
 const e=await env(t);await saved(e);const before=e.meter.queries,methods=[],pending=[];
 t.mock.method(globalThis,'fetch',async(u,o)=>{methods.push(u.split('/').at(-1));if(u.endsWith('/answerCallbackQuery'))assert.equal(e.meter.queries,before);return good(u,o);});
 const request=new Request('https://test/telegram/main/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':await webhookSecret(e)},body:JSON.stringify({update_id:99,callback_query:{id:'real-shape',data:'l123',from:{id:42},message:{message_id:50,chat:{id:42},reply_markup:markup}}})});
 const response=await worker.fetch(request,e,{waitUntil:p=>pending.push(p)});assert.equal(response.status,200);assert.equal(counts(e).likes,1);await Promise.all(pending);
 assert.deepEqual(methods,['answerCallbackQuery','editMessageReplyMarkup']);
 const noauth=await worker.fetch(new Request('https://test/telegram/main/webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),e);assert.equal(noauth.status,403);
});
test('extended legacy commands remain queued, other users are not retained',async t=>{
 const e=await env(t);
 await handleMainUpdate(e,{update_id:10,message:{chat:{id:42},from:{id:42},text:'/cfg'}});
 await handleMainUpdate(e,{update_id:11,message:{chat:{id:43},from:{id:43},text:'/status'}});
 assert.equal(e.db.prepare('SELECT COUNT(*) n FROM reaction_admin_updates').get().n,1);
});
test('redelivery repairs an interrupted legacy event without doubling the vote',async t=>{
 const e=await env(t);
 const cb={data:'l123',from:{id:9},update_id:501,message:{message_id:88,chat:{id:-1001},reply_markup:markup}};
 const first=await processCallback(e,cb,good);
 e.db.prepare('DELETE FROM reaction_admin_updates WHERE update_id=501').run();
 const retry=await processCallback({...e},cb,good);
 assert.equal(first.changed,true);assert.equal(retry.changed,false);assert.equal(retry.event_current,true);
 assert.equal(retry.totals.likes,1);
 assert.equal(e.db.prepare('SELECT COUNT(*) n FROM reaction_admin_updates WHERE update_id=501').get().n,1);
 await processCallback(e,cb,good);
 assert.equal(e.db.prepare('SELECT COUNT(*) n FROM reaction_admin_updates WHERE update_id=501').get().n,1);
});
test('irrelevant subscriber messages consume no database budget or storage',async t=>{
 const e=await env(t),before=e.meter.queries;
 const request=new Request('https://test/telegram/main/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':await webhookSecret(e)},body:JSON.stringify({update_id:51,message:{chat:{id:77},from:{id:77},text:'/start'}})});
 assert.equal((await worker.fetch(request,e)).status,200);assert.equal(e.meter.queries,before);
});
