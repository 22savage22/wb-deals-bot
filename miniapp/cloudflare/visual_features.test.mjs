import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAnalysis,inspectAnalysis,mergeAnalyses,visualSchema,SPECIFIC,COMMON} from './visual_features.mjs';
const f=(value,confidence=.95,evidence='Visible product geometry')=>({value,confidence,evidence});

test('one unsupported category value stays unknown without poisoning independent fields',()=>{
  for(const [group,key,value] of [['apparel','neckline','off_shoulder'],['shoes','closure','buttons'],['bag','carry','handheld'],['accessory','shape','heart_shaped']]){
    const {analysis,diagnostic}=inspectAnalysis({group,view:'front',fields:{color:f('black'),pattern:f('solid'),[key]:f(value)}});
    assert.equal(analysis.fields.color.value,'black');assert.equal(analysis.fields.pattern.value,'solid');assert.equal(analysis.fields[key],undefined);
    assert.equal(diagnostic.rejected[0].field,key);assert.equal(diagnostic.rejected[0].reason,'UNSUPPORTED_VALUE');
    assert.ok(mergeAnalyses([analysis],1,'model').unknown.includes(key));
  }
});
test('never coerce arrays, naked values, extra keys or numeric/string confidence',()=>{
  for(const invalid of [[],['black'],'black',null,f(['black']),f('black','0.9'),f('black',Infinity),f('black',1.1),{...f('black'),invented:true},{value:'black',confidence:.99}]){
    const a=normalizeAnalysis({group:'bag',fields:{color:invalid,shape:f('soft')}});assert.equal(a.fields.color,undefined);assert.equal(a.fields.shape.value,'soft');
  }
});
test('closed root structure remains strict; no JSON repairs or category switch',()=>{
  for(const raw of ['{} trailing','```json\n{}\n```','{"group":"bag"','[]',{group:'apparel',fields:[]},{group:{apparel:{}},fields:{}},{group:'bag',fields:{},secret:'no'},{group:'bag',view:'perspective',fields:{}},{group:'bag',fields:Object.fromEntries(Array.from({length:13},(_,i)=>['x'+i,f('black')]))}])assert.throws(()=>normalizeAnalysis(raw));
  assert.throws(()=>normalizeAnalysis({group:'apparel',fields:{}},{expected_group:'shoes'}),/INVALID_PROFILE/);
});
test('aliases are field-specific and schema/prompt vocabulary remains closed',()=>{
  const a=normalizeAnalysis({group:'apparel',fields:{color:f('NAVY-BLUE'),fit:f('oversized'),neckline:f('crew neck'),silhouette:f('oversized'),length:f('long sleeve')}});
  assert.equal(a.fields.color.value,'navy');assert.equal(a.fields.fit.value,'oversize');assert.equal(a.fields.neckline.value,'round');assert.equal(a.fields.silhouette,undefined);assert.equal(a.fields.length,undefined);
  for(const group of Object.keys(SPECIFIC))assert.deepEqual(Object.keys(visualSchema(group).properties.fields.properties),Object.keys({...COMMON,...SPECIFIC[group]}));
});
test('unseen panels/material, guessed fit and partly solid patterned shoes remain unknown',()=>{
  for(const evidence of ['Black main body','Black upper with white logo','Main panels are black','Visible stripes on black body'])assert.equal(normalizeAnalysis({group:'shoes',fields:{pattern:f('solid',.99,evidence)}}).fields.pattern,undefined);
  const a=normalizeAnalysis({group:'apparel',view:'front',fields:{color:f('black'),fit:f('slim',.99,'Probably fitted from advertising'),material:f('cotton'),pattern:f('graphic'),print_location:f('front_and_back')}});
  const p=mergeAnalyses([a],1,'model');assert.equal(p.material,'unknown');assert.equal(p.back_print,'unknown');assert.equal(p.fields.fit,undefined);assert.equal(p.fields.print_location,undefined);
});
test('safe diagnostic never stores arbitrary response values, unknown keys or evidence',()=>{
  const {diagnostic}=inspectAnalysis({group:'apparel',fields:{color:f('Bearer do-not-store'),neckline:f('off_shoulder'),private_secret:f('secret'),fit:f('slim',.5,'some-secret-evidence')}});
  assert.doesNotMatch(JSON.stringify(diagnostic),/Bearer|do-not-store|private_secret|some-secret/);assert.equal(diagnostic.rejected[1].value_token,'off_shoulder');
});
test('inherited dictionary keys are never accepted as vocabulary fields',()=>{
  const raw='{"group":"apparel","fields":{"__proto__":{"value":"black","confidence":1,"evidence":"Unknown field"},"constructor":{"value":"black","confidence":1,"evidence":"Unknown field"},"color":{"value":"black","confidence":1,"evidence":"Black garment body"}}}';
  const a=normalizeAnalysis(raw);assert.deepEqual(Object.keys(a.fields),['color']);assert.ok(a.validation.rejected.every(r=>r.field==='unsupported_field'));
});
