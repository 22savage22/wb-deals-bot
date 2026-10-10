import test from 'node:test';import assert from 'node:assert/strict';
import {adminEnvironment,adminRequest} from './admin_test_support.mjs';
import {DEFAULT_SCHEDULE} from './scheduler_api.mjs';import {scheduleForecast} from './admin_api.mjs';
import {postingWindow} from './native_scheduler.mjs';
test('schedule forecast honors quiet hours, local day caps, rolling hour cap and weekdays',()=>{
  const now=Date.parse('2026-10-10T17:00:00Z')/1000,s={...DEFAULT_SCHEDULE,post_interval_minutes:30,quiet_enabled:true,quiet_start:'21:00',quiet_end:'08:00',max_posts_day:2,max_posts_hour:1};
  const r=scheduleForecast(s,now-1800,[{ts:now-1800}],now);assert.ok(r.next_posts.length>1);assert.equal(r.next_posts[0],now+1800);const counts=new Map([['2026-10-10',1]]);
  for(const t of r.next_posts){const wall=postingWindow(s,t);assert.ok(wall.allowed);counts.set(wall.date,(counts.get(wall.date)||0)+1);assert.ok(counts.get(wall.date)<=2);}
  assert.ok(r.next_posts.every((t,i)=>!i||t-r.next_posts[i-1]>=3600));
  const monday=scheduleForecast({...s,weekdays:[0],max_posts_day:144,max_posts_hour:12},now-1800,[],now);assert.equal(new Date(monday.next_posts[0]*1000).getUTCDay(),1);
  assert.deepEqual(scheduleForecast({...s,paused:true},now,[],now).next_posts,[]);
});
test('schedule explicit save and restore audit atomic CAS; preview and overview never change interval30',async t=>{
  const e=await adminEnvironment(t),original=e.db.prepare('SELECT data,revision FROM scheduler_config').get(),s=JSON.parse(original.data),now=Math.floor(Date.now()/1000);e.db.prepare('INSERT INTO scheduler_posts VALUES(1,?)').run(now-60);
  const preview=await adminRequest(e,'/api/admin/schedule/preview','POST',{schedule:s});assert.equal(preview.status,200);assert.ok((await preview.json()).next_posts.length);assert.deepEqual(e.db.prepare('SELECT data,revision FROM scheduler_config').get(),original);
  const overview=await(await adminRequest(e,'/api/admin/overview')).json();assert.equal(overview.status.posted_today,1);
  assert.equal((await adminRequest(e,'/api/admin/schedule','PUT',{schedule:{...s,post_interval_minutes:60},revision:original.revision})).status,200);
  const history=await(await adminRequest(e,'/api/admin/config/history')).json(),live=await(await adminRequest(e,'/api/admin/schedule')).json();assert.equal(history.items[0].scope,'schedule');
  assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:history.items[0].id,revision:original.revision})).status,409);
  assert.equal((await adminRequest(e,'/api/admin/config/restore','POST',{id:history.items[0].id,revision:live.revision})).status,200);assert.equal(JSON.parse(e.db.prepare('SELECT data FROM scheduler_config').get().data).post_interval_minutes,30);
});
test('queue bounded filtering/pagination and published history expose real fields without offering post from history',async t=>{
  const e=await adminEnvironment(t),now=Math.floor(Date.now()/1000);for(let i=1;i<=115;i++){const p={id:i,title:i===110?'Особые кроссовки':'Товар '+i,brand:'Brand',category:'Обувь',query:'кроссовки',product:900,rating:4.8,feedbacks:77};e.db.prepare('INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,retry_at) VALUES(?,?,?,?,?,?,?,?)').run(i,JSON.stringify(p),'кроссовки','t'+i,now+i,now,now+86400,i===110?now+600:0);}
  let r=await(await adminRequest(e,'/api/admin/queue?q='+encodeURIComponent('Особые'))).json();assert.equal(r.scanned,100);assert.equal(r.items.length,0);assert.ok(r.next_cursor);
  r=await(await adminRequest(e,'/api/admin/queue?q='+encodeURIComponent('Особые')+'&cursor='+r.next_cursor)).json();assert.equal(r.items.length,1);assert.equal(r.items[0].rating,4.8);assert.equal(r.items[0].feedbacks,77);assert.equal(r.items[0].readiness,'Ожидает проверки');
  const row=e.db.prepare('SELECT * FROM scheduler_inventory WHERE pid=110').get();e.db.prepare('INSERT INTO scheduler_deliveries VALUES(?,?,?,?,?,?)').run(110,now,55,row.topic,row.title_key,row.data);
  r=await(await adminRequest(e,'/api/admin/queue?view=published')).json();assert.equal(r.view,'published');assert.equal(r.items[0].posted_at,now);assert.equal(r.items[0].readiness,'Опубликован');
  assert.equal((await adminRequest(e,'/api/admin/queue?view=invalid')).status,400);
});
