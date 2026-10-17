// Local isolated D1-shaped SQLite adapter. No production credentials or network.
import {DatabaseSync} from 'node:sqlite';
export function openLocalPrices(path=':memory:'){
  const sqlite=new DatabaseSync(path);let calls=0;
  const statement=(sql,params=[])=>{const sync=()=>{calls++;const r=sqlite.prepare(sql).run(...params);return {meta:{changes:Number(r.changes)}};};return {
    bind(...values){return statement(sql,values);},sync,
    async run(){return sync();},async first(){calls++;return sqlite.prepare(sql).get(...params)||null;},async all(){calls++;return {results:sqlite.prepare(sql).all(...params),meta:{}};}
  };};
  return {sqlite,DB:{prepare:statement,async batch(items){sqlite.exec('BEGIN');try{const r=items.map(s=>s.sync());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}},get queries(){return calls;},close(){sqlite.close();}};
}
