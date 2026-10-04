// Publish only the existing three frontend files, never Python code or secrets.
import {mkdir,copyFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),out=new URL('public/',root);
await mkdir(new URL('static/',out),{recursive:true});
// Fail closed if this generated directory unexpectedly contains other files.
// Do not silently delete them or include them in the deployment.
for(const name of await readdir(out))if(!['index.html','static','admin'].includes(name))throw new Error('Unexpected public asset');
for(const name of await readdir(new URL('static/',out)))if(!['app.js','app.css'].includes(name))throw new Error('Unexpected static asset');
for(const [source,target] of [['static/index.html','index.html'],['static/app.js','static/app.js'],['static/app.css','static/app.css']])
  await copyFile(new URL(source,root),new URL(target,out));
await mkdir(new URL('admin/',out),{recursive:true});
for(const name of await readdir(new URL('admin/',out)))if(!['index.html','app.js','app.css'].includes(name))throw new Error('Unexpected admin asset');
await copyFile(new URL('admin/index.html',root),new URL('admin/index.html',out));
await build({entryPoints:[fileURLToPath(new URL('admin/app.jsx',root))],outfile:fileURLToPath(new URL('admin/app.js',out)),bundle:true,minify:true,format:'esm',target:['es2020'],define:{'process.env.NODE_ENV':'"production"'},loader:{'.svg':'dataurl'},legalComments:'eof'});
console.log('ASSETS_READY: public frontend unchanged; separate admin bundle ready');
