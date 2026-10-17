// Real LOCAL Workerd runtime with local-only service fixtures, not deployment,
// real WB retrieval, account authorization, or Cloudflare usage evidence.
// CI enables this automatically; sandboxed local runs explicitly opt in after
// permitting only loopback transport for Miniflare's process bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const enabled=process.env.WB_LOCAL_WORKER_RUNTIME_TESTS==='1'||process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true';
test('real Workerd: native fetch/cache/photo/source accept200 and reject302 without following Location',{
  skip:enabled?false:'Enable WB_LOCAL_WORKER_RUNTIME_TESTS=1 with local loopback access (CI runs it automatically)',timeout:30000
},async()=>{
  const payload=new Uint8Array([82,73,70,70,24,0,0,0,87,69,66,80,86,80,56,76,11,0,0,0,47,63,0,15,0,7,208,255,254,247,191,255]),hash=createHash('sha256').update(payload).digest('hex'),now=Date.now();
  const image=id=>`https://basket-17.wbbasket.ru/vol1/part1/${id}/images/big/1.webp`;
  const source=`import {stylePhoto} from './miniapp/features/photo_proxy.mjs';
    import {collectNewCatalogueProducts} from './miniapp/features/catalogue_source.mjs';
    export default{async fetch(request,env,ctx){const path=new URL(request.url).pathname;
      if(path==='/local-source-200'||path==='/local-source-302'){
        const good=path==='/local-source-200',result=await collectNewCatalogueProducts(env.DB,[good?124:126],{enabled:true,now:${now}+(good?0:2400000),random:()=>0});
        return Response.json({status:result.status,verified:result.verified,sourceCalls:result.sourceCalls,errors:result.errors});
      }
      return stylePhoto(request,env,ctx,{guard:(e,r,operation)=>operation(e)});
    }};`;
  const bundled=await build({stdin:{contents:source,resolveDir:fileURLToPath(new URL('../../',import.meta.url)),sourcefile:'LOCAL_RUNTIME_FIXTURE.mjs'},bundle:true,write:false,format:'esm',platform:'browser'});
  const upstream=`let foreign=0,photos=0,metadata=0;
    export default{fetch(request){const url=new URL(request.url);
      if(url.pathname==='/local-metrics')return Response.json({foreign,photos,metadata});
      if(url.hostname!=='basket-17.wbbasket.ru'){foreign++;return new Response('MUST_NOT_FOLLOW',{status:500});}
      const id=Number(url.pathname.match(/\\/part1\\/(\\d+)\\//)?.[1]);
      if([125,126].includes(id))return new Response('',{status:302,headers:{Location:'https://forbidden.local-fixture.invalid/foreign'}});
      if(url.pathname.endsWith('card.json')){metadata++;return Response.json({nm_id:id,imt_name:'Local runtime fixture '+id,subj_name:'Футболки',options:[{name:'Пол',value:'Женский'}]});}
      photos++;return new Response(new Uint8Array(${JSON.stringify([...payload])}),{headers:{'Content-Type':'image/webp'}});
    }};`;
  const mf=new Miniflare(convertV4MiniflareOptions({cf:false,cachePersist:false,d1Persist:false,workers:[
    {name:'app',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-09-01',d1Databases:['DB'],outboundService:'wb-local-fixture'},
    {name:'wb-local-fixture',modules:true,script:upstream,compatibilityDate:'2026-09-01'}
  ]}));
  try{
    const db=await mf.getD1Database('DB','app');
    await db.exec("CREATE TABLE feature_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE products(id INTEGER PRIMARY KEY,data TEXT NOT NULL,overrides TEXT NOT NULL DEFAULT '{}',checked_at INTEGER NOT NULL); CREATE TABLE feature_catalog(id INTEGER PRIMARY KEY,data TEXT NOT NULL);");
    for(const id of [123,125])await db.prepare('INSERT INTO feature_catalog VALUES(?,?)').bind(id,JSON.stringify({id,image:image(id),imageHash:hash,displayImage:`/style-images/${id}/${hash}.webp`})).run();
    for(const id of [124,126])await db.prepare('INSERT INTO products(id,data,checked_at) VALUES(?,?,?)').bind(id,JSON.stringify({id,image:image(id)}),now).run();
    for(let repeat=0;repeat<2;repeat++){
      const response=await mf.dispatchFetch(`https://local-runtime.invalid/style-images/123/${hash}.webp`);assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),payload);
    }
    const rejectedPhoto=await mf.dispatchFetch(`https://local-runtime.invalid/style-images/125/${hash}.webp`);assert.equal(rejectedPhoto.status,404);
    const goodSource=await(await mf.dispatchFetch('https://local-runtime.invalid/local-source-200')).json();assert.equal(goodSource.status,'ok');assert.equal(goodSource.verified,1);assert.equal(goodSource.sourceCalls,2);
    const badSource=await(await mf.dispatchFetch('https://local-runtime.invalid/local-source-302')).json();assert.equal(badSource.verified,0);assert.equal(badSource.sourceCalls,1);assert.equal(badSource.errors[0].status,302);
    const upstreamWorker=await mf.getWorker('wb-local-fixture'),metrics=await(await upstreamWorker.fetch('https://fixture-metrics.invalid/local-metrics')).json();assert.equal(metrics.foreign,0);
  }finally{await mf.dispose();}
});
