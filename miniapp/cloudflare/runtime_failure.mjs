// Only finite classifications cross the log boundary. Messages, stacks, SQL,
// URLs, headers and arbitrary error properties are deliberately not copied.
import {ReadBudgetError} from './read_guard.mjs';
const names=new Set(['Error','TypeError','RangeError','SyntaxError','ReadBudgetError','AbortError','TimeoutError','DOMException','AggregateError']);
const stages=new Set(['scheduled','header','maintenance','selection','publication','preflight','discovery','reactions','receipt','runtime']);
export function safeRuntimeFailure(error,stage='runtime'){
  const seen=new Set(),causes=[];
  const read=(value,key)=>{try{return value?.[key];}catch{return undefined;}};
  for(let current=error;current&&causes.length<3&&!seen.has(current);current=read(current,'cause')){
    seen.add(current);
    const raw=read(current,'message'),message=typeof raw==='string'?raw:'';
    const rawName=read(current,'name'),name=current instanceof ReadBudgetError?'ReadBudgetError':names.has(rawName)?rawName:'Error';
    const code=read(current,'code');
    const classification=/exceeded.*D1.*free tier daily row (?:read|write) limit/i.test(message)?'D1_DAILY_QUOTA_EXCEEDED':
      name==='ReadBudgetError'?'D1_READ_BUDGET':
      /too many.*quer|maximum.*quer|query.*limit/i.test(message)?'D1_QUERY_LIMIT':
      /D1.*daily/i.test(message)?'D1_DAILY_LIMIT':
      /D1_ERROR|SQLITE|no such (?:table|column)|constraint/i.test(message)?'D1_SQL_ERROR':
      (code===1102||code==='1102'||/Worker exceeded CPU time limit/i.test(message))?'CPU_LIMIT_SIGNAL':
      /too many.*subrequest/i.test(message)?'WORKER_SUBREQUEST_LIMIT':
      /Telegram send outcome/i.test(message)?'TELEGRAM_UNKNOWN':
      /Missing Telegram/i.test(message)?'TELEGRAM_SECRET_MISSING':
      /Telegram rejected/i.test(message)?'TELEGRAM_REJECTED':
      name==='AbortError'||name==='TimeoutError'?'OPERATION_ABORTED':
      name==='TypeError'?'TYPE_ERROR':name==='SyntaxError'?'SYNTAX_ERROR':name==='RangeError'?'RANGE_ERROR':'UNCLASSIFIED';
    causes.push({type:name,classification});
  }
  // A catch cannot prove a platform CPU termination. Confirm via the runtime
  // invocation outcome in Workers Logs; hard termination may bypass JS catch.
  return {stage:stages.has(stage)?stage:'runtime',causes,cpu_signal:causes.some(x=>x.classification==='CPU_LIMIT_SIGNAL')};
}
