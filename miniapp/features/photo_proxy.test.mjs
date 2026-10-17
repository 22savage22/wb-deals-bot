// LOCAL synthetic byte/hash/cache fixtures only. No external image, WB request
// or production/D1 billing evidence is implied by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {stylePhoto} from './photo_proxy.mjs';
const bytes=Uint8Array.from(Buffer.from('RIFF....WEBPLOCAL_SYNTHETIC_IMAGE_BYTES'));
const digest=async data=>Buffer.from(await crypto.subtle.digest('SHA-256',data)).toString('hex');
async function fixture({payload=bytes,patch={},fetcher,cacheEnabled=true}={}){
  const hash=await digest(payload),path='/style-images/123/'+hash+'.webp',product={id:123,imageHash:hash,displayImage:path,image:'https://basket-17.wbbasket.ru/vol1/part1/123/images/big/1.webp',...patch};
  const metrics={queries:0,guards:0,fetches:0,puts:0},pending=[],cached=new Map(),ctx={waitUntil:promise=>pending.push(promise)};
  const cache=cacheEnabled?{async match(r){return cached.get(r.url)?.clone();},async put(r,response){metrics.puts++;cached.set(r.url,response.clone());}}:null;
  const env={DB:{prepare(sql){metrics.queries++;assert.equal(sql,'SELECT data FROM feature_catalog WHERE id=?');return {bind(id){assert.equal(id,123);return this;},async first(){return {data:JSON.stringify(product)};}};}}};
  const options={cache,guard:async(e,r,operation)=>{metrics.guards++;return operation(e);},fetcher:async(url,init)=>{metrics.fetches++;assert.equal(init.redirect,'manual');assert.equal(init.headers.Accept,'image/webp');return fetcher?fetcher(url,init):new Response(payload,{headers:{'Content-Type':'image/webp'}});}};
  const call=(method='GET',url='https://stage.unit'+path)=>stylePhoto(new Request(url,{method}),env,ctx,options);
  return {call,path,hash,product,metrics,pending,cached,options,env,ctx};
}
test('content addressed photo cache warms once; GET/HEAD cache hits use zero additional D1 or WB requests',async()=>{
  const f=await fixture(),first=await f.call();assert.equal(first.status,200);assert.deepEqual(new Uint8Array(await first.arrayBuffer()),bytes);await Promise.all(f.pending);
  assert.match(first.headers.get('cache-control'),/immutable/);assert.equal(first.headers.get('x-content-type-options'),'nosniff');assert.equal(first.headers.get('content-type'),'image/webp');
  const head=await f.call('HEAD');assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);const again=await f.call();assert.equal(again.status,200);
  assert.deepEqual(f.metrics,{queries:1,guards:1,fetches:1,puts:1});
});
test('client query strings cannot select an upstream URL or force a different cache entry',async()=>{
  const f=await fixture();await f.call();await Promise.all(f.pending);const response=await f.call('GET','https://stage.unit'+f.path+'?url=https://evil.invalid/secret');assert.equal(response.status,200);assert.equal(f.metrics.fetches,1);assert.equal(f.metrics.queries,1);
});
test('invalid route/hash/method is rejected before guard/D1/network',async()=>{
  const f=await fixture();for(const path of ['/style-images/0/'+f.hash+'.webp','/style-images/123/xyz.webp','/style-images/123/'+f.hash.toUpperCase()+'.webp','/style-images/123/'+f.hash+'.png'])assert.equal((await f.call('GET','https://stage.unit'+path)).status,404);
  assert.equal((await f.call('POST')).status,404);assert.deepEqual(f.metrics,{queries:0,guards:0,fetches:0,puts:0});
});
test('photo source is exact trusted same-product WB HTTPS URL, not credentials/port/redirect/client URLs',async()=>{
  for(const image of ['https://evil.invalid/123/images/big/1.webp','http://basket-17.wbbasket.ru/123/images/big/1.webp','https://u:LOCAL_DUMMY@basket-17.wbbasket.ru/123/images/big/1.webp','https://basket-17.wbbasket.ru:8443/123/images/big/1.webp','https://basket-17.wbbasket.ru/124/images/big/1.webp','https://basket-17.wbbasket.ru/123/images/big/1.webp?q=1','https://basket-17.wbbasket.ru/123/images/big/1.webp#x','https://basket-17.wbbasket.ru/123/images/big/1.svg','https://basket-17.wbbasket.ru/123/images/big/1.webp/extra']){
    const f=await fixture({patch:{image}});assert.equal((await f.call()).status,404);assert.equal(f.metrics.fetches,0,'Untrusted source reached fetch');
  }
});
test('catalogue photo nmId/hash/display-path mismatch cannot fetch or populate cache',async()=>{
  for(const patch of [{id:124},{imageHash:'0'.repeat(64)},{displayImage:'/style-images/another.webp'}]){const f=await fixture({patch});assert.equal((await f.call()).status,404);assert.equal(f.metrics.fetches,0);assert.equal(f.metrics.puts,0);}
});
test('upstream errors, redirect and invalid content type are not served or cached',async()=>{
  for(const response of [new Response('',{status:403}),new Response('',{status:429}),new Response('',{status:302,headers:{Location:'https://evil.invalid/'}}),new Response(bytes,{headers:{'Content-Type':'text/html'}})]){
    const f=await fixture({fetcher:async()=>response});assert.equal((await f.call()).status,404);assert.equal(f.metrics.puts,0);
  }
});
test('declared oversize photo is rejected before streaming',async()=>{
  let reads=0;const f=await fixture({fetcher:async()=>new Response(new ReadableStream({pull(){reads++;}}),{headers:{'Content-Type':'image/webp','Content-Length':String(2*1024*1024+1)}})});
  assert.equal((await f.call()).status,404);assert.ok(reads<=1);assert.equal(f.metrics.puts,0);
});
test('streamed payload exceeding2MiB is cancelled even without Content-Length',async()=>{
  let cancelled=false;const f=await fixture({fetcher:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'image/webp'}})});
  assert.equal((await f.call()).status,404);assert.equal(cancelled,true);assert.equal(f.metrics.puts,0);
});
test('content hash mismatch or fake WebP bytes cannot enter cache',async()=>{
  const mismatch=await fixture({fetcher:async()=>new Response(Uint8Array.from([1,2,3]),{headers:{'Content-Type':'image/webp'}})});assert.equal((await mismatch.call()).status,404);assert.equal(mismatch.metrics.puts,0);
  const fake=await fixture({payload:Uint8Array.from(Buffer.from('<html>LOCAL_NOT_AN_IMAGE</html>'))});assert.equal((await fake.call()).status,404);assert.equal(fake.metrics.puts,0);
});
test('network and mid-stream failures return a safe unavailable image rather than uncaught Worker exceptions',async()=>{
  for(const fetcher of [async()=>{throw Error('LOCAL_UPSTREAM_TIMEOUT');},async()=>new Response(new ReadableStream({start(controller){controller.error(Error('LOCAL_STREAM_FAILURE'));}}),{headers:{'Content-Type':'image/webp'}})]){
    const f=await fixture({fetcher});const response=await f.call();assert.ok([404,503].includes(response.status));assert.ok(!(await response.text()).includes('LOCAL_'));assert.equal(f.metrics.puts,0);
  }
});
test('failed cache read/write cannot break a valid verified photo response',async()=>{
  const f=await fixture(),badCache={async match(){throw Error('LOCAL_CACHE_MISS');},async put(){throw Error('LOCAL_CACHE_PUT');}};
  const response=await stylePhoto(new Request('https://stage.unit'+f.path),f.env,f.ctx,{...f.options,cache:badCache});assert.equal(response.status,200);await Promise.all(f.pending);
});
