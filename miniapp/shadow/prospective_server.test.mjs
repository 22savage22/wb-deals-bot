// Mock fixtures in a separate local directory, never the real human test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createGalleryServer} from './gallery_server.mjs';
import {createExperiment} from './prospective_experiment.mjs';
const base=fileURLToPath(new URL('../../.test-temp/shadow-prospective-tests/',import.meta.url));
async function fixture(){
  await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'case-'));
  const oldDir=path.join(dir,'old'),newDir=path.join(dir,'new');await fs.mkdir(path.join(oldDir,'photos'),{recursive:true});await fs.mkdir(path.join(newDir,'photos'),{recursive:true});
  const at=Date.now(),products=[];
  for(let i=0;i<20;i++){const id=101+i,bytes=Buffer.from('RIFF unit-fixture WEBP '+id),hash=createHash('sha256').update(bytes).digest('hex');
    products.push({id,name:'Unique unit '+id,category:['Футболки','Сумки','Кроссовки','Платья','Серьги'][i%5],categoryVerified:true,type:'unknown',price:200,rating:4.8,reviews:null,available:null,observedAt:at-86400000*8,priceSource:'legacy_snapshot',imageHash:hash,photoVerifiedAt:at,localPhoto:'photos/'+id+'.webp'});await fs.writeFile(path.join(newDir,'photos',id+'.webp'),bytes);}
  const reportPath=path.join(oldDir,'report.json'),newPath=path.join(newDir,'report.json'),statePath=path.join(dir,'ratings.json'),experimentPath=path.join(dir,'experiment.json');
  const input={version:1,ratings:[],audience:[],localRevision:0};await fs.writeFile(reportPath,JSON.stringify({products:[],audienceSignals:[]}));await fs.writeFile(statePath,JSON.stringify(input));await fs.writeFile(newPath,JSON.stringify({products}));
  const experiment=createExperiment(products,input,{id:'test-offline-fixture',now:at});await fs.writeFile(experimentPath,JSON.stringify(experiment));
  const options={reportPath,statePath,visualPath:path.join(dir,'missing-visual.json'),priceCheckPath:path.join(dir,'missing-price.json'),prospectiveReportPath:newPath,prospectiveStatePath:experimentPath,port:0};
  const server=await createGalleryServer(options),url=`http://127.0.0.1:${server.address().port}`;
  const get=profile=>fetch(url+'/api/prospective?profile='+profile).then(r=>r.json());const initial=await get('owner');
  const vote=(data,headers={})=>fetch(url+'/api/prospective/rate',{method:'POST',headers:{'content-type':'application/json',origin:url,'X-Shadow-CSRF':initial.csrf,...headers},body:JSON.stringify({experimentId:experiment.id,profile:'owner',id:101,action:'like',revision:0,requestId:'unit-request-1',...data})});
  return {server,url,get,vote,options,dir,statePath,experimentPath,newPath};
}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
test('prospective GET withholds frozen ranks/training/other profile and never writes ratings',async()=>{
  const f=await fixture();try{const before=await fs.readFile(f.experimentPath,'utf8'),training=await fs.readFile(f.statePath,'utf8');
    for(const profile of ['owner','wife']){const x=await f.get(profile);assert.equal(x.products.length,20);assert.equal(x.summary.profiles[profile].rated,0);assert.equal(x.summary.profiles[profile].results,null);assert.equal(x.summary.profiles[profile==='owner'?'wife':'owner'],undefined);assert.equal(x.frozen,undefined);assert.doesNotMatch(JSON.stringify(x),/reviewScore|matchedFeatures|trainingState/);const html=await fetch(f.url+'/prospective/'+profile).then(r=>r.text());assert.match(html,/СЛЕПАЯ ПРОВЕРКА/);}
    assert.equal(await fs.readFile(f.experimentPath,'utf8'),before);assert.equal(await fs.readFile(f.statePath,'utf8'),training);
  }finally{await close(f.server);}
});
test('prospective duplicate request/revision/CSRF isolate test votes and survive restart',async()=>{
  const f=await fixture();try{const training=await fs.readFile(f.statePath,'utf8');const results=await Promise.all([f.vote({}),f.vote({})]);assert.ok(results.every(r=>r.status===200));
    const x=await f.get('owner');assert.equal(x.experiment.revision,1);assert.equal(x.summary.profiles.owner.rated,1);assert.equal((await f.get('wife')).summary.profiles.wife.rated,0);
    assert.equal((await f.vote({action:'dislike',requestId:'new-stale'})).status,409);
    assert.equal((await f.vote({revision:1,requestId:'bad-origin'},{origin:'https://example.com'})).status,403);
    assert.equal((await f.vote({revision:1,profile:'audience',requestId:'bad-profile'})).status,400);
    assert.equal(await fs.readFile(f.statePath,'utf8'),training);
    await close(f.server);const restarted=await createGalleryServer(f.options);try{const y=await fetch(`http://127.0.0.1:${restarted.address().port}/api/prospective?profile=owner`).then(r=>r.json());assert.equal(y.experiment.revision,1);assert.deepEqual(y.summary.profiles.owner.ratings,[{id:101,action:'like'}]);assert.equal(y.summary.profiles.owner.results,null);}finally{await close(restarted);}
  }finally{if(f.server.listening)await close(f.server);}
});
test('prospective photo pin rejects tampering before accepting a test rating',async()=>{
  const f=await fixture();try{await fs.writeFile(path.join(path.dirname(f.newPath),'photos/101.webp'),'tampered');assert.equal((await fetch(f.url+'/prospective/photos/101.webp')).status,400);assert.equal((await f.vote({})).status,400);assert.equal((await f.get('owner')).summary.profiles.owner.rated,0);assert.equal((await fetch(f.url+'/prospective/photos/1.webp')).status,404);}finally{await close(f.server);}
});

test('neither profile can reveal ranks until both finish; first blind results persist after undo and restart',async()=>{
  const f=await fixture();try{
    const training=await fs.readFile(f.statePath,'utf8');let revision=0;
    for(const profile of ['owner','wife']){
      for(let i=0;i<20;i++){
        const response=await f.vote({profile,id:101+i,action:i%2?'like':'dislike',revision,requestId:`completion-${profile}-${i}`});
        assert.equal(response.status,200);const payload=await response.json();revision=payload.experiment.revision;
        if(profile==='owner'||i<19){assert.equal(payload.comparisonReady,false);assert.equal(payload.summary.profiles[profile].firstResults,null);assert.equal(payload.summary.profiles[profile].results,null);assert.doesNotMatch(JSON.stringify(payload),/reviewScore|matchedFeatures|trainingState/);}
      }
      if(profile==='owner'){
        const own=await f.get('owner');assert.equal(own.summary.profiles.owner.complete,true);assert.ok(own.summary.profiles.owner.firstCompletedAt);assert.equal(own.summary.profiles.owner.firstResults,null);assert.equal(own.comparisonReady,false);
        assert.equal((await f.get('wife')).summary.profiles.wife.rated,0);
        assert.ok(JSON.parse(await fs.readFile(f.experimentPath,'utf8')).completion.owner.firstResults);
      }
    }
    const owner=await f.get('owner'),wife=await f.get('wife');assert.equal(owner.comparisonReady,true);assert.equal(wife.comparisonReady,true);assert.equal(owner.summary.profiles.wife,undefined);assert.equal(wife.summary.profiles.owner,undefined);
    const first=owner.summary.profiles.owner.firstResults;assert.ok(first);assert.equal(first.trainingFeedbackAdded,0);assert.equal(first.causalUplift,null);
    const undo=await f.vote({id:101,action:'undo',revision,requestId:'completion-undo'});assert.equal(undo.status,200);
    const after=await undo.json();assert.equal(after.comparisonReady,true);assert.equal(after.summary.profiles.owner.results,null);assert.deepEqual(after.summary.profiles.owner.firstResults,first);assert.equal(after.summary.profiles.owner.evaluationCorrections,1);
    assert.equal(await fs.readFile(f.statePath,'utf8'),training);
    await close(f.server);const restarted=await createGalleryServer(f.options);try{
      const saved=await fetch(`http://127.0.0.1:${restarted.address().port}/api/prospective?profile=owner`).then(r=>r.json());assert.equal(saved.comparisonReady,true);assert.deepEqual(saved.summary.profiles.owner.firstResults,first);assert.equal(saved.summary.profiles.owner.evaluationCorrections,1);
    }finally{await close(restarted);}
  }finally{if(f.server.listening)await close(f.server);}
});
test('missing experiment is a clear blocker, not automatic defaults or a new training write',async()=>{
  const f=await fixture();try{await close(f.server);const missing=path.join(f.dir,'never-created.json'),server=await createGalleryServer({...f.options,prospectiveStatePath:missing});try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/prospective?profile=owner`);assert.equal(r.status,503);assert.equal((await r.json()).error,'PROSPECTIVE_NOT_PREPARED');await assert.rejects(()=>fs.stat(missing),{code:'ENOENT'});}finally{await close(server);}}finally{if(f.server.listening)await close(f.server);}
});
