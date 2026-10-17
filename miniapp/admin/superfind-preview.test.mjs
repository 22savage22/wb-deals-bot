// Local unit/static checks only; no real Telegram session or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {transform} from 'esbuild';
const source=await fs.readFile(new URL('./superfind-preview.jsx',import.meta.url),'utf8');
const app=await fs.readFile(new URL('./app.jsx',import.meta.url),'utf8');
// Compile the actual component, with only the CSS side-effect import removed
// for the Node-only runner. Hooks never execute in these handshake tests.
const compiled=await transform(source.replace("import './superfind-preview.css';",''),{loader:'jsx',format:'cjs',target:'es2020'});
const module={exports:{}},require=createRequire(import.meta.url);
vm.runInNewContext(compiled.code,{module,exports:module.exports,require});
const {acceptsSuperfindHandshake}=module.exports;
test('owner preview forwards only an exact same-origin child handshake',()=>{
  const child={},origin='https://local-preview.invalid',event={origin,source:child,data:{type:'style-ready'}};
  assert.equal(acceptsSuperfindHandshake(event,child,origin),true);
  for(const changed of [{...event,origin:'https://other.invalid'},{...event,source:{}},{...event,source:null},{...event,data:{type:'other'}},{...event,data:null}])assert.equal(acceptsSuperfindHandshake(changed,child,origin),false);
  assert.equal(acceptsSuperfindHandshake({...event,source:null},null,origin),false);
});
test('owner feature is strictly off without the separate server feature flag',()=>{
  assert.match(app,/const superfindPreviewEnabled=globalThis\.__WB_SUPERFIND_PREVIEW__===true/);
  assert.match(app,/\.\.\.\(superfindPreviewEnabled\?\[\['superfind'/);
  assert.match(app,/superfindPreviewEnabled&&screen==='superfind'/);
  assert.match(app,/React\.lazy\(\(\)=>import\('\.\/superfind-preview\.jsx'\)\)/);
  assert.match(source,/const enabled=globalThis\.__WB_SUPERFIND_PREVIEW__===true/);
  assert.match(source,/if\(!enabled\)return null/);
});
test('preview has no duplicate settings controls, auth persistence or send action',()=>{
  assert.match(source,/src="\/superfind"/);assert.match(source,/postMessage\(\{type:'style-init',initData\},location\.origin\)/);
  assert.doesNotMatch(source,/(localStorage|sessionStorage|console\.|fetch\(|client\.api|sendPhoto|sendMessage|<input|<form)/);
  assert.doesNotMatch(source,/postMessage\([^\n]*['"]\*['"]/);
  assert.match(source,/Одобрение не отправляет пост/);
});
