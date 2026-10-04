// No additional SQL: observe the official D1 result metadata of existing calls.
export function observeD1(db){
  const metrics={queries:0,rows_read:0,rows_written:0,metadata_available:false};
  const coverage={complete:true};
  const costs=new Map();
  const fingerprint=sql=>{let hash=2166136261;for(const c of sql.replace(/\s+/g,' ').trim())hash=Math.imul(hash^c.charCodeAt(0),16777619);return (hash>>>0).toString(16);};
  const record=(result,sql='batch')=>{metrics.queries++;if(Number.isFinite(result?.meta?.rows_read)){metrics.metadata_available=true;metrics.rows_read+=result.meta.rows_read;metrics.rows_written+=Number(result.meta.rows_written||0);const id=fingerprint(sql),cost=costs.get(id)||{query_id:id,rows_read:0,calls:0};cost.rows_read+=result.meta.rows_read;cost.calls++;costs.set(id,cost);}else coverage.complete=false;return result;};
  const execute=async(call)=>{try{return await call();}catch(error){if(!/too many.*(?:quer|subrequest)|maximum.*quer|query.*limit/i.test(String(error.message)))coverage.complete=false;throw error;}};
  const raw=new WeakMap();
  function statement(original,sql){
    const wrapped={
      bind(...args){return statement(original.bind(...args),sql);},
      async all(){return record(await execute(()=>original.all()),sql);},
      async run(){return record(await execute(()=>original.run()),sql);},
      async first(column){const result=record(await execute(()=>original.all()),sql),row=result.results?.[0]??null;return column&&row?row[column]:row;}
    };
    raw.set(wrapped,{original,sql});return wrapped;
  }
  return {metrics,coverage,topQueries:()=>[...costs.values()].sort((a,b)=>b.rows_read-a.rows_read).slice(0,3),DB:{
    prepare(sql){return statement(db.prepare(sql),sql);},
    async batch(statements){return (await execute(()=>db.batch(statements.map(s=>raw.get(s).original)))).map((result,i)=>record(result,raw.get(statements[i]).sql));}
  }};
}
export function d1QuotaFailure(error,now=Date.now()){
  const message=String(error?.message||'');
  if(!/exceeded.*D1.*free tier daily row (read|write) limit/i.test(message))return null;
  const tomorrow=new Date(now);tomorrow.setUTCHours(24,0,0,0);
  return {code:'D1_DAILY_QUOTA_EXCEEDED',error:'Исчерпан бесплатный суточный лимит базы. Автопостинг недоступен до обновления лимита.',retry_at:Math.floor(tomorrow.getTime()/1000)};
}
