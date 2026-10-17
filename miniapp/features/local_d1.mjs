// Real local SQLite, D1-shaped adapter for isolated preview/tests ONLY.
// SQLite does not report Cloudflare rows_read. Leave billing metadata unknown;
// existing budgets conservatively keep reservations instead of inventing usage.
import {DatabaseSync} from 'node:sqlite';
export class LocalD1{
  constructor(file=':memory:'){this.sqlite=new DatabaseSync(file);this.sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');this.queries=[];}
  exec(sql){this.sqlite.exec(sql);}
  prepare(sql){const db=this;
    const stmt={args:[],bind(...args){const bound=Object.create(stmt);bound.args=args;return bound;},
      async first(){const value=db.sqlite.prepare(sql).get(...this.args);db.queries.push({sql,returned:value?1:0,kind:'first'});return value??null;},
      async all(){const results=db.sqlite.prepare(sql).all(...this.args);db.queries.push({sql,returned:results.length,kind:'all'});return {results,success:true,meta:{}};},
      syncRun(){const result=db.sqlite.prepare(sql).run(...this.args);db.queries.push({sql,changed:Number(result.changes),kind:'run'});return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
      async run(){return this.syncRun();}};return stmt;
  }
  async batch(statements){this.sqlite.exec('BEGIN IMMEDIATE');try{const result=statements.map(statement=>statement.syncRun());this.sqlite.exec('COMMIT');return result;}catch(error){this.sqlite.exec('ROLLBACK');throw error;}}
  close(){this.sqlite.close();}
}
