// Offline export of the existing four init phases. No network, AI or credential.
// The live runner applies these same phases through the protected staging Worker.
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import staging from './visual_staging.mjs';
import samples from './visual_staging_samples.json' with {type:'json'};

export async function stagingMigrations(){
  const db=new DatabaseSync(':memory:');let statements=[];
  const literal=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
  function wrap(sql,args=[]){return {
    bind(...v){return wrap(sql,v);},
    async all(){return {results:db.prepare(sql).all(...args),meta:{rows_read:0,rows_written:0}};},
    async first(){return db.prepare(sql).get(...args)||null;},
    async run(){const result=db.prepare(sql).run(...args);let at=0;const rendered=sql.replace(/\?/g,()=>literal(args[at++]));if(at!==args.length)throw new Error('Migration placeholder mismatch');statements.push(rendered.replace(/;\s*$/,'')+';');return {meta:{changes:Number(result.changes),rows_read:0,rows_written:0}};}
  };}
  const env={VISUAL_STAGING:'isolated',VISUAL_STAGING_DB_ID:samples.database.id,MINIAPP_SYNC_KEY:'offline-migration-fixture-'.repeat(2),DB:{prepare:wrap,async batch(ss){db.exec('BEGIN');try{const result=[];for(const s of ss)result.push(await s.run());db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}}};
  const phases=['base','scheduler','learning','visual'],files=[];
  try{
    for(const [index,phase] of phases.entries()){
      statements=[];
      const response=await staging.fetch(new Request('https://offline/staging/init/'+phase,{method:'POST',headers:{Authorization:'Bearer '+env.MINIAPP_SYNC_KEY}}),env);
      const result=await response.json();if(result.initialized!==phase)throw new Error('Offline staging migration failed: '+phase);
      files.push({name:String(index+1).padStart(4,'0')+'_staging_'+phase+'.sql',sql:'-- STAGING ONLY: '+samples.database.name+' / '+samples.database.id+'\n-- Exported from the existing runtime init phase; live runner applies that phase.\n'+statements.join('\n')+'\n'});
    }
    return files;
  }finally{db.close();}
}
async function main(){
  const dir='miniapp/cloudflare/staging-migrations';await mkdir(dir,{recursive:true});
  const files=await stagingMigrations();for(const file of files)await writeFile(dir+'/'+file.name,file.sql);
  console.log('STAGING_MIGRATIONS_READY',JSON.stringify({files:files.length,database_id:samples.database.id,network_calls:0,ai_calls:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Offline staging migration export failed');process.exitCode=1;});
