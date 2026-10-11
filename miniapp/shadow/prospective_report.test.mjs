import test from 'node:test';
import assert from 'node:assert/strict';
import {previouslyRatedIds} from './prospective_report.mjs';
test('prospective photo collector excludes both profiles and archived votes',()=>{
  const input={ratings:[{profile:'owner',nmId:1},{profile:'wife',nmId:2},{profile:'wife',nmId:1}],archive:[{profile:'owner',nmId:3},{nmId:null}]};
  const before=JSON.stringify(input);assert.deepEqual([...previouslyRatedIds(input)],[1,2,3]);assert.equal(JSON.stringify(input),before);
});
test('prospective photo collector refuses missing training instead of empty exclusion',()=>{
  assert.throws(()=>previouslyRatedIds(null),/TRAINING_INVALID/);assert.throws(()=>previouslyRatedIds({}),/TRAINING_INVALID/);
});
