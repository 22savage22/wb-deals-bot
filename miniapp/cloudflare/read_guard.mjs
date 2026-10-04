// Account quota protection for THIS Worker. Atomic UTC-day reservations are
// shared by all isolates. Catalogue/user traffic cannot spend scheduler funds.
import {observeD1} from './d1_budget.mjs';
export const READ_LIMITS={core:1500000,optional:1500000,diagnostic:15000};
export const WRITE_LIMITS={core:35000,optional:45000,diagnostic:500};
export class ReadBudgetError extends Error {constructor(){super('Дневной защитный бюджет базы исчерпан; повторите после 03:00 по Москве');this.status=429;}}
export async function withReadBudget(env,lane,ceiling,operation,options={}){
  const day=new Date().toISOString().slice(0,10),q=(sql,...args)=>env.DB.prepare(sql).bind(...args);
  // A separate, strictly bounded read-only owner lane remains observable when
  // application funds are exhausted. It cannot publish or change settings.
  const writeCeiling=options.writes??(lane==='diagnostic'?4:lane==='core'?512:5000);
  const reserve=()=>q(`INSERT INTO worker_read_budget(day,lane,reads,writes) VALUES(?,?,?,?)
    ON CONFLICT(day,lane) DO UPDATE SET reads=reads+excluded.reads,writes=writes+excluded.writes
    WHERE reads+excluded.reads<=? AND writes+excluded.writes<=?`,day,lane,ceiling,writeCeiling,READ_LIMITS[lane],WRITE_LIMITS[lane]).run();
  let held;
  try{held=await reserve();}catch(e){
    if(!/no such table.*worker_read_budget/i.test(String(e.message)))throw e;
    await q('CREATE TABLE IF NOT EXISTS worker_read_budget(day TEXT NOT NULL,lane TEXT NOT NULL,reads INTEGER NOT NULL,writes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,lane))').run();held=await reserve();
  }
  if(!held.meta.changes)throw new ReadBudgetError();
  const meter=observeD1(env.DB);
  try{return await operation({...env,DB:meter.DB,D1_METER:meter.metrics});}
  finally{
    // Unknown metadata is NEVER treated as a free query. A crashed execution
    // leaves its reservation charged, conservatively, until the UTC reset.
    // Application/network errors do not erase the official metadata already
    // returned by D1. Charge actual completed queries even on an HTTP failure.
    // Only a genuinely unobserved database call keeps the worst-case reserve.
    const known=meter.coverage.complete;
    const used=known?meter.metrics.rows_read:ceiling;
    const written=known?meter.metrics.rows_written+2:writeCeiling;
    await q('UPDATE worker_read_budget SET reads=MAX(0,reads-?+?),writes=MAX(0,writes-?+?) WHERE day=? AND lane=?',ceiling,used,writeCeiling,written,day,lane).run();
    if(used>ceiling)console.error('D1_RESERVATION_OVERRUN',JSON.stringify({lane,ceiling,used}));
    if(written>writeCeiling)console.error('D1_WRITE_RESERVATION_OVERRUN',JSON.stringify({lane,ceiling:writeCeiling,used:written}));
  }
}
