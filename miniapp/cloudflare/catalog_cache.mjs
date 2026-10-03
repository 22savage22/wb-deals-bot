// Persistent, cross-isolate public catalogue snapshot. No Telegram/user data.
// At most one successful rebuild per five minutes, regardless of page traffic.
const migrations=new WeakMap();
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
export async function ensureCatalog(db){
  if(migrations.has(db))return migrations.get(db);
  const pending=(async()=>{
    const row=await q(db,"SELECT value FROM metadata WHERE key='public_schema_version'").first();
    if(row?.value==='1')return;
    await db.batch([
      q(db,'CREATE INDEX IF NOT EXISTS saved_user_created ON saved(user_id,created_at DESC)'),
      q(db,'CREATE INDEX IF NOT EXISTS saved_user_owned ON saved(user_id,owned,product_id)'),
      q(db,'CREATE INDEX IF NOT EXISTS products_checked ON products(checked_at DESC)'),
      q(db,"INSERT OR REPLACE INTO metadata(key,value) VALUES('public_schema_version','1')")
    ]);
  })();migrations.set(db,pending);
  try{await pending;}catch(e){migrations.delete(db);throw e;}
}
export async function catalogSnapshot(db,now=Math.floor(Date.now()/1000)){
  await ensureCatalog(db);
  const stored=await q(db,"SELECT value FROM metadata WHERE key='catalog_snapshot'").first();
  const snapshot=stored?JSON.parse(stored.value):null;
  const cached=async()=>{
    const rows=(await q(db,"SELECT key,value FROM metadata WHERE key IN ('catalog_page_0','catalog_page_1','catalog_page_2','catalog_page_3','catalog_page_4','catalog_page_5') ORDER BY key LIMIT 6").all()).results;
    return rows.flatMap(row=>JSON.parse(row.value));
  };
  if(snapshot&&now-snapshot.at<300)return cached();
  const owner=crypto.randomUUID();
  const lease=await q(db,`INSERT INTO metadata(key,value) VALUES('catalog_refresh',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(metadata.value,'$.expires')<=?`,JSON.stringify({owner,expires:now+60}),now).run();
  if(!lease.meta.changes){if(snapshot)return cached();throw new Error('Catalogue refresh already in progress');}
  try{
    const rows=(await q(db,'SELECT data,overrides FROM products ORDER BY checked_at DESC LIMIT 3000').all()).results;
    const products=rows.map(row=>({...JSON.parse(row.data),...JSON.parse(row.overrides)}));
    // Six bounded rows, rather than an unbounded JSON value near D1's row limit.
    await db.batch([
      ...Array.from({length:6},(_,i)=>q(db,'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)','catalog_page_'+i,JSON.stringify(products.slice(i*500,(i+1)*500)))),
      q(db,"INSERT OR REPLACE INTO metadata(key,value) VALUES('catalog_snapshot',?)",JSON.stringify({at:now}))
    ]);
    return products;
  }finally{
    await q(db,"DELETE FROM metadata WHERE key='catalog_refresh' AND json_extract(value,'$.owner')=?",owner).run();
  }
}
// Owner edits invalidate explicitly; ordinary catalogue sync/posting respects
// the five-minute refresh bound instead of forcing reads on each publication.
export async function invalidateCatalog(db){await q(db,"DELETE FROM metadata WHERE key='catalog_snapshot'").run();}
