// Separate staging D1 does NOT provide a separate Free-tier account quota.
// This ledger caps ALL admitted dynamic staging work, including reused public
// routes. It is not authentication: callers must verify identity/route FIRST.
import {observeD1} from '../cloudflare/d1_budget.mjs';

export const STAGING_D1_LIMITS=Object.freeze({reads:100000,writes:8000});
export const STAGING_BUDGET_SCHEMA='CREATE TABLE IF NOT EXISTS stage_request_budget(day TEXT PRIMARY KEY,reads INTEGER NOT NULL,writes INTEGER NOT NULL);';
// The settling UPDATE changes only the indexed, unique day's two counters.
// Conservatively charge four reads/writes for it; verify against its official
// metadata afterwards. This is a guard allowance, NOT fabricated billing data.
const SETTLEMENT_ALLOWANCE=Object.freeze({reads:4,writes:4});
export class StagingBudgetError extends Error{
  constructor(){super('Дневной защитный бюджет тестового приложения исчерпан. Попробуйте после 03:00 по Москве.');this.status=429;this.code='STAGING_D1_BUDGET_EXHAUSTED';}
}
export function stagingReservation(request){
  // Server-code-only accounting label, NOT an exposed HTTP endpoint. Detached
  // preview jobs must receive their own admission instead of escaping the
  // already-settled fast HTTP202 request. Forty candidate writes have indexes.
  if(request.method==='POST'&&new URL(request.url).pathname==='/__style-background/superfind')return {reads:2000,writes:512};
  if(request.method==='DELETE'){
    // Existing public deletion also removes up to1000 saved products with
    // multiple indexes, up to50 outfits, then the separate bounded style data.
    // Style deletions include receipt indexes and bounded adapter triggers
    // cleaning up archived cards after their final saved reference disappears.
    return new URL(request.url).pathname==='/api/me'?{reads:3000,writes:6500}:{reads:2200,writes:2400};
  }
  // A cold public catalogue rebuild persists six snapshot pages plus its lease
  // and metadata. It is not a read-only GET; keep room for their index writes.
  const coldCatalogue=new URL(request.url).pathname==='/api/catalog';
  return {reads:1000,writes:['GET','HEAD'].includes(request.method)&&!coldCatalogue?16:64};
}
export function createStagingBudget({clock=()=>Date.now(),limits=STAGING_D1_LIMITS,report=(kind,details)=>console.error(kind,JSON.stringify(details))}={}){
  if(!Number.isSafeInteger(limits.reads)||limits.reads<1||!Number.isSafeInteger(limits.writes)||limits.writes<1)throw Error('STAGING_BUDGET_LIMITS_INVALID');
  return async function withBudget(env,request,operation){
    if(!/^[a-f0-9-]{36}$/.test(env.STYLE_STAGING_DB_ID??''))throw Error('STAGING_DATABASE_ID_REQUIRED');
    const day=new Date(clock()).toISOString().slice(0,10),reservation=stagingReservation(request),meter=observeD1(env.DB),q=(sql,...args)=>meter.DB.prepare(sql).bind(...args);
    // Include a WHERE in the INSERT too: unlike an unguarded VALUES insert,
    // first use of a new UTC day cannot admit a reservation above the limit.
    const held=await q(`INSERT INTO stage_request_budget(day,reads,writes)
      SELECT ?,?,? WHERE ?<=? AND ?<=? AND EXISTS(
        SELECT 1 FROM feature_meta WHERE key='style_staging_database' AND value=?)
      ON CONFLICT(day) DO UPDATE SET reads=reads+excluded.reads,writes=writes+excluded.writes
      WHERE reads+excluded.reads<=? AND writes+excluded.writes<=?`,day,reservation.reads,reservation.writes,reservation.reads,limits.reads,reservation.writes,limits.writes,env.STYLE_STAGING_DB_ID,limits.reads,limits.writes).run();
    // Even an accidentally misbound DB that contains this ledger cannot be
    // written: the same atomic INSERT requires its exact staging canary first.
    if(!held.meta?.changes)throw new StagingBudgetError();
    let returned=false;
    try{const result=await operation({...env,DB:meter.DB});returned=true;return result;}
    finally{
      const known=meter.coverage.complete,charged=known?{
        reads:meter.metrics.rows_read+SETTLEMENT_ALLOWANCE.reads,
        writes:meter.metrics.rows_written+SETTLEMENT_ALLOWANCE.writes
      }:reservation;
      // Metadata missing or a failed query keeps the complete worst-case
      // reservation. A crashed execution similarly leaves its reservation held.
      const settled=await q(`UPDATE stage_request_budget SET reads=MAX(0,reads-?+?),writes=MAX(0,writes-?+?) WHERE day=?`,reservation.reads,charged.reads,reservation.writes,charged.writes,day).run();
      const overrun=charged.reads>reservation.reads||charged.writes>reservation.writes||
        known&&(settled.meta.rows_read>SETTLEMENT_ALLOWANCE.reads||settled.meta.rows_written>SETTLEMENT_ALLOWANCE.writes);
      if(overrun)report('STYLE_STAGE_BUDGET_OVERRUN',{reservation,charged,metadata_complete:meter.coverage.complete});
      if(!settled.meta?.changes)report('STYLE_STAGE_BUDGET_SETTLEMENT_MISSING',{operation_returned:returned});
    }
  };
}
export const withStagingBudget=createStagingBudget();
