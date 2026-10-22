// Pure timezone/formatter checks only: no DB, network, scheduler tick or posting.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SCHEDULE,validateSchedule,scheduleWallFormatter,dayStart} from './scheduler_api.mjs';
import {postingWindow,postDue} from './native_scheduler.mjs';
const at=value=>Date.parse(value)/1000;
const schedule=(zone,patch={})=>({...DEFAULT_SCHEDULE,timezone:zone,post_interval_minutes:30,...patch});
function countConstructors(t,{countDayFormats=false}={}){
  const Original=Intl.DateTimeFormat,constructed=[];let dayFormats=0;
  t.mock.method(Intl,'DateTimeFormat',function(locale,options){
    constructed.push({locale,options:{...options}});const formatter=new Original(locale,options);
    if(countDayFormats&&locale==='en-CA'){
      const format=formatter.format;
      Object.defineProperty(formatter,'format',{value:(...args)=>{dayFormats++;return format(...args);}});
    }
    return formatter;
  });
  return {constructed,get dayFormats(){return dayFormats;}};
}

test('validation and native wall formatting reuse ONE constructor with the unchanged exact wall options',t=>{
  const meter=countConstructors(t),s=schedule('Asia/Tokyo');
  validateSchedule(s);const first=scheduleWallFormatter(s.timezone);
  assert.equal(postingWindow(s,at('2026-10-22T03:45:00Z')).clock,'12:45');
  validateSchedule(s);assert.equal(scheduleWallFormatter(s.timezone),first);
  assert.deepEqual(meter.constructed,[{locale:'en-GB',options:{timeZone:'Asia/Tokyo',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}}]);
});

test('invalid zones retain their validation errors even after a valid formatter has been cached',()=>{
  validateSchedule(schedule('Europe/Moscow'));
  for(const zone of ['not/a-zone','', 'Europe/Moscow\n'])
    assert.throws(()=>validateSchedule(schedule(zone)),{message:'Неизвестный часовой пояс'});
  for(const zone of [null,123,'x'.repeat(81)])
    assert.throws(()=>validateSchedule(schedule(zone)),{message:'Некорректный часовой пояс'});
  assert.throws(()=>postingWindow(schedule('not/a-zone'),at('2026-10-22T00:00:00Z')),{message:'Неизвестный часовой пояс'});
  assert.throws(()=>postDue(schedule('not/a-zone'),0,at('2026-10-22T00:00:00Z')),{message:'Неизвестный часовой пояс'});
});

test('real fractional-offset and Moscow dates retain their local clock and midnight boundaries',()=>{
  const instant=at('2026-10-22T18:30:00Z');
  for(const [zone,clock,date] of [['Asia/Kathmandu','00:15','2026-10-23'],['Europe/Moscow','21:30','2026-10-22'],['Asia/Kolkata','00:00','2026-10-23']]){
    const window=postingWindow(schedule(zone),instant);
    assert.equal(window.clock,clock);assert.equal(window.date,date);assert.equal(window.timezone,zone);assert.equal(window.allowed,true);
  }
});

test('DST spring gaps and autumn repeated hours retain quiet-hour decisions in London and New York',()=>{
  for(const [zone,before,after,left,right] of [
    ['Europe/London','2026-03-29T00:59:00Z','2026-03-29T01:00:00Z','00:59','02:00'],
    ['America/New_York','2026-03-08T06:59:00Z','2026-03-08T07:00:00Z','01:59','03:00']
  ]){
    assert.equal(postingWindow(schedule(zone),at(before)).clock,left);
    assert.equal(postingWindow(schedule(zone),at(after)).clock,right);
  }
  for(const [zone,first,second,after] of [
    ['Europe/London','2026-10-25T00:30:00Z','2026-10-25T01:30:00Z','2026-10-25T02:00:00Z'],
    ['America/New_York','2026-11-01T05:30:00Z','2026-11-01T06:30:00Z','2026-11-01T07:00:00Z']
  ]){
    const quiet=schedule(zone,{quiet_enabled:true,quiet_start:'01:00',quiet_end:'02:00'});
    for(const instant of [first,second]){const window=postingWindow(quiet,at(instant));assert.equal(window.clock,'01:30');assert.equal(window.allowed,false);}
    assert.equal(postingWindow(quiet,at(after)).allowed,true);
  }
});

test('day-start daily-cap boundaries remain correct on 23/25-hour DST days and fractional offsets',()=>{
  for(const [zone,instant,midnight] of [
    ['Europe/London','2026-03-29T12:00:00Z','2026-03-29T00:00:00Z'],
    ['Europe/London','2026-03-30T12:00:00Z','2026-03-29T23:00:00Z'],
    ['Europe/London','2026-10-25T23:59:00Z','2026-10-24T23:00:00Z'],
    ['Europe/London','2026-10-26T12:00:00Z','2026-10-26T00:00:00Z'],
    ['America/New_York','2026-03-08T12:00:00Z','2026-03-08T05:00:00Z'],
    ['America/New_York','2026-11-01T12:00:00Z','2026-11-01T04:00:00Z'],
    ['Asia/Kathmandu','2026-10-22T12:00:00Z','2026-10-21T18:15:00Z']
  ])assert.equal(dayStart(at(instant),zone),at(midnight),zone+' '+instant);
});

test('dayAt keeps its separate exact en-CA options and reuses construction without caching date results',t=>{
  const meter=countConstructors(t,{countDayFormats:true}),zone='Pacific/Chatham',instant=at('2026-10-22T03:00:00Z');
  const first=dayStart(instant,zone),formatted=meter.dayFormats;
  assert.ok(formatted>1);
  assert.equal(dayStart(instant+60,zone),first);assert.ok(meter.dayFormats>formatted+1);
  postingWindow(schedule(zone),instant);
  assert.deepEqual(meter.constructed.filter(row=>row.locale==='en-CA'),[{locale:'en-CA',options:{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}}]);
  assert.equal(meter.constructed.filter(row=>row.locale==='en-GB').length,1);
});

test('formatter working set retains 32 zones and evicts the oldest without changing formatted values',t=>{
  const meter=countConstructors(t),zones=Intl.supportedValuesOf('timeZone').slice(0,33),instances=new Map();
  assert.equal(zones.length,33);
  for(const zone of zones.slice(0,32))instances.set(zone,scheduleWallFormatter(zone));
  for(const zone of zones.slice(0,32))assert.equal(scheduleWallFormatter(zone),instances.get(zone));
  scheduleWallFormatter(zones[32]);const count=meter.constructed.length;
  const recreated=scheduleWallFormatter(zones[0]);assert.equal(meter.constructed.length,count+1);assert.notEqual(recreated,instances.get(zones[0]));
  const instant=new Date('2026-10-22T03:00:00Z');
  assert.deepEqual(recreated.formatToParts(instant),instances.get(zones[0]).formatToParts(instant));
});

test('cached formatters never cache a schedule, pause switch, weekday, date or time result',()=>{
  const s=schedule('Europe/Moscow'),morning=at('2026-10-22T06:30:00Z');
  assert.equal(postingWindow(s,morning).allowed,true);
  s.paused=true;assert.equal(postingWindow(s,morning).allowed,false);assert.equal(postDue(s,0,morning),false);
  s.paused=false;s.weekdays=[0];assert.equal(postingWindow(s,morning).allowed,false);
  s.weekdays=[0,1,2,3,4,5,6];s.quiet_enabled=true;s.quiet_start='09:00';s.quiet_end='10:00';
  assert.equal(postingWindow(s,morning).allowed,false);assert.equal(postingWindow(s,morning+3600).allowed,true);
  const fixed=schedule('Europe/Moscow',{mode:'times',post_times:['00:15']});
  assert.equal(postDue(fixed,at('2026-10-22T20:00:00Z'),at('2026-10-22T21:16:00Z')),true);
});
