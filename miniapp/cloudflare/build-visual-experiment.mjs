// Explicit isolated one-shot experiment. Production source/config unchanged.
import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=process.cwd();
let source=await readFile('miniapp/cloudflare/visual_enrichment.mjs','utf8');
const needle='export const VISUAL_REQUEST_RESERVE=2500;';
if(source.split(needle).length!==2)throw Error('Staging reserve source changed');
source=source.replace(needle,'export const VISUAL_REQUEST_RESERVE=200;');
await build({entryPoints:['miniapp/cloudflare/visual_staging.mjs'],outfile:'.test-temp/visual-staging-standalone/gemma-500.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[{name:'staging-reserve',setup(b){b.onLoad({filter:/visual_enrichment\.mjs$/},()=>({contents:source,loader:'js',resolveDir:resolve(root,'miniapp/cloudflare')}));}}]});
const config=JSON.parse(await readFile('.test-temp/visual-staging-standalone/wrangler.jsonc','utf8'));
if(config.name!=='wb-finds-visual-staging'||config.d1_databases.length!==1||config.d1_databases[0].database_id!=='5779987d-1100-45ad-8cd4-9df9c1436a20'||config.triggers||config.assets)throw Error('Staging isolation failed');
config.main=resolve(root,'.test-temp/visual-staging-standalone/gemma-500.mjs');
await writeFile('.test-temp/visual-staging-standalone/gemma-500.jsonc',JSON.stringify(config,null,2));
console.log('GEMMA_STAGING_BUNDLE_OK; additional durable budget500; single-image reserve200; production unchanged');
