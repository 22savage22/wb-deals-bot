// Unit-fixture ratings only. No actual user-vote files or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTasteInput,buildTasteReport,trustedTraitsForProduct} from './taste_report.mjs';
const NOW=Date.parse('2026-10-11T12:00:00Z');
const card=(id,patch={})=>({id,name:`Реальная тестовая модель ${id}`,category:'Футболки',categoryVerified:true,price:650,observedAt:NOW-5000,imageHash:id.toString(16).padStart(64,'0'),...patch});
const vote=(nmId,action='like',profile='owner',patch={})=>({profile,participant_id:'local-'+profile,nmId,action,ts:NOW-1000,...patch});
const catalog=Array.from({length:10},(_,index)=>card(index+1));
const visual=id=>({nmId:id,imageHash:card(id).imageHash,reviewed:true,cacheVerified:true,group:'apparel',fields:{color:{value:'black',confidence:.9,evidence:'Reviewed black fabric in the exact image'},style:{value:'casual',confidence:.9,evidence:'Explicitly reviewed casual visible garment'}}});

test('version2 export and version1 server snapshot normalize to the same votes',()=>{
  const ratings=[vote(1),vote(2,'more'),vote(3,'dislike','wife')];
  const a=normalizeTasteInput({version:2,ratings,profiles:{owner:{preferred:['invented']}}},{products:catalog,now:NOW}),b=normalizeTasteInput({version:1,ratings,audience:[],updatedAt:NOW},{products:catalog,now:NOW});
  assert.deepEqual(a.state.ratings,b.state.ratings);assert.equal(a.validation.activeFashion,3);assert.equal(a.validation.clientComputedFieldsIgnored,true);
  assert.deepEqual(a.state.ratings[0].features,{'category=Футболки':1,'budget=600–1000 ₽':1});
});

test('exported features/profiles and raw product claims cannot invent preferences',()=>{
  const rows=Array.from({length:5},(_,i)=>vote(i+1,'like','owner',{features:{'visual.style=classic':1,'category=Сумки':100},product:{name:'fake',category:'Сумки'}}));
  const report=buildTasteReport({version:2,ratings:rows,profiles:{owner:{configured:true,unknown:[],preferred:['classic']}}},catalog,{now:NOW});
  assert.ok(report.profiles.owner.unknown.includes('style'));assert.deepEqual(report.profiles.owner.visualEvidence,[]);assert.equal(report.profiles.owner.categoryEvidence[0].category,'Футболки');
});

test('strict profiles/participants/actions/numeric nmId/timestamps reject malformed rows safely',()=>{
  const ratings=[vote(1),null,vote(2,'like','audience'),vote(3,'like','owner',{participant_id:'123456789'}),vote(4,'undo'),vote('5'),vote(6,'like','owner',{ts:NOW+1}),vote(7,'like','owner',{ts:'123'})];
  const result=normalizeTasteInput({version:2,ratings},{products:catalog,now:NOW});
  assert.equal(result.validation.invalidRows,7);assert.equal(result.state.ratings.length,1);assert.deepEqual(result.state.ratings.map(row=>row.nmId),[1]);
  assert.throws(()=>normalizeTasteInput({version:3,ratings:[]},{products:catalog,now:NOW}),/INVALID_INPUT/);assert.throws(()=>normalizeTasteInput('{bad json',{products:catalog,now:NOW}),/INVALID_JSON/);
});

test('repeated rating is one vote, chronological switch replaces, ambiguous equal-time switch omitted',()=>{
  const rows=[vote(1),vote(1),vote(2,'like'),vote(2,'dislike','owner',{ts:NOW-500}),vote(3,'like'),vote(3,'dislike')];
  const result=normalizeTasteInput({version:2,ratings:rows},{products:catalog,now:NOW});
  assert.equal(result.validation.duplicateRows,3);assert.equal(result.validation.ambiguousKeys,1);assert.equal(result.state.ratings.length,2);assert.equal(result.state.ratings.find(row=>row.nmId===2).action,'dislike');assert.ok(!result.state.ratings.some(row=>row.nmId===3));
});

test('non-fashion, missing metadata and expired votes are archived without training or raw fields',()=>{
  const products=[...catalog,card(20,{name:'Книга о моде',category:'Книги'}),card(21,{categoryVerified:false})];
  const result=normalizeTasteInput({version:1,ratings:[vote(1),vote(20,'dislike'),vote(21),vote(50),vote(2,'more','wife',{ts:NOW-100*86400000,features:{secret:'never retained'}})],audience:[]},{products,now:NOW});
  assert.equal(result.state.ratings.length,1);assert.equal(result.archive.length,4);assert.equal(result.validation.archived,4);assert.ok(result.archive.every(row=>!Object.hasOwn(row,'features')));
  const again=normalizeTasteInput(result.state,{products,now:NOW});assert.equal(again.archive.length,4);assert.equal(again.state.ratings.length,1);
});

test('owner/wife report exact four action counts and actual item identities separately',()=>{
  const ratings=[vote(1,'like'),vote(2,'more'),vote(3,'dislike'),vote(4,'block_similar'),vote(5,'like','wife')];
  const report=buildTasteReport({version:2,ratings},catalog,{now:NOW});
  assert.deepEqual(report.counts.owner,{like:1,dislike:1,more:1,block_similar:1,positive:2,negative:2,total:4});assert.equal(report.counts.wife.total,1);assert.equal(report.counts.totalActive,5);
  assert.deepEqual(report.profiles.owner.likedItems.map(row=>[row.nmId,row.action]),[[1,'like'],[2,'more']]);assert.equal(report.profiles.owner.likedItems[0].name,catalog[0].name);assert.equal(report.profiles.owner.dislikedItems[1].category,'Футболки');
});

test('category conclusions require three items/category AND five items/profile',()=>{
  const products=[...catalog.slice(0,3),card(4,{category:'Сумки'}),card(5,{category:'Платья'})];
  const few=buildTasteReport({version:2,ratings:[vote(1),vote(2),vote(3)]},products,{now:NOW});assert.equal(few.profiles.owner.categoryEvidence[0].sufficient,false);assert.equal(few.profiles.owner.categoryEvidence[0].preference,null);
  const enough=buildTasteReport({version:2,ratings:products.map(row=>vote(row.id))},products,{now:NOW});assert.equal(enough.profiles.owner.categoryEvidence.find(row=>row.category==='Футболки').sufficient,true);assert.ok(enough.profiles.owner.categoryEvidence.filter(row=>row.category!=='Футболки').every(row=>!row.sufficient));
});

test('shared/different taste uses only rated overlap and distinguishes agreement direction',()=>{
  const ratings=[vote(1,'like'),vote(1,'more','wife'),vote(2,'dislike'),vote(2,'block_similar','wife'),vote(3,'more'),vote(3,'dislike','wife'),vote(4),vote(5,'like','wife')];
  const report=buildTasteReport({version:2,ratings},catalog,{now:NOW});assert.equal(report.common.ratedByBoth,3);assert.deepEqual(report.common.liked.map(row=>row.nmId),[1]);assert.deepEqual(report.common.disliked.map(row=>row.nmId),[2]);assert.deepEqual(report.differences.map(row=>row.nmId),[3]);assert.deepEqual(report.common.categories,[]);
});

test('visual traits require explicit review plus exact same photo hash and valid field confidence',()=>{
  const ratings=Array.from({length:5},(_,i)=>vote(i+1)),good=Object.fromEntries(ratings.map(row=>[row.nmId,visual(row.nmId)]));
  const accepted=buildTasteReport({version:2,ratings},catalog,{now:NOW,traitsById:good});assert.ok(accepted.profiles.owner.visualEvidence.some(row=>row.key==='visual.style=casual'));assert.ok(!accepted.profiles.owner.unknown.includes('style'));
  for(const patch of [{reviewed:false},{cacheVerified:false},{imageHash:'f'.repeat(64)},{nmId:999}]){const bad=Object.fromEntries(ratings.map(row=>[row.nmId,{...visual(row.nmId),...patch}]));const rejected=buildTasteReport({version:2,ratings},catalog,{now:NOW,traitsById:bad});assert.deepEqual(rejected.profiles.owner.visualEvidence,[]);assert.ok(rejected.profiles.owner.unknown.includes('style'));}
});

test('same trusted trait guard is reusable for candidates and does not promote hypotheses',()=>{
  const profile=visual(1);profile.fields.style.hypothesis=true;
  const before=JSON.stringify(profile),safe=trustedTraitsForProduct(card(1),new Map([[1,profile]]));
  assert.equal(safe.fields.style,undefined);assert.equal(safe.fields.color.value,'black');assert.equal(JSON.stringify(profile),before);
  assert.equal(trustedTraitsForProduct(card(2),new Map([[2,profile]])),null);assert.equal(trustedTraitsForProduct(null),null);
  const ratings=Array.from({length:5},(_,i)=>vote(i+1)),hypotheses=Object.fromEntries(ratings.map(row=>{const value=visual(row.nmId);value.fields.style.hypothesis=true;return [row.nmId,value];}));
  const report=buildTasteReport({version:2,ratings},catalog,{now:NOW,traitsById:hypotheses});
  assert.ok(report.profiles.owner.unknown.includes('style'));assert.ok(report.profiles.owner.visualEvidence.some(row=>row.key==='visual.color=black'));
});

test('visual report displays opposed groups separately instead of a pooled zero-color preference',()=>{
  const ratings=Array.from({length:6},(_,i)=>vote(i+1,i<3?'like':'dislike'));
  const traitsById=Object.fromEntries(ratings.map(row=>{const profile=visual(row.nmId);profile.group=row.nmId<=3?'apparel':'shoes';delete profile.fields.style;return [row.nmId,profile];}));
  const report=buildTasteReport({version:2,ratings},catalog,{now:NOW,traitsById});
  const evidence=report.profiles.owner.visualEvidence;
  assert.equal(evidence.length,2);
  assert.deepEqual(evidence.map(row=>[row.key,row.group,row.products,row.preference,row.nmIds]),[['visual.color=black','apparel',3,.4286,[1,2,3]],['visual.color=black','shoes',3,-.4286,[4,5,6]]]);
  assert.ok(evidence[0].label.endsWith('(одежда)'));assert.ok(evidence[1].label.endsWith('(обувь)'));
  assert.deepEqual(report.profiles.owner.preferredLabels,[evidence[0].label]);assert.deepEqual(report.profiles.owner.avoidedLabels,[evidence[1].label]);
  assert.ok(report.profiles.owner.unknown.includes('style'));assert.deepEqual(report.profiles.wife.visualEvidence,[]);
});

test('report does not display pooled cross-group evidence below each group minimum',()=>{
  const ratings=Array.from({length:5},(_,i)=>vote(i+1)),groups=['shoes','shoes','bag','apparel','accessory'];
  const traitsById=Object.fromEntries(ratings.map((row,index)=>{const profile=visual(row.nmId);profile.group=groups[index];delete profile.fields.style;return [row.nmId,profile];}));
  const report=buildTasteReport({version:2,ratings},catalog,{now:NOW,traitsById});
  assert.deepEqual(report.profiles.owner.visualEvidence,[]);assert.ok(report.profiles.owner.unknown.includes('color'));
  assert.ok(report.profiles.owner.preferredLabels.every(label=>!label.includes('Цвет')));
});

test('report never learns categories from unverified or absent canonical metadata flags',()=>{
  for(const categoryVerified of [false,undefined]){
    const products=catalog.map(row=>({...row,categoryVerified,historicalTopic:'Футболки'}));
    const report=buildTasteReport({version:2,ratings:products.map(row=>vote(row.id))},products,{now:NOW});
    assert.equal(report.counts.totalActive,0);assert.equal(report.counts.archived,products.length);
    assert.deepEqual(report.profiles.owner.categoryEvidence,[]);assert.ok(report.profiles.owner.unknown.includes('category'));
  }
});

test('trusted input/profile snapshots stay unchanged and no I/O is invoked',()=>{
  const input={version:2,ratings:[vote(1,'like','owner',{features:{'visual.style=retro':1}})]};const before=JSON.stringify(input),productsBefore=JSON.stringify(catalog),fetchBefore=globalThis.fetch;globalThis.fetch=()=>{throw Error('MUST_NOT_FETCH');};
  try{buildTasteReport(input,catalog,{now:NOW});assert.equal(JSON.stringify(input),before);assert.equal(JSON.stringify(catalog),productsBefore);}finally{globalThis.fetch=fetchBefore;}
});

test('input and personal storage bounds are explicit, excess valid votes remain in archive',()=>{
  const products=Array.from({length:101},(_,i)=>card(i+1));const result=normalizeTasteInput({version:2,ratings:products.map(row=>vote(row.id))},{products,now:NOW});assert.equal(result.state.ratings.length,100);assert.equal(result.archive.length,1);assert.equal(result.archive[0].reason,'PERSONAL_RECORD_LIMIT');
  assert.throws(()=>normalizeTasteInput({version:2,ratings:Array(1001).fill(vote(1))},{products,now:NOW}),/INPUT_TOO_LARGE/);
});
