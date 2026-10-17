// Controlled local SQLite fixtures, not live WB prices or Telegram identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {LocalD1} from './local_d1.mjs';
import {ADAPTER_SCHEMA,CATALOGUE_ADAPTER_LIMITS,refreshCatalogueFromPublic,ingestVerifiedProducts} from './catalogue_adapter.mjs';
import {stylePriceEvidence} from './subscriber_taste.mjs';
const NOW=Date.now(),INTERVAL=CATALOGUE_ADAPTER_LIMITS.minIntervalMs;
const image=id=>`https://basket-01.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`;
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
const bytes=new Uint8Array([82,73,70,70,24,0,0,0,87,69,66,80,86,80,56,76,11,0,0,0,47,63,0,15,0,7,208,255,254,247,191,255]);
const product=(id,patch={})=>({id,name:`Локальная fixture футболка товар${id}`,category:'Футболки',categoryVerified:true,
  image:image(id),displayImage:`/style-photos/${id}.webp`,imageHash:id.toString(16).padStart(64,'0'),photoVerifiedAt:NOW,
  price:800,currency:'RUB',priceSource:'wb_card',observedAt:NOW,stockObservedAt:NOW,available:true,variantKey:'size40',
  context:{currency:'RUB',destination:'-1257786',paymentBasis:'standard'},rating:4.8,reviews:100,...patch});
const visual=p=>({nmId:p.id,imageHash:p.imageHash,group:'apparel',reviewed:true,cacheVerified:true,
  fields:{color:{value:'black',confidence:1,evidence:'Black synthetic fixture image'}}});
const entry=(id,patch={})=>({product:product(id),evidence:{sourceProductId:id,categorySource:'wb_cdn_metadata',categoryObservedAt:NOW,
  priceSource:'wb_card',priceObservedAt:NOW,stockSource:'wb_card',stockObservedAt:NOW},photo:{bytes,sourceUrl:image(id),observedAt:NOW},...patch});
async function fixture(count=1){
  const db=new LocalD1();db.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  db.exec("CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT NOT NULL,overrides TEXT NOT NULL DEFAULT '{}',checked_at INTEGER NOT NULL);CREATE INDEX products_checked ON products(checked_at DESC);");
  const products=[];
  for(let id=1;id<=count;id++){
    const p=product(id),v=visual(p);products.push({product:p,visual:v});
    await db.prepare('INSERT INTO feature_catalog(id,data,visual,checked_at) VALUES(?,?,?,?)').bind(id,JSON.stringify(p),JSON.stringify(v),NOW-1000-id).run();
    await db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({id,title:p.name,image:p.image,price:900,checked_at:Math.floor(NOW/1000)}),Math.floor(NOW/1000)).run();
  }
  await db.prepare("INSERT INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind(JSON.stringify({products:products.slice(0,120)})).run();db.exec(ADAPTER_SCHEMA);
  return db;
}
const snapshot=db=>JSON.parse(db.sqlite.prepare("SELECT value FROM feature_meta WHERE key='shared_catalog_snapshot'").get().value);
test('adapter flag defaults OFF and does no SQL or external work',async()=>{
  const db=await fixture();try{db.queries=[];assert.equal((await refreshCatalogueFromPublic(db)).status,'disabled');assert.equal((await ingestVerifiedProducts(db,[entry(2)])).status,'disabled');assert.equal(db.queries.length,0);}finally{db.close();}
});
test('normalized public sync bookkeeping is never promoted into price/stock/photo proof',async()=>{
  const db=await fixture();try{
    await db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').bind(2,JSON.stringify({id:2,title:'Новый неизвестный товар',price:1,image:image(2),checked_at:Math.floor(NOW/1000)}),Math.floor(NOW/1000)).run();
    const r=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW});assert.equal(r.status,'ok');assert.equal(r.sourceFound,2);assert.equal(r.added,0);assert.equal(r.awaitingVerification,1);assert.deepEqual(r.newCandidateIds,[2]);
    const p=snapshot(db).products[0].product;assert.equal(p.price,800);assert.equal(p.observedAt,NOW);assert.equal(p.stockObservedAt,NOW);assert.equal(p.context.destination,'-1257786');
    assert.equal(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=2').get(),undefined);assert.equal(r.sourceCalls,0);assert.equal(r.aiCalls,0);
  }finally{db.close();}
});
test('missing/empty/unverified source preserves the exact prior snapshot, never wipes the queue',async()=>{
  const db=await fixture();try{
    db.exec('DELETE FROM products;');const prior=JSON.stringify(snapshot(db));const r=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW});assert.equal(r.keptExistingSnapshot,true);assert.equal(JSON.stringify(snapshot(db)),prior);
  }finally{db.close();}
});
test('unchanged public sync timestamps do not write catalogue rows; explicit disabled overrides are respected',async()=>{
  const db=await fixture();try{
    const unchanged=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW});assert.equal(unchanged.updated,0);assert.equal(unchanged.keptExistingSnapshot,true);
    await db.prepare('UPDATE products SET overrides=?,checked_at=? WHERE id=1').bind('{"enabled":false}',Math.floor(NOW/1000)+1).run();
    const changed=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+INTERVAL});assert.equal(changed.updated,1);assert.equal(snapshot(db).products[0].product.enabled,false);
  }finally{db.close();}
});
test('interval, live lease and stale lease recovery are durable, not RAM locks',async()=>{
  const db=await fixture();try{
    assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW})).status,'ok');assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+60000})).status,'not_due_or_busy');
    const state={owner:'crashed',leaseUntil:NOW+INTERVAL-1,nextAttemptAt:NOW+INTERVAL-1,failures:0};await db.prepare("UPDATE feature_meta SET value=? WHERE key='style_catalogue_adapter_state'").bind(JSON.stringify(state)).run();
    assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+INTERVAL})).status,'ok');
  }finally{db.close();}
});
test('one scheduled refresh can immediately admit independently verified new photos, but neither action bursts twice',async()=>{
  const db=await fixture();try{
    assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW})).status,'ok');
    assert.equal((await ingestVerifiedProducts(db,[entry(2)],{enabled:true,now:NOW})).added,1);
    assert.equal((await ingestVerifiedProducts(db,[entry(3)],{enabled:true,now:NOW+60000})).status,'not_due_or_busy');
    assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+60000})).status,'not_due_or_busy');
  }finally{db.close();}
});
test('source errors keep the last good snapshot and back off20 then40 minutes without leaking raw errors',async()=>{
  const db=await fixture(),prepare=db.prepare.bind(db);db.prepare=sql=>{if(sql.startsWith('SELECT id,data,overrides,checked_at FROM products'))throw Error('private-provider-error-that-must-not-leak');return prepare(sql);};
  try{
    const prior=JSON.stringify(snapshot(db)),a=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW});assert.equal(a.status,'error');assert.equal(a.nextAttemptAt,NOW+INTERVAL);assert.ok(!JSON.stringify(a).includes('private-provider-error'));
    assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+60000})).status,'not_due_or_busy');
    const b=await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+INTERVAL});assert.equal(b.nextAttemptAt,NOW+3*INTERVAL);assert.equal(JSON.stringify(snapshot(db)),prior);
    db.prepare=prepare;assert.equal((await refreshCatalogueFromPublic(db,{enabled:true,now:NOW+3*INTERVAL})).status,'ok');
  }finally{db.close();}
});
test('an expired or superseded writer cannot mutate cards OR replace snapshot with an empty aggregate',async()=>{
  const db=await fixture();try{
    const prior=JSON.stringify(snapshot(db));const r=await ingestVerifiedProducts(db,[entry(2)],{enabled:true,now:NOW,clock:()=>NOW+CATALOGUE_ADAPTER_LIMITS.leaseMs+1});
    assert.equal(r.status,'stale_lease');assert.equal(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=2').get(),undefined);assert.equal(JSON.stringify(snapshot(db)),prior);
  }finally{db.close();}
});
test('verified actual bytes create hash/addressed photo and add one genuinely new local candidate',async()=>{
  const db=await fixture();try{
    const r=await ingestVerifiedProducts(db,[entry(2)],{enabled:true,now:NOW});assert.equal(r.status,'ok');assert.equal(r.added,1);assert.equal(r.updated,0);
    const p=snapshot(db).products.find(row=>row.product.id===2).product;assert.equal(p.imageHash,await sha(bytes));assert.equal(p.displayImage,`/style-images/2/${await sha(bytes)}.webp`);assert.equal(stylePriceEvidence(p,NOW).confirmed,true);
    assert.equal(r.sourceCalls,0);assert.equal(r.aiCalls,0);assert.equal(r.freshPriceCards,2);
  }finally{db.close();}
});
test('photo-only metadata is usable for style without inventing current price, availability or historical discount',async()=>{
  const db=await fixture();try{
    const e=entry(2);e.evidence={sourceProductId:2,categorySource:'wb_cdn_metadata',categoryObservedAt:NOW};e.product.price=1;e.product.oldPrice=100000;
    const r=await ingestVerifiedProducts(db,[e],{enabled:true,now:NOW});assert.equal(r.added,1);const p=snapshot(db).products.find(row=>row.product.id===2).product;
    assert.equal(p.price,null);assert.equal(p.available,null);assert.equal(p.priceSource,'unknown');assert.equal(p.observedAt,null);assert.deepEqual(p.history,[]);assert.equal(stylePriceEvidence(p,NOW).confirmed,false);
  }finally{db.close();}
});
test('invalid bytes/source/category or missing server proof fail closed without deleting existing good rows',async()=>{
  const db=await fixture();try{
    const wrongSource=entry(2);wrongSource.photo.sourceUrl=image(3);
    const wrongCategory=entry(3);wrongCategory.product.category='Книги';
    const noEvidence=entry(4);delete noEvidence.evidence;
    const badBytes=entry(5);badBytes.photo.bytes=new Uint8Array(20);
    const prior=JSON.stringify(snapshot(db)),r=await ingestVerifiedProducts(db,[wrongSource,wrongCategory,noEvidence,badBytes],{enabled:true,now:NOW});
    assert.equal(r.added,0);assert.equal(Object.values(r.rejected).reduce((a,b)=>a+b,0),4);assert.equal(JSON.stringify(snapshot(db)),prior);
  }finally{db.close();}
});
test('reviewed Vision survives only exact id/hash/group; changed photographs do not reuse cached traits',async()=>{
  const db=await fixture();try{
    const e=entry(1);e.product.imageHash=await sha(bytes);const correct=visual(e.product);e.visual=correct;
    const r=await ingestVerifiedProducts(db,[e],{enabled:true,now:NOW});assert.equal(r.updated,1);assert.equal(snapshot(db).products[0].visual.fields.color.value,'black');
    const changed=entry(1);changed.photo.bytes=new Uint8Array(bytes);changed.photo.bytes[31]^=1;
    await ingestVerifiedProducts(db,[changed],{enabled:true,now:NOW+INTERVAL});assert.equal(snapshot(db).products[0].visual,null);
  }finally{db.close();}
});
test('retention evicts active slots even when old cards are saved, then reclaims after last owner deletion',async()=>{
  const db=await fixture(300);try{
    // Oldest ID300 is saved by two users, not deleted by catalogue rollover.
    await db.prepare('INSERT INTO style_saved VALUES(?,?,?)').bind(11,300,NOW).run();await db.prepare('INSERT INTO style_saved VALUES(?,?,?)').bind(22,300,NOW).run();
    const r=await ingestVerifiedProducts(db,[entry(301),entry(302)],{enabled:true,now:NOW});assert.equal(r.added,2);
    assert.equal(db.sqlite.prepare('SELECT count(*) n FROM feature_catalog_active').get().n,300);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM feature_catalog').get().n,301);assert.ok(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=300').get());assert.equal(db.sqlite.prepare('SELECT id FROM feature_catalog_active WHERE id=300').get(),undefined);
    assert.equal(snapshot(db).products.length,120);assert.ok(snapshot(db).products.some(row=>row.product.id===302));
    await db.prepare('DELETE FROM style_saved WHERE user_id=? AND pid=?').bind(11,300).run();assert.ok(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=300').get());
    await db.prepare('DELETE FROM style_saved WHERE user_id=? AND pid=?').bind(22,300).run();assert.equal(db.sqlite.prepare('SELECT id FROM feature_catalog WHERE id=300').get(),undefined);
  }finally{db.close();}
});
test('hot queries are bounded index walks/point probes, never saved/history full scans',async()=>{
  const db=await fixture();try{
    for(const sql of ['SELECT id,data,overrides,checked_at FROM products ORDER BY checked_at DESC,id ASC LIMIT 120','SELECT id FROM feature_catalog_active ORDER BY checked_at DESC,id DESC LIMIT 20 OFFSET 300','SELECT 1 FROM style_saved WHERE pid=1 LIMIT 1']){
      const plan=db.sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all().map(row=>row.detail).join(' ');assert.ok(!/TEMP B-TREE/.test(plan),plan);assert.ok(/USING (?:COVERING )?INDEX/.test(plan),plan);assert.ok(!/SCAN style_saved/.test(plan),plan);
    }
    await assert.rejects(ingestVerifiedProducts(db,Array.from({length:21},(_,i)=>entry(i+2)),{enabled:true}),/BATCH_LIMIT/);
  }finally{db.close();}
});
