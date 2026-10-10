// Configuration only; no credential read, Cloudflare call, or deployment.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import samples from './visual_staging_samples.json' with {type:'json'};
const db=process.env.VISUAL_STAGING_DB_ID||samples.database.id;
if(db!==samples.database.id||db==='d73d252d-3948-425b-b7c3-b65d0f5c6e5f')throw new Error('Only the owner-provided staging D1 UUID is allowed; production or another database refused');
const baseline=JSON.parse(await readFile('wrangler.jsonc','utf8'));
const standalone=process.argv.includes('--standalone');
const config={name:standalone?'wb-finds-visual-staging':baseline.name,account_id:baseline.account_id,main:resolve('miniapp/cloudflare/visual_staging.mjs'),compatibility_date:baseline.compatibility_date,workers_dev:true,preview_urls:true,keep_vars:!standalone,send_metrics:false,version_metadata:{binding:'CF_VERSION'},ai:{binding:'AI'},d1_databases:[{binding:'DB',database_name:samples.database.name,database_id:db}],vars:{VISUAL_STAGING:'isolated',VISUAL_STAGING_DB_ID:db},observability:{enabled:false}};
const directory=standalone?'.test-temp/visual-staging-standalone':'.test-temp/visual-staging';
const target=directory+'/wrangler.jsonc';await mkdir(directory,{recursive:true});await writeFile(target,JSON.stringify(config,null,2)+'\n');console.log('STAGING_CONFIG_READY: separate D1, native AI, no cron/assets/publication routes');
