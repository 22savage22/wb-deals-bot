// Build isolated copied assets + additive public-only seed. No auth or deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalize} from '../cloudflare/domain.mjs';
import {STAGING_WORKER,PUBLIC_BOT_ID} from './staging_worker.mjs';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url)),OUT=path.join(ROOT,'.test-temp/style-staging');
export const ACCOUNT='a4f7cbd9ad379d4b18087b99e9839205';
const protectedDB=['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20'];
export function configuration(databaseId){
  if(!/^[a-f0-9-]{36}$/.test(databaseId)||protectedDB.includes(databaseId))throw Error('NON_STAGING_DATABASE_REJECTED');
  return {name:STAGING_WORKER,account_id:ACCOUNT,main:path.join(ROOT,'miniapp/features/staging_worker.mjs'),compatibility_date:'2026-09-01',workers_dev:true,preview_urls:false,send_metrics:false,
    version_metadata:{binding:'CF_VERSION'},assets:{directory:path.join(OUT,'assets'),binding:'ASSETS',run_worker_first:['/api/*','/admin*','/telegram/*','/superfind*','/preview/*','/style','/style/'],html_handling:'none'},
    d1_databases:[{binding:'DB',database_name:STAGING_WORKER,database_id:databaseId}],
    ratelimits:[{name:'RATE_LIMITER',namespace_id:'1013',simple:{limit:40,period:60}}],
    vars:{STYLE_STAGING:'1',STYLE_STAGING_DB_ID:databaseId,PUBLIC_BOT_ID,FEATURE_PREVIEW:'1',MINIAPP_BOT_USERNAME:'WbPodborr_bot'},
    triggers:{crons:[]},observability:{enabled:true}};
}
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
export async function prepareStaging(databaseId='00000000-0000-0000-0000-000000000000'){
  const assets=path.join(OUT,'assets');await fs.mkdir(path.join(assets,'static'),{recursive:true});await fs.mkdir(path.join(assets,'feature'),{recursive:true});await fs.mkdir(path.join(assets,'style'),{recursive:true});await fs.mkdir(path.join(assets,'style-photos'),{recursive:true});
  for(const name of ['app.js','app.css'])await fs.copyFile(path.join(ROOT,'miniapp/static',name),path.join(assets,'static',name));
  const html=await fs.readFile(path.join(ROOT,'miniapp/static/index.html'),'utf8');
  await fs.writeFile(path.join(assets,'index.html'),html.replace('</head>','<script src="/style-navigation.js" defer></script></head>'));
  await fs.appendFile(path.join(assets,'static/app.css'),'\n.style-overlay{position:fixed;inset:0;width:100%;height:100dvh;z-index:1000;border:0;background:#f5f4ef}\n');
  await fs.copyFile(path.join(ROOT,'miniapp/features/style_navigation.js'),path.join(assets,'style-navigation.js'));
  await fs.copyFile(path.join(ROOT,'miniapp/features/ui/index.html'),path.join(assets,'style/index.html'));
  for(const name of ['app.js','app.css'])await fs.copyFile(path.join(ROOT,'miniapp/features/ui',name),path.join(assets,'feature',name));
  const reviewed=JSON.parse(await fs.readFile(path.join(ROOT,'docs/shadow-20261011/reviewed-visual.json'),'utf8')).profiles,catalog=[],ids=new Set(),statements=[];
  for(const dataset of ['shadow-20261011','shadow-prospective-20261011']){
    const report=JSON.parse(await fs.readFile(path.join(ROOT,'docs',dataset,'report.json'),'utf8'));
    for(const p of report.products){
      if(ids.has(p.id))continue;const image=await fs.readFile(path.join(ROOT,'docs',dataset,'photos',`${p.id}.webp`));
      if(createHash('sha256').update(image).digest('hex')!==p.imageHash)throw Error('PHOTO_HASH_MISMATCH');
      ids.add(p.id);const displayImage=`/style-photos/${p.id}.webp`,product={...p,displayImage},visual=reviewed[p.id]??null;
      const publicProduct=normalize({...p,title:p.name,checked_at:Math.floor(Number(p.observedAt||p.photoVerifiedAt||0)/1000)});publicProduct.image=displayImage;
      await fs.writeFile(path.join(assets,displayImage.slice(1)),image);catalog.push({product,visual});
      statements.push(`INSERT INTO feature_catalog(id,data,visual,checked_at) VALUES(${p.id},${quote(JSON.stringify(product))},${quote(JSON.stringify(visual))},${p.photoVerifiedAt||0}) ON CONFLICT(id) DO UPDATE SET data=excluded.data,visual=excluded.visual,checked_at=excluded.checked_at;`);
      statements.push(`INSERT INTO products(id,data,checked_at) VALUES(${p.id},${quote(JSON.stringify(publicProduct))},${publicProduct.checked_at}) ON CONFLICT(id) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at;`);
    }
  }
  if(catalog.length>120||catalog.length<30)throw Error('BOUNDED_FASHION_SEED_REQUIRED');
  const base=await fs.readFile(path.join(ROOT,'miniapp/cloudflare/schema.sql'),'utf8'),feature=await fs.readFile(path.join(ROOT,'miniapp/features/schema.sql'),'utf8');
  statements.push(`INSERT OR REPLACE INTO feature_meta VALUES('shared_catalog_snapshot',${quote(JSON.stringify({products:catalog}))});`);
  statements.push("INSERT OR REPLACE INTO metadata VALUES('public_schema_version','1');");
  statements.push(`INSERT OR REPLACE INTO feature_meta VALUES('style_staging_database',${quote(databaseId)});`);
  // Do not falsify synced_at, current price/stock or publication history proof.
  await fs.writeFile(path.join(OUT,'seed.sql'),base+'\n'+feature+'\n'+statements.join('\n'));
  await fs.writeFile(path.join(OUT,'wrangler.json'),JSON.stringify(configuration(databaseId),null,2));
  return {worker:STAGING_WORKER,photos:catalog.length,reviewedProfiles:catalog.filter(row=>row.visual).length,databaseId,publicBotId:PUBLIC_BOT_ID,production:false,aiCalls:0};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareStaging(process.argv[2])));
