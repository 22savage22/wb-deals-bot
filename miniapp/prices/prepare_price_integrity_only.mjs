// Local release preparation only. No fetch, deploy, credentials or production I/O.
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const PRICE_INTEGRITY_BASE='524fbe8931b911e4c3bc4e05de7caf5003b1decc';
export const PRICE_INTEGRITY_PATCH_SHA256='cb0361b8b6c8523d983251045677a51a2448d3d8b47ff62afc046852adcfcf33';
export const PRICE_INTEGRITY_PATHS=Object.freeze(['miniapp/cloudflare/native_scheduler.mjs','miniapp/prices/runtime_quote.mjs','miniapp/cloudflare/native_price_integrity_only.test.mjs']);
export const PRICE_INTEGRITY_FIXTURE_PATCH_SHA256='ca6212e70201227ee30883f29f8e48807829c59ab2d6913dcf812cb1f00c1e22';
export const PRICE_INTEGRITY_FIXTURE_PATHS=Object.freeze(['miniapp/cloudflare/admin_test_support.mjs','miniapp/cloudflare/native_scheduler.test.mjs','miniapp/cloudflare/read_optimization.test.mjs']);
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function buildPriceIntegrityOnly({outDir,includeFixtureCorrections=false}={}){
  if(typeof includeFixtureCorrections!=='boolean')fail('PRICE_RELEASE_FIXTURE_OPTION_INVALID');
  if(typeof outDir!=='string'||!outDir.trim())fail('PRICE_RELEASE_OUTPUT_REQUIRED');
  const temp=resolve(root,'.test-temp'),target=resolve(root,outDir),rel=relative(temp,target);
  if(!rel||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))fail('PRICE_RELEASE_OUTPUT_OUTSIDE_TEST_TEMP');
  // Refuse symlink/junction parents and existing nonempty targets. Never delete.
  for(let path=target;path!==dirname(path);path=dirname(path))if(existsSync(path)&&lstatSync(path).isSymbolicLink())fail('PRICE_RELEASE_OUTPUT_LINK');
  if(existsSync(target)&&readdirSync(target).length)fail('PRICE_RELEASE_OUTPUT_NOT_EMPTY');
  const manifestPath=resolve(root,'miniapp/prices/releases/price-integrity-only.manifest.json');
  const patchPath=resolve(root,'miniapp/prices/releases/price-integrity-only.patch'),patch=readFileSync(patchPath),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.base?.sha!==PRICE_INTEGRITY_BASE||manifest.patch_sha256!==PRICE_INTEGRITY_PATCH_SHA256||sha256(patch)!==PRICE_INTEGRITY_PATCH_SHA256)fail('PRICE_RELEASE_MANIFEST_MISMATCH');
  if(!same(manifest.diff_paths,PRICE_INTEGRITY_PATHS)||!same(manifest.files?.map(v=>v.path),PRICE_INTEGRITY_PATHS))fail('PRICE_RELEASE_ALLOWLIST_MISMATCH');
  const git=(...args)=>execFileSync('git',['-c','core.autocrlf=false',...args],{cwd:root,maxBuffer:128*1024*1024});
  const found=git('rev-parse',PRICE_INTEGRITY_BASE+'^{commit}').toString().trim();if(found!==PRICE_INTEGRITY_BASE)fail('PRICE_RELEASE_BASE_UNAVAILABLE');
  const stats=git('apply','--numstat',patchPath).toString().trim().split(/\r?\n/).map(line=>line.split('\t')[2]);
  if(!same(stats,PRICE_INTEGRITY_PATHS))fail('PRICE_RELEASE_PATCH_PATHS_MISMATCH');
  let fixturePatchPath,fixtureFiles=[];
  if(includeFixtureCorrections){
    const f=manifest.fixture_companion;
    if(f?.path!=='miniapp/prices/releases/price-integrity-fixtures.patch'||f.sha256!==PRICE_INTEGRITY_FIXTURE_PATCH_SHA256||f.default_enabled!==false||f.assertions_changed!==false||f.runtime_changed!==false)fail('PRICE_RELEASE_FIXTURE_MANIFEST_MISMATCH');
    if(!same(f.diff_paths,PRICE_INTEGRITY_FIXTURE_PATHS)||!same(f.files?.map(v=>v.path),PRICE_INTEGRITY_FIXTURE_PATHS))fail('PRICE_RELEASE_FIXTURE_ALLOWLIST_MISMATCH');
    fixturePatchPath=resolve(root,f.path);fixtureFiles=f.files;
    if(sha256(readFileSync(fixturePatchPath))!==PRICE_INTEGRITY_FIXTURE_PATCH_SHA256)fail('PRICE_RELEASE_FIXTURE_HASH_MISMATCH');
    const paths=git('apply','--numstat',fixturePatchPath).toString().trim().split(/\r?\n/).map(line=>line.split('\t')[2]);
    if(!same(paths,PRICE_INTEGRITY_FIXTURE_PATHS))fail('PRICE_RELEASE_FIXTURE_PATCH_PATHS_MISMATCH');
  }
  mkdirSync(target,{recursive:true});
  const realTemp=realpathSync(temp),realTarget=realpathSync(target),realRel=relative(realTemp,realTarget);
  if(!realRel||realRel==='..'||realRel.startsWith('..\\')||realRel.startsWith('../')||isAbsolute(realRel))fail('PRICE_RELEASE_RESOLVED_OUTPUT_OUTSIDE_TEST_TEMP');
  const archive=git('archive','--format=tar',PRICE_INTEGRITY_BASE);
  execFileSync('tar',['-xf','-','-C',target],{cwd:root,input:archive,maxBuffer:128*1024*1024});
  const outputPrefix=relative(root,target).replaceAll('\\','/');
  git('apply','--check','--directory='+outputPrefix,patchPath);
  git('apply','--directory='+outputPrefix,patchPath);
  if(fixturePatchPath){git('apply','--check','--directory='+outputPrefix,fixturePatchPath);git('apply','--directory='+outputPrefix,fixturePatchPath);}
  for(const file of [...manifest.files,...fixtureFiles])if(sha256(readFileSync(resolve(target,file.path)))!==file.sha256)fail('PRICE_RELEASE_FILE_HASH_MISMATCH');
  return {base:PRICE_INTEGRITY_BASE,patch_sha256:PRICE_INTEGRITY_PATCH_SHA256,diff_paths:[...PRICE_INTEGRITY_PATHS],fixture_corrections_included:includeFixtureCorrections,fixture_patch_sha256:includeFixtureCorrections?PRICE_INTEGRITY_FIXTURE_PATCH_SHA256:null,fixture_diff_paths:includeFixtureCorrections?[...PRICE_INTEGRITY_FIXTURE_PATHS]:[],outDir:target,production_changed:false};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length>4||process.argv[3]&&process.argv[3]!=='--include-fixture-corrections')fail('PRICE_RELEASE_CLI_ARGUMENT_INVALID');
  const result=buildPriceIntegrityOnly({outDir:process.argv[2],includeFixtureCorrections:process.argv[3]==='--include-fixture-corrections'});console.log(JSON.stringify(result,null,2));
}
