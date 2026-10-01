import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {DEFAULT_SCHEDULE} from './scheduler_api.mjs';
const source=fs.readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
// The exact existing UI functions, not a copied implementation.
const functions=source.slice(source.indexOf('const weekNames='),source.indexOf("document.addEventListener('change',event=>"));
function render(schedule={...DEFAULT_SCHEDULE},status={}){
  const elements=new Map(),element=key=>{
    if(!elements.has(key))elements.set(key,{innerHTML:'',insertAdjacentHTML(position,html){this.innerHTML+=html;}});
    return elements.get(key);
  };
  element('#schedule-form').elements={search_interval_minutes:{closest:()=>element('search-presets')}};
  const context={$:element,state:{schedule:{schedule,status}},Intl,Date,Number,esc:x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
  vm.runInNewContext(functions+'\nrenderSchedule();',context);
  return {elements,context};
}
test('schedule editor exposes every preset, independent settings and fixed-time editing',()=>{
  const {elements}=render({...DEFAULT_SCHEDULE,mode:'times',post_times:['09:00','20:00']});
  const html=elements.get('#schedule-editor').innerHTML;
  for(const name of ['timezone','post_interval_minutes','search_interval_minutes','min_queue','quiet_start','quiet_end','weekday','jitter_minutes','min_post_gap_minutes','max_posts_hour','max_posts_day'])assert.ok(html.includes('name="'+name+'"'));
  assert.ok(html.includes('value="09:00"'));assert.ok(html.includes('value="20:00"'));
  for(const value of [5,10,15,20,30,45,60,120])assert.ok(elements.get('#schedule-interval .choice-row').innerHTML.includes('data-schedule-interval="'+value+'"'));
  for(const value of [5,10,20,30,60,120])assert.ok(elements.get('search-presets').innerHTML.includes('data-schedule-search-interval="'+value+'"'));
});
test('status is escaped, pauses previews, reports fresh queue/search/counters',()=>{
  const {elements,context}=render({...DEFAULT_SCHEDULE,paused:true},{queue_size:123,new_today:42,posted_today:7,scan_running:true,error:'<img src=x onerror=evil()>',next_posts:[1,2,3,4,5]});
  const html=elements.get('#schedule-dashboard').innerHTML;
  assert.ok(!html.includes('<img'));assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('Ближайшие публикации'));
  assert.ok(html.includes('123'));assert.ok(html.includes('42'));
  vm.runInNewContext('renderScheduleStatus();',context);
  assert.ok(elements.get('#schedule-dashboard .schedule-metrics').innerHTML.includes('Идёт поиск'));
  assert.ok(elements.get('#schedule-dashboard .schedule-metrics').innerHTML.includes('Постов сегодня'));
});
