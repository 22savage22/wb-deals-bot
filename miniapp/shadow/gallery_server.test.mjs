// Local integration fixtures only; NEVER send synthetic feedback to production.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createGalleryServer} from './gallery_server.mjs';
import {createTasteState,setTasteRating} from './taste.mjs';
const base=fileURLToPath(new URL('../../.test-temp/shadow-gallery-tests/',import.meta.url));
async function fixture(options={}){
  await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'case-'));await fs.mkdir(path.join(dir,'photos'));
  const bytes=Buffer.from('RIFF fixture WEBP public-unit-test-not-real-photo');const hash=createHash('sha256').update(bytes).digest('hex');
  const products=Array.from({length:7},(_,i)=>({id:i+1,name:'Unit fixture '+i,price:200,rating:4.8,reviews:100,category:i<5?'Футболки':i===5?'Сумки':'Книги',categoryVerified:true,type:'unknown',available:null,priceSource:'legacy_snapshot',observedAt:Date.now(),imageHash:hash,localPhoto:'photos/'+(i+1)+'.webp'}));
  for(const p of products)await fs.writeFile(path.join(dir,'photos',p.id+'.webp'),bytes);
  const reportPath=path.join(dir,'report.json'),statePath=path.join(dir,'ratings.json');await fs.writeFile(reportPath,JSON.stringify({products,calibrationIds:products.map(p=>p.id),comparison:{selected:[]},audienceSignals:[]}));
  const server=await createGalleryServer({reportPath,statePath,port:0,...options}),url=`http://127.0.0.1:${server.address().port}`;
  const get=()=>fetch(url+'/api/state').then(r=>r.json());const info=await get();
  const rate=(data,headers={})=>fetch(url+'/api/rate',{method:'POST',headers:{'content-type':'application/json','origin':url,'X-Shadow-CSRF':info.csrf,...headers},body:JSON.stringify(data)});
  return {server,url,get,rate,dir,statePath,reportPath};
}
test('opening gallery reads real state without initializing a file/settings',async()=>{const f=await fixture();try{assert.equal((await f.get()).ratings.length,0);await assert.rejects(()=>fs.stat(f.statePath),{code:'ENOENT'});const r=await fetch(f.url);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);assert.match(await r.text(),/НЕЗАВИСИМЫЙ SHADOW/);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});
test('double clicks/switch/undo persist exactly one rating; restart retains results',async()=>{const f=await fixture();try{const results=await Promise.all([f.rate({profile:'owner',id:1,action:'like'}),f.rate({profile:'owner',id:1,action:'like'})]);assert.ok(results.every(r=>r.status===200));let s=await f.get();assert.equal(s.ratings.length,1);assert.equal(s.revision,1);await f.rate({profile:'owner',id:1,action:'dislike'});await f.rate({profile:'wife',id:1,action:'more'});s=await f.get();assert.equal(s.ratings.length,2);assert.equal(s.revision,3);const disk=JSON.parse(await fs.readFile(f.statePath));assert.equal(disk.version,1);assert.equal(disk.ratings.length,2);f.server.closeAllConnections();await new Promise(r=>f.server.close(r));const second=await createGalleryServer({reportPath:f.reportPath,statePath:f.statePath,port:0});try{const s2=await fetch(`http://127.0.0.1:${second.address().port}/api/state`).then(r=>r.json());assert.deepEqual(s2.ratings,s.ratings);assert.equal(s2.revision,3);}finally{second.closeAllConnections();await new Promise(r=>second.close(r));}}finally{if(f.server.listening){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}}});
test('owner/wife ranking explanations are genuinely separated; explicit undo works',async()=>{const f=await fixture();try{for(let id=1;id<=5;id++){for(const [profile,action] of [['owner','like'],['wife','dislike']]){const response=await f.rate({profile,id,action});const receipt=await response.json();assert.equal(response.status,200,receipt.error);}}const s=await f.get();assert.equal(s.ratings.length,10);assert.ok(s.assessmentsByProfile.owner[0].taste.score>0);assert.ok(s.assessmentsByProfile.wife[0].taste.score<0);assert.equal(s.profiles.audience.sampleProducts,0);assert.equal((await f.rate({profile:'wife',id:1,action:'undo'})).status,200);assert.equal((await f.get()).ratings.length,9);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});
test('CSRF/foreign origin/arbitrary identity/client product/unknown id are denied',async()=>{const f=await fixture();try{for(const [data,headers,status] of [[{profile:'owner',id:1,action:'like'},{'X-Shadow-CSRF':'bad'},403],[{profile:'owner',id:1,action:'like'},{origin:'https://example.com'},403],[{profile:'audience',id:1,action:'like'},{},400],[{profile:'owner',id:999,action:'like'},{},400],[{profile:'owner',id:1,action:'like',product:{category:'fake'}},{},400]])assert.equal((await f.rate(data,headers)).status,status);assert.equal((await f.get()).ratings.length,0);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});
test('missing/tampered photo cannot collect ratings or serve unverified bytes',async()=>{const f=await fixture();try{await fs.writeFile(path.join(f.dir,'photos/1.webp'),'tampered');assert.equal((await f.rate({profile:'owner',id:1,action:'like'})).status,400);assert.equal((await fetch(f.url+'/photos/1.webp')).status,400);assert.equal((await f.get()).ratings.length,0);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});
test('loss of response recovers actual persisted state without repeating/inflating',async()=>{const f=await fixture();try{const r=await f.rate({profile:'owner',id:1,action:'like'});await r.body.cancel();const s=await f.get();assert.equal(s.ratings.length,1);await f.rate({profile:'owner',id:1,action:'like'});assert.equal((await f.get()).revision,1);assert.equal((await f.get()).ratings.length,1);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});
test('wall clock rollback cannot delete a just-saved rating',async()=>{let time=Date.now();const f=await fixture({clock:()=>time});try{assert.equal((await f.rate({profile:'owner',id:1,action:'like'})).status,200);time-=1000;assert.equal((await f.get()).ratings.length,1);await f.rate({profile:'wife',id:1,action:'dislike'});const s=await f.get();assert.equal(s.ratings.length,2);assert.equal(s.revision,2);}finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}});

test('non-fashion ratings stay archived on disk but cannot train style or receive new votes',async()=>{const f=await fixture();try{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));const at=Date.now(),saved=setTasteRating(createTasteState(),{profile:'owner',nmId:7,action:'more',product:{id:7,category:'Книги',categoryVerified:true}},{now:at}).state;saved.localRevision=9;const bytes=JSON.stringify(saved)+'\n';await fs.writeFile(f.statePath,bytes);const second=await createGalleryServer({reportPath:f.reportPath,statePath:f.statePath,port:0});try{const url=`http://127.0.0.1:${second.address().port}`,s=await fetch(url+'/api/state').then(r=>r.json());assert.equal(s.ratings.length,1);assert.equal(s.archiveCounts.owner,1);assert.equal(s.profiles.owner.sampleProducts,0);assert.equal(s.revision,9);assert.ok(!s.compareByProfile.owner.candidateIds.includes(7));assert.equal(await fs.readFile(f.statePath,'utf8'),bytes);const r=await fetch(url+'/api/rate',{method:'POST',headers:{'content-type':'application/json',origin:url,'X-Shadow-CSRF':s.csrf},body:JSON.stringify({profile:'owner',id:7,action:'like'})});assert.equal(r.status,400);assert.equal(await fs.readFile(f.statePath,'utf8'),bytes);}finally{second.closeAllConnections();await new Promise(r=>second.close(r));}}finally{if(f.server.listening){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}}});

test('derived report/results repeated GETs preserve votes byte-for-byte and isolate both profiles',async()=>{
  const f=await fixture();try{
    await f.rate({profile:'owner',id:1,action:'like'});await f.rate({profile:'wife',id:1,action:'dislike'});
    const before=await fs.readFile(f.statePath,'utf8'),first=await f.get(),second=await f.get();
    assert.equal(await fs.readFile(f.statePath,'utf8'),before);assert.equal(first.revision,second.revision);
    assert.equal(first.tasteReport.profiles.owner.counts.like,1);assert.equal(first.tasteReport.profiles.wife.counts.dislike,1);
    assert.ok(first.recommendationsByProfile.owner.newIds.includes(1));assert.ok(!first.recommendationsByProfile.wife.newIds.includes(1));
    assert.equal(first.analysis.candidateCount,6);assert.match(first.analysis.candidateHash,/^[a-f0-9]{64}$/);assert.equal(first.analysis.productionWrites,0);
    const html=await fetch(f.url).then(r=>r.text());assert.match(html,/id="results-profile"/);assert.match(html,/id="new-slate"/);assert.match(html,/id="legacy-slate"/);assert.match(html,/id="setup" hidden/);
  }finally{f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}
});

test('new reviewed manifest enriches derived report without rewriting old feature snapshots',async()=>{
  const f=await fixture();try{
    await f.rate({profile:'owner',id:1,action:'like'});const before=await fs.readFile(f.statePath,'utf8');
    f.server.closeAllConnections();await new Promise(r=>f.server.close(r));
    const p=JSON.parse(await fs.readFile(f.reportPath)).products[0],visualPath=path.join(f.dir,'reviewed.json');
    await fs.writeFile(visualPath,JSON.stringify({profiles:{1:{nmId:1,reviewed:true,cacheVerified:true,imageHash:p.imageHash,group:'apparel',fields:{color:{value:'black',confidence:.95,evidence:'Verified black photographed front'}}}}}));
    const second=await createGalleryServer({reportPath:f.reportPath,statePath:f.statePath,visualPath,port:0});
    try{const url=`http://127.0.0.1:${second.address().port}`,x=await fetch(url+'/api/state').then(r=>r.json());
      assert.equal(x.analysis.reviewedVisualProducts,1);assert.equal(x.ratings[0].features['visual.color=black'],undefined);
      assert.equal(x.profiles.owner.evidence.find(row=>row.key==='visual.color=black').products,1);
      assert.equal(await fs.readFile(f.statePath,'utf8'),before);
    }finally{second.closeAllConnections();await new Promise(r=>second.close(r));}
  }finally{if(f.server.listening){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}}
});
