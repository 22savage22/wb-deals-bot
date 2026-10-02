// Publish only the existing three frontend files, never Python code or secrets.
import {mkdir,copyFile,readdir} from 'node:fs/promises';
const root=new URL('../',import.meta.url),out=new URL('public/',root);
await mkdir(new URL('static/',out),{recursive:true});
// Fail closed if this generated directory unexpectedly contains other files.
// Do not silently delete them or include them in the deployment.
for(const name of await readdir(out))if(!['index.html','static'].includes(name))throw new Error('Unexpected public asset');
for(const name of await readdir(new URL('static/',out)))if(!['app.js','app.css'].includes(name))throw new Error('Unexpected static asset');
for(const [source,target] of [['static/index.html','index.html'],['static/app.js','static/app.js'],['static/app.css','static/app.css']])
  await copyFile(new URL(source,root),new URL(target,out));
console.log('ASSETS_READY: index.html, static/app.js, static/app.css');
