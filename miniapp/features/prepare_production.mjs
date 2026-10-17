// Generates and DRY-RUNS a future production package ONLY. Never deploys, changes
// the production Wrangler config, secrets, Cron, settings, or bot menu/webhooks.
import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {LocalD1} from './local_d1.mjs';import {prepareStaging,OUT,ROOT} from './prepare_staging.mjs';import {ADAPTER_SCHEMA} from './catalogue_adapter.mjs';
const target=path.join(ROOT,'.test-temp/style-production'),quote=v=>"'"+String(v).replaceAll("'","''")+"'";
export async function prepareProduction({dryRun=true}={}){
  // Existing build output is generated separately; no source/static originals edited.
  const built=spawnSync(process.execPath,[path.join(ROOT,'miniapp/cloudflare/prepare-assets.mjs')],{cwd:ROOT,encoding:'utf8',timeout:60000});
  if(built.status!==0)throw Error('BASE_ASSET_BUILD_FAILED');
  await prepareStaging();await fs.mkdir(target,{recursive:true});const assets=path.join(target,'assets');
  await fs.cp(path.join(ROOT,'miniapp/public'),assets,{recursive:true});
  for(const name of ['feature','style','style-photos'])await fs.cp(path.join(OUT,'assets',name),path.join(assets,name),{recursive:true});
  const styleHTML=await fs.readFile(path.join(assets,'style/index.html'),'utf8');
  if(!styleHTML.includes('<html lang="ru">'))throw Error('PUBLIC_STYLE_SHELL_MARKER_MISSING');
  await fs.writeFile(path.join(assets,'style/index.html'),styleHTML.replace('<html lang="ru">','<html lang="ru" data-style-runtime="public">'));
  await fs.copyFile(path.join(OUT,'assets/style-navigation.js'),path.join(assets,'style-navigation.js'));
  const html=await fs.readFile(path.join(assets,'index.html'),'utf8');
  await fs.writeFile(path.join(assets,'index.html'),html.replace('</head>','<script src="/style-flags.js"></script><script src="/style-navigation.js" defer></script></head>'));
  const nav=await fs.readFile(path.join(assets,'style-navigation.js'),'utf8');
  await fs.writeFile(path.join(assets,'style-navigation.js'),'if(globalThis.__WB_STYLE_ENABLED__===true){\n'+nav+'\n}');
  await fs.appendFile(path.join(assets,'static/app.css'),'\n.style-overlay{position:fixed;inset:0;width:100%;height:100dvh;z-index:1000;border:0;background:#f5f4ef}\n');
  const admin=await fs.readFile(path.join(assets,'admin/index.html'),'utf8');
  await fs.writeFile(path.join(assets,'admin/index.html'),admin.replace('</head>','<script src="/admin/feature-flags.js"></script></head>'));
  const base=JSON.parse(await fs.readFile(path.join(ROOT,'wrangler.jsonc'),'utf8'));
  const config={...base,main:path.join(ROOT,'miniapp/features/production_worker.mjs'),assets:{...base.assets,directory:assets},vars:{...base.vars,SUBSCRIBER_STYLE_ENABLED:'0',SUPERFIND_PREVIEW_ENABLED:'0',STYLE_CATALOGUE_REFRESH_ENABLED:'0'}};
  await fs.writeFile(path.join(target,'wrangler.json'),JSON.stringify(config,null,2));
  // A one-off CLI deploy is not enough: subsequent Workers Builds MUST keep
  // building the public feature assets/entrypoint. These are instructions ONLY,
  // not edits to the currently working production config or GitHub integration.
  const plan={requiresFinalCommand:'Внедряй',access:'ALL_VERIFIED_TELEGRAM_USERS',identity:'SERVER_VERIFIED_PUBLIC_BOT_INITDATA',manualRegistration:false,
    secondLiveAccount:'OPTIONAL_ADDITIONAL_ACCEPTANCE_NOT_AN_ACCESS_OR_RELEASE_GATE',
    buildsAfterApproval:{main:'miniapp/features/production_worker.mjs',assetsDirectory:'.test-temp/style-production/assets',buildCommand:'node miniapp/features/prepare_production.mjs --assets-only'},
    initialFlags:{SUBSCRIBER_STYLE_ENABLED:'0',SUPERFIND_PREVIEW_ENABLED:'0',STYLE_CATALOGUE_REFRESH_ENABLED:'0'},
    activateAfterMigrationAndSmoke:{SUBSCRIBER_STYLE_ENABLED:'1',STYLE_CATALOGUE_REFRESH_ENABLED:'1'},
    superfind:'KEEP_OFF_UNCHANGED',channelPosting:'UNCHANGED_30_MIN',river:'SHADOW_UNCHANGED',automaticVision:'UNCHANGED_OFF',
    rollback:'DISABLE_NEW_FLAGS_RESTORE_PREVIOUS_WORKER_KEEP_ADDITIVE_USER_TABLES',newPaidServices:false};
  await fs.writeFile(path.join(target,'release-plan.json'),JSON.stringify(plan,null,2));
  const db=new LocalD1();let rows;try{db.exec(await fs.readFile(path.join(OUT,'seed.sql'),'utf8'));rows=db.sqlite.prepare('SELECT id,data,visual,checked_at FROM feature_catalog ORDER BY id').all();}finally{db.close();}
  let migration=await fs.readFile(path.join(ROOT,'miniapp/features/schema.sql'),'utf8');migration+='\n'+ADAPTER_SCHEMA+'\n';
  for(const row of rows)migration+=`INSERT OR IGNORE INTO feature_catalog(id,data,visual,checked_at) VALUES(${row.id},${quote(row.data)},${quote(row.visual)},${row.checked_at});\n`;
  migration+="INSERT INTO feature_meta(key,value) SELECT 'shared_catalog_snapshot',json_object('products',json_group_array(json_object('product',json(data),'visual',json(visual)))) FROM (SELECT data,visual FROM feature_catalog ORDER BY checked_at DESC,id DESC LIMIT 120) WHERE true ON CONFLICT(key) DO NOTHING;\n";
  // This bootstrap NEVER writes products, scheduler_config/inventory/status,
  // learning state, owner exclusions, feature settings or personal profiles.
  await fs.writeFile(path.join(target,'additive-migration.sql'),migration);
  const verify=new LocalD1();try{verify.exec(migration);verify.exec(migration);if(verify.sqlite.prepare('SELECT count(*) n FROM feature_catalog').get().n!==80)throw Error('PRODUCTION_BOOTSTRAP_INVALID');if(verify.sqlite.prepare('SELECT count(*) n FROM style_accounts').get().n!==0)throw Error('PRODUCTION_BOOTSTRAP_WRITES_USER');}finally{verify.close();}
  if(dryRun){const result=spawnSync(process.execPath,[path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),'deploy','--dry-run','--config',path.join(target,'wrangler.json'),'--outdir',path.join(target,'bundle')],{cwd:ROOT,env:{...process.env,WRANGLER_SEND_METRICS:'false',TEMP:path.join(ROOT,'.test-temp'),TMP:path.join(ROOT,'.test-temp')},encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024});
    if(result.error||result.status!==0)throw Error('FUTURE_PRODUCTION_DRY_RUN_FAILED');}
  const receipt={productionDeployed:false,merge:false,requiresFinalCommand:'Внедряй',assetsOnly:!dryRun,publicAccess:'ALL_VERIFIED_TELEGRAM_USERS',manualRegistration:false,flagsDefaultOff:true,cronUnchanged:JSON.stringify(config.triggers)===JSON.stringify(base.triggers),runtimeBindingsPreserved:true,bootstrapExamples:80,personalRowsInserted:0,SQLIdempotent:true,output:target};
  await fs.writeFile(path.join(target,'build-receipt.json'),JSON.stringify(receipt,null,2));return receipt;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).some(arg=>arg!=='--assets-only'))throw Error('UNSUPPORTED_PREPARATION_ARGUMENT');
  prepareProduction({dryRun:!process.argv.includes('--assets-only')}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
