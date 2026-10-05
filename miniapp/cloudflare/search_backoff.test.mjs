import test from 'node:test';
import assert from 'node:assert/strict';
import {retryAfter,searchBackoff,searchDue} from './search_backoff.mjs';
test('Retry-After seconds/date honored, invalid values safe',()=>{
  const now=Date.parse('2026-10-05T10:00:00Z')/1000;
  assert.equal(retryAfter('1800',now),1800);
  assert.equal(retryAfter('Mon, 05 Oct 2026 10:30:00 GMT',now),1800);
  assert.equal(retryAfter('invalid',now),0);
});
test('429 exponentially backs off with jitter and respects long Retry-After',()=>{
  const a=searchBackoff({}, {status:429},1000,()=>0);
  const b=searchBackoff(a,{status:429},2000,()=>.5);
  const c=searchBackoff(b,{status:429,retry_after:3600},3000,()=>1);
  assert.equal(a.search_backoff_seconds,300);assert.equal(b.search_backoff_seconds,675);assert.equal(c.search_backoff_seconds,3600);
  assert.equal(searchBackoff({search_failures:16},{status:429},0,()=>1).search_retry_at,21600);
});
test('normal configured 20 minutes not shortened when queue needs refill',()=>{
  const s={search_enabled:true,search_interval_minutes:20},v={last_scan_attempt:1000,next_search:2200};
  assert.equal(searchDue(s,v,1060),false);assert.equal(searchDue(s,v,2199),false);assert.equal(searchDue(s,v,2200),true);
});
test('empty healthy result rotates after 5m, never minute bursts and never bypasses 429',()=>{
  const s={search_enabled:true,search_interval_minutes:20},v={last_scan_attempt:1000,last_scan_success:1002,search_receipt:{added:0},next_search:2202};
  assert.equal(searchDue(s,v,1060),false);assert.equal(searchDue(s,v,1301),false);assert.equal(searchDue(s,v,1302),true);
  assert.equal(searchDue(s,{...v,search_retry_at:1800},1302),false);
});
test('manual request cannot bypass 429, minute ticks never retry during backoff; automatic recovery',()=>{
  const s={search_enabled:true,search_interval_minutes:20},v={last_scan_attempt:1000,...searchBackoff({}, {status:429},1000,()=>0)};
  for(const t of [1060,1120,1180,1240]){assert.equal(searchDue(s,v,t),false);assert.equal(searchDue(s,v,t,true),false);}
  assert.equal(searchDue(s,v,1300),true);
  assert.equal(searchDue({...s,search_enabled:false},v,1300),false);
});
