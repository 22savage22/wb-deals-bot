// No additional SQL: observe the official D1 result metadata of existing calls.
export function observeD1(db){
  const metrics={queries:0,rows_read:0,rows_written:0,metadata_available:false};
  const record=result=>{metrics.queries++;if(Number.isFinite(result?.meta?.rows_read)){metrics.metadata_available=true;metrics.rows_read+=result.meta.rows_read;metrics.rows_written+=Number(result.meta.rows_written||0);}return result;};
  const raw=new WeakMap();
  function statement(original){
    const wrapped={
      bind(...args){return statement(original.bind(...args));},
      async all(){return record(await original.all());},
      async run(){return record(await original.run());},
      async first(column){const result=record(await original.all()),row=result.results?.[0]??null;return column&&row?row[column]:row;}
    };
    raw.set(wrapped,original);return wrapped;
  }
  return {metrics,DB:{
    prepare(sql){return statement(db.prepare(sql));},
    async batch(statements){return (await db.batch(statements.map(s=>raw.get(s)))).map(record);}
  }};
}
export function d1QuotaFailure(error,now=Date.now()){
  const message=String(error?.message||'');
  if(!/exceeded.*D1.*free tier daily row (read|write) limit/i.test(message))return null;
  const tomorrow=new Date(now);tomorrow.setUTCHours(24,0,0,0);
  return {code:'D1_DAILY_QUOTA_EXCEEDED',error:'Исчерпан бесплатный суточный лимит базы. Автопостинг недоступен до обновления лимита.',retry_at:Math.floor(tomorrow.getTime()/1000)};
}
