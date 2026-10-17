// Controlled HTTP responses/local SQLite only. No real WB network or accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {LocalD1} from './local_d1.mjs';
import {ADAPTER_SCHEMA,ingestVerifiedProducts} from './catalogue_adapter.mjs';
import {collectNewCatalogueProducts,metadataURL,cardAudience,CATALOGUE_SOURCE_LIMITS} from './catalogue_source.mjs';
const NOW=Date.now(),INTERVAL=CATALOGUE_SOURCE_LIMITS.minIntervalMs;
const image=id=>`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`;
const bytes=new Uint8Array([82,73,70,70,24,0,0,0,87,69,66,80,86,80,56,76,11,0,0,0,47,63,0,15,0,7,208,255,254,247,191,255]);
async function fixture(count=5){
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));db.exec(await fs.readFile(new URL('../cloudflare/schema.sql',import.meta.url),'utf8'));db.exec(ADAPTER_SCHEMA);
  await db.prepare("INSERT INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind('{"products":[]}').run();
  for(let id=1;id<=count;id++)await db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({id,title:'Мужской красный старый заголовок',image:image(id),price:1,rating:4.8,checked_at:Math.floor(NOW/1000)}),Math.floor(NOW/1000)).run();
  return db;
}
const metadata=id=>({nm_id:id,imt_name:`Реальное имя из контролируемого CDN ответа ${id}`,subj_name:'Футболки',selling:{brand_name:'Fixture Brand'},options:[{name:'Пол',value:'Женский'}]});
const sourceFetcher=(calls,metadataPatch=()=>({}))=>async(url,options)=>{
  calls.push({url,options});const id=Number(new URL(url).pathname.match(/\/part[0-9]+\/([0-9]+)\//)[1]);
  if(url.endsWith('/info/ru/card.json'))return Response.json({...metadata(id),...metadataPatch(id)});
  return new Response(bytes,{headers:{'Content-Type':'image/webp'}});
};
test('defaultOFF is SQL/network-free; endpoint sources are official same-ID originals only',async()=>{
  const db=await fixture();try{db.queries=[];const r=await collectNewCatalogueProducts(db,[1]);assert.equal(r.status,'disabled');assert.equal(db.queries.length,0);
    assert.equal(metadataURL(image(1),1),'https://basket-01.wbbasket.ru/vol1/part1/1/info/ru/card.json');
    for(const bad of ['https://evil.example/1/images/big/1.webp',image(2),image(1)+'?cookie=x',image(1).replace('https:','http:'),'https://u:p@basket-01.wbbasket.ru/vol1/part1/1/images/big/1.webp'])assert.throws(()=>metadataURL(bad,1));
  }finally{db.close();}
});
test('gender comes solely from an explicit closed metadata field, never title tokens',()=>{
  assert.equal(cardAudience(metadata(1),1),'women');assert.equal(cardAudience({...metadata(1),options:[]},1),null);
  for(const value of ['детский','для всех',42])assert.equal(cardAudience({...metadata(1),options:[{name:'Пол',value}]},1),null);
  assert.equal(cardAudience({...metadata(1),options:[{name:'Пол',value:'женский; мужской'}]},1),'neutral');assert.equal(cardAudience(metadata(2),1),null);
});
test('at most3 sequential products/6GETs, no cookies/custom headers, no existing-item or disabled fetches',async()=>{
  const db=await fixture(6),calls=[];let active=0,maxActive=0;const plain=sourceFetcher(calls),fetcher=async(...args)=>{active++;maxActive=Math.max(active,maxActive);await Promise.resolve();const r=await plain(...args);active--;return r;};
  try{
    await db.prepare('UPDATE products SET overrides=? WHERE id=?').bind('{"enabled":false}',1).run();
    const r=await collectNewCatalogueProducts(db,[1,2,3,4,5,6],{enabled:true,now:NOW,fetcher});assert.equal(r.verified,3);assert.equal(r.sourceCalls,6);assert.equal(maxActive,1);assert.deepEqual(r.entries.map(e=>e.product.id),[2,3,4]);
    for(const {options} of calls){assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.deepEqual(Object.keys(options.headers),['Accept']);assert.ok(options.signal);}
    assert.equal(r.entries[0].product.audience,'women');assert.equal(r.entries[0].product.price,null);assert.equal(r.entries[0].product.available,null);assert.equal(r.entries[0].product.qualityVerified,false);assert.equal(r.aiCalls,0);
  }finally{db.close();}
});
test('controlled full chain adds previously absent nmId with verified photo and honest unknown price',async()=>{
  const db=await fixture(1),calls=[];try{
    assert.equal(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=1').get(),undefined);
    const verified=await collectNewCatalogueProducts(db,[1],{enabled:true,now:NOW,fetcher:sourceFetcher(calls)});
    const ingested=await ingestVerifiedProducts(db,verified.entries,{enabled:true,now:NOW});assert.equal(ingested.added,1);
    const p=JSON.parse(db.sqlite.prepare('SELECT data FROM feature_catalog WHERE id=1').get().data);
    assert.match(p.imageHash,/^[a-f0-9]{64}$/);assert.match(p.displayImage,/^\/style-images\/1\/[a-f0-9]{64}\.webp$/);assert.equal(p.audience,'women');assert.equal(p.audienceVerified,true);assert.equal(p.price,null);assert.equal(p.available,null);
    assert.equal(JSON.parse(db.sqlite.prepare("SELECT value FROM feature_meta WHERE key='shared_catalog_snapshot'").get().value).products.length,1);
    const again=await collectNewCatalogueProducts(db,[1],{enabled:true,now:NOW+INTERVAL,fetcher:sourceFetcher(calls)});assert.equal(again.sourceCalls,0);assert.equal(calls.length,2);
  }finally{db.close();}
});
test('429/403 stop the entire run immediately and persist jittered backoff across workers',async()=>{
  for(const status of [429,403]){
    const db=await fixture(5);let calls=0;const fetcher=async()=>{calls++;return new Response('blocked',{status,headers:{'Retry-After':'3600'}});};
    try{
      const a=await collectNewCatalogueProducts(db,[1,2,3],{enabled:true,now:NOW,fetcher,random:()=>1});assert.equal(a.status,'rate_limited');assert.equal(a.sourceCalls,1);assert.ok(a.nextAttemptAt>=NOW+3600000);assert.equal(a.entries.length,0);
      const b=await collectNewCatalogueProducts(db,[4,5],{enabled:true,now:NOW+60000,fetcher});assert.equal(b.status,'not_due_or_busy');assert.equal(calls,1);
      const c=await collectNewCatalogueProducts(db,[4,5],{enabled:true,now:a.nextAttemptAt,fetcher,random:()=>1});assert.equal(c.sourceCalls,1);assert.equal(calls,2);assert.ok(c.nextAttemptAt-a.nextAttemptAt>=INTERVAL*2);
    }finally{db.close();}
  }
});
test('one deleted card is skipped in the same run without global failure or starvation of the next item',async()=>{
  const db=await fixture(2),calls=[],ordinary=sourceFetcher(calls),fetcher=async(url,options)=>url.includes('/1/info/')?new Response('gone',{status:404}):ordinary(url,options);
  try{
    const r=await collectNewCatalogueProducts(db,[1,2],{enabled:true,now:NOW,fetcher});assert.equal(r.status,'ok');assert.equal(r.verified,1);assert.equal(r.entries[0].product.id,2);assert.equal(r.sourceCalls,3);assert.equal(r.nextAttemptAt,NOW+INTERVAL);
    const state=JSON.parse(db.sqlite.prepare("SELECT value FROM feature_meta WHERE key='style_catalogue_source_state'").get().value);assert.ok(state.rejected.some(row=>row.id===1));
  }finally{db.close();}
});
test('same global lease prevents parallel candidate bursts; the next invocation can recover stale lease',async()=>{
  const db=await fixture(2);let release,entered;const blocked=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),calls=[];
  const ordinary=sourceFetcher(calls),fetcher=async(...args)=>{entered();await blocked;return ordinary(...args);};
  try{
    const pending=collectNewCatalogueProducts(db,[1],{enabled:true,now:NOW,fetcher});await started;
    assert.equal((await collectNewCatalogueProducts(db,[2],{enabled:true,now:NOW,fetcher:ordinary})).status,'not_due_or_busy');release();assert.equal((await pending).verified,1);
    const stale={owner:'dead-worker',leaseUntil:NOW-1,nextAttemptAt:NOW-1,failures:0,rejected:[]};await db.prepare("UPDATE feature_meta SET value=? WHERE key='style_catalogue_source_state'").bind(JSON.stringify(stale)).run();
    assert.equal((await collectNewCatalogueProducts(db,[2],{enabled:true,now:NOW,fetcher:ordinary})).verified,1);
  }finally{release?.();db.close();}
});
test('oversized/invalid response, metadata mismatch and nonfashion cards are not admitted or endlessly re-probed',async()=>{
  const db=await fixture(3),calls=[];const fetcher=sourceFetcher(calls,id=>id===1?{nm_id:99}:id===2?{subj_name:'Книги'}:{});
  try{
    const r=await collectNewCatalogueProducts(db,[1,2],{enabled:true,now:NOW,fetcher});assert.equal(r.verified,0);assert.equal(r.sourceCalls,2);assert.equal(r.errors.length,2);
    const again=await collectNewCatalogueProducts(db,[1,2],{enabled:true,now:NOW+INTERVAL,fetcher});assert.equal(again.sourceCalls,0);
    const huge=async()=>new Response('tiny',{headers:{'Content-Length':String(CATALOGUE_SOURCE_LIMITS.metadataBytes+1)}});
    const tooBig=await collectNewCatalogueProducts(db,[3],{enabled:true,now:NOW+2*INTERVAL,fetcher:huge});assert.equal(tooBig.entries.length,0);assert.equal(tooBig.errors[0].code,'REQUEST_OR_RESPONSE_FAILED');assert.ok(!JSON.stringify(tooBig).includes('tiny'));
  }finally{db.close();}
});
test('malicious metadata/photo and missing explicit gender never become visual guesses',async()=>{
  const db=await fixture(2);let calls=0;const fetcher=async url=>{
    calls++;if(url.endsWith('card.json'))return Response.json({...metadata(1),options:[]});return new Response('<html>challenge</html>',{headers:{'Content-Type':'text/html'}});
  };
  try{const r=await collectNewCatalogueProducts(db,[1],{enabled:true,now:NOW,fetcher});assert.equal(calls,2);assert.equal(r.entries.length,0);assert.equal(r.errors[0].code,'PHOTO_CONTENT_TYPE');
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM feature_catalog').get().n,0);
  }finally{db.close();}
});
test('metadata and photo redirects are rejected without following a foreign Location',async()=>{
  for(const phase of ['metadata','photo']){
    const db=await fixture(1),calls=[];const ordinary=sourceFetcher(calls),fetcher=async(url,options)=>{
      assert.equal(options.redirect,'manual');
      if((phase==='metadata')===url.endsWith('card.json'))return new Response('',{status:302,headers:{Location:'https://must-not-follow.invalid/redirect'}});
      return ordinary(url,options);
    };
    try{const result=await collectNewCatalogueProducts(db,[1],{enabled:true,now:NOW,fetcher});assert.equal(result.verified,0);assert.equal(result.sourceCalls,phase==='metadata'?1:2);assert.equal(result.errors[0].status,302);assert.ok(calls.every(row=>new URL(row.url).hostname==='basket-01.wbbasket.ru'));}finally{db.close();}
  }
});
