// Public product photos only. One indexed lookup and bounded WB GET on cache
// miss; cache hits need neither D1 nor WB. Never accepts a URL from the client.
import {withReadBudget} from '../cloudflare/read_guard.mjs';
const notFound=()=>new Response('Photo unavailable',{status:404});
async function servePhoto(request,env,ctx,{fetcher=fetch,cache=globalThis.caches?.default,guard=(e,r,op)=>withReadBudget(e,'optional',20,op,{writes:8}),diagnostic={}}={}){
  diagnostic.phase='route';
  const path=new URL(request.url).pathname,m=/^\/style-images\/([1-9]\d{0,11})\/([a-f0-9]{64})\.webp$/.exec(path);
  if(!m||!['GET','HEAD'].includes(request.method))return notFound();
  diagnostic.phase='cache';const key=new Request(new URL(path,request.url));const hit=await cache?.match(key).catch(()=>null);if(hit)return request.method==='HEAD'?new Response(null,hit):hit;
  diagnostic.phase='guard';
  return guard(env,request,async e=>{
    diagnostic.phase='catalogue';
    const row=await e.DB.prepare('SELECT data FROM feature_catalog WHERE id=?').bind(Number(m[1])).first();if(!row)return notFound();
    let p,u;try{p=JSON.parse(row.data);u=new URL(p.image);}catch{return notFound();}
    if(p.id!==Number(m[1])||p.imageHash!==m[2]||p.displayImage!==path||u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/^basket-\d{2,3}\.wbbasket\.ru$/.test(u.hostname)||!new RegExp('^/vol[0-9]+/part[0-9]+/'+p.id+'/images/[^/]+/[1-9][0-9]*\\.webp$').test(u.pathname))return notFound();
    // Workerd supports follow/manual, but rejects redirect:'error' before any
    // request. Manual + !ok below preserves the same no-follow security gate.
    diagnostic.phase='upstream';const response=await fetcher(u.href,{headers:{Accept:'image/webp'},redirect:'manual',signal:AbortSignal.timeout(8000)});
    if(!response.ok||!/^image\/webp(?:;|$)/i.test(response.headers.get('content-type')||''))return notFound();
    if(Number(response.headers.get('content-length'))>2*1024*1024)return notFound();
    diagnostic.phase='body';const reader=response.body?.getReader();if(!reader)return notFound();const chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();return notFound();}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    if(size<12||String.fromCharCode(...bytes.subarray(0,4))!=='RIFF'||String.fromCharCode(...bytes.subarray(8,12))!=='WEBP')return notFound();
    diagnostic.phase='hash';const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(hash!==m[2])return notFound();
    const out=new Response(bytes,{headers:{'Content-Type':'image/webp','Cache-Control':'public, max-age=86400, immutable','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
    diagnostic.phase='cache_write';if(cache&&ctx)ctx.waitUntil(cache.put(key,out.clone()).catch(()=>{}));return request.method==='HEAD'?new Response(null,out):out;
  });
}
export async function stylePhoto(request,env,ctx,options={}){
  const diagnostic={};try{return await servePhoto(request,env,ctx,{...options,diagnostic});}
  catch(e){
    // Classify known runtime failures; NEVER emit raw messages, URLs or headers.
    const raw=String(e?.message??''),kind=/illegal invocation/i.test(raw)?'runtime_binding':/redirect/i.test(raw)?'redirect_rejected':/abort|timeout/i.test(raw)||e?.name==='TimeoutError'?'timeout':/TLS|SSL|certificate/i.test(raw)?'tls':e?.name==='TypeError'?'request_type':e?.name==='StagingBudgetError'?'budget':'request_failed';
    console.error('STYLE_PHOTO_UNAVAILABLE',JSON.stringify({phase:diagnostic.phase??'unknown',kind}));return new Response('Photo temporarily unavailable',{status:503,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Style-Photo-Phase':diagnostic.phase??'unknown','X-Style-Photo-Failure':kind}});
  }
}
