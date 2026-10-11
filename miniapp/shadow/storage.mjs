// Proposed D1 port. Not wired to any Worker/production migration or cron.
import {planPriceObservation,priceContextKey} from './value.mjs';
export function shadowStore(env,{approvedTestDatabaseId}={}){
  if(env.VALUE_SHADOW_ISOLATED!=='true'||!env.SHADOW_DB||env.DB===env.SHADOW_DB)throw new Error('Separate SHADOW_DB required; production DB forbidden');
  // Must come from a separately reviewed deployment manifest, NOT a request
  // parameter or an automatic copy of env.VALUE_SHADOW_DATABASE_ID.
  if(typeof approvedTestDatabaseId!=='string'||!/^[-a-z0-9]{16,80}$/.test(approvedTestDatabaseId)||env.VALUE_SHADOW_DATABASE_ID!==approvedTestDatabaseId)throw Error('Approved test database identity required');
  const db=env.SHADOW_DB,q=(sql,...args)=>db.prepare(sql).bind(...args);
  return {
    async history(pid,variant,context){const key=priceContextKey(context);if(!key||!variant||variant==='unknown')return [];return (await q('SELECT observed_at AS at,price,source,variant AS variantKey,context FROM shadow_prices WHERE pid=? AND variant=? AND context=? ORDER BY day DESC LIMIT 28',pid,variant,key).all()).results.map(r=>({...r,currency:JSON.parse(r.context).currency}));},
    async observe(p){
      const plan=planPriceObservation(p),context=priceContextKey(p.context);
      if(!plan.due||!context)throw new Error('Verified variant/context price required');
      const o=plan.observation;
      return q('INSERT OR IGNORE INTO shadow_prices(pid,variant,context,day,observed_at,price,source) VALUES(?,?,?,?,?,?,?)',o.id,o.variantKey,context,o.day,o.observedAt,o.price,o.source).run();
    },
    async pruneProduct(pid,variant,context,cutoffDay){const key=priceContextKey(context);if(!key||!variant||variant==='unknown'||!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDay))throw Error('Retention key required');return q('DELETE FROM shadow_prices WHERE pid=? AND variant=? AND context=? AND day IN (SELECT day FROM shadow_prices WHERE pid=? AND variant=? AND context=? AND day<? LIMIT 28)',pid,variant,key,pid,variant,key,cutoffDay).run();},
    async cohort(category,type,since){return (await q('SELECT data FROM shadow_candidates WHERE category=? AND type=? AND observed_at>=? ORDER BY observed_at DESC,pid LIMIT 32',category,type,since).all()).results.map(p=>JSON.parse(p.data));},
    async taste(profile){if(!['owner','wife'].includes(profile))throw new Error('Personal profile required');return (await q('SELECT pid,action,data,updated_at FROM shadow_taste WHERE profile=? ORDER BY pid LIMIT 30',profile).all()).results;},
    async comparisons(){return (await q('SELECT id,at,data FROM shadow_comparisons ORDER BY at DESC LIMIT 20').all()).results;}
  };
}
