// Persistent admission/backoff; no RAM-only cooldown or sleeping retry loops.
export const SEARCH_MIN_GAP=300;
export function retryAfter(value,now){
  if(!value)return 0;
  const seconds=/^\d+$/.test(value.trim())?Number(value):Math.ceil(Date.parse(value)/1000)-now;
  return Number.isFinite(seconds)?Math.max(0,Math.min(86400,seconds)):0;
}
export function searchBackoff(previous,error,now,random=Math.random){
  const failures=Math.min(16,Number(previous.search_failures||0)+1);
  const exponential=Math.min(21600,(error.status===403?900:300)*2**(failures-1));
  const delay=Math.max(Number(error.retry_after||0),Math.min(21600,exponential+Math.floor(exponential*.25*Math.max(0,Math.min(1,random())))));
  return {search_failures:failures,search_retry_at:now+delay,next_search:now+delay,search_backoff_seconds:delay};
}
export function searchDue(schedule,status,now,manual=false){
  if(now<Number(status.search_retry_at||0))return false;
  if(Number(status.search_failures||0)>0)return (schedule.search_enabled||manual)&&now>=Number(status.next_search||0);
  const interval=Math.max(SEARCH_MIN_GAP,schedule.search_interval_minutes*60);
  const last=Number(status.last_scan_attempt||0);
  return manual?now>=last+SEARCH_MIN_GAP:schedule.search_enabled&&now>=Math.max(last+interval,Number(status.next_search||0));
}
