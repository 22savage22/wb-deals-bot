import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildPriceIntegrityOnly,PRICE_INTEGRITY_BASE,PRICE_INTEGRITY_PATCH_SHA256,PRICE_INTEGRITY_PATHS,PRICE_INTEGRITY_FIXTURE_PATHS,PRICE_INTEGRITY_FIXTURE_PATCH_SHA256} from './prepare_price_integrity_only.mjs';

test('release preparation rejects missing/source/outside outputs before extraction',()=>{
 for(const outDir of [undefined,'','miniapp','../outside','.test-temp','.test-temp/../miniapp'])assert.throws(()=>buildPriceIntegrityOnly({outDir}),/PRICE_RELEASE_OUTPUT_/);
 for(const includeFixtureCorrections of [null,0,1,'true',{},[]])assert.throws(()=>buildPriceIntegrityOnly({outDir:'.test-temp/invalid-fixture-option',includeFixtureCorrections}),/PRICE_RELEASE_FIXTURE_OPTION_INVALID/);
});

test('exact main plus price-only patch is reproducible and cannot overwrite its result',{timeout:30000},()=>{
 const outDir='.test-temp/price-integrity-builder-'+process.pid+'-'+Date.now(),result=buildPriceIntegrityOnly({outDir});
 assert.equal(result.base,PRICE_INTEGRITY_BASE);assert.equal(result.patch_sha256,PRICE_INTEGRITY_PATCH_SHA256);assert.deepEqual(result.diff_paths,PRICE_INTEGRITY_PATHS);assert.equal(result.production_changed,false);
 assert.equal(result.fixture_corrections_included,false);assert.equal(result.fixture_patch_sha256,null);assert.deepEqual(result.fixture_diff_paths,[]);
 assert.doesNotMatch(readFileSync(resolve(result.outDir,'miniapp/cloudflare/admin_test_support.mjs'),'utf8'),/chrtId/);
 const manifest=JSON.parse(readFileSync(new URL('./releases/price-integrity-only.manifest.json',import.meta.url)));
 for(const file of manifest.files){const data=readFileSync(resolve(result.outDir,file.path));assert.equal(createHash('sha256').update(data).digest('hex'),file.sha256);}
 assert.throws(()=>buildPriceIntegrityOnly({outDir}),/PRICE_RELEASE_OUTPUT_NOT_EMPTY/);
});

test('optional companion changes only three mock generators and preserves runtime hashes and assertions',{timeout:30000},()=>{
 const result=buildPriceIntegrityOnly({outDir:'.test-temp/price-integrity-companion-'+process.pid+'-'+Date.now(),includeFixtureCorrections:true});
 assert.equal(result.fixture_corrections_included,true);assert.equal(result.fixture_patch_sha256,PRICE_INTEGRITY_FIXTURE_PATCH_SHA256);assert.deepEqual(result.fixture_diff_paths,PRICE_INTEGRITY_FIXTURE_PATHS);
 const manifest=JSON.parse(readFileSync(new URL('./releases/price-integrity-only.manifest.json',import.meta.url)));
 for(const file of [...manifest.files,...manifest.fixture_companion.files])assert.equal(createHash('sha256').update(readFileSync(resolve(result.outDir,file.path))).digest('hex'),file.sha256);
 const assertions=text=>text.replaceAll('\r\n','\n').split('\n').filter(line=>/assert[.(]/.test(line));
 for(const path of PRICE_INTEGRITY_FIXTURE_PATHS){const original=execFileSync('git',['show',PRICE_INTEGRITY_BASE+':'+path],{encoding:'utf8'});assert.deepEqual(assertions(readFileSync(resolve(result.outDir,path),'utf8')),assertions(original));}
});
