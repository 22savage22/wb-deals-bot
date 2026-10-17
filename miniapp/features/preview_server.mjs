// Local-only preview of the isolated Worker. Does not listen beyond loopback,
// load real credentials, create Cloudflare resources, poll Telegram or run Cron.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import worker from './worker.mjs';
import {LocalD1} from './local_d1.mjs';
import {hmac} from '../cloudflare/auth.mjs';
import publicWorker from '../cloudflare/worker.mjs';
import {prepareStaging,OUT} from './prepare_staging.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=path.join(root,'.test-temp/superstyle');
export async function signedPreviewData(uid,token){
  const fields=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:uid})});
  const check=[...fields].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  fields.set('hash',[...await hmac(await hmac('WebAppData',token),check)].map(n=>n.toString(16).padStart(2,'0')).join(''));return fields.toString();
}
export async function startPreview({port=8773,file=path.join(dir,'preview.sqlite3'),integrated=false}={}){
  await fs.mkdir(path.dirname(file),{recursive:true});const db=new LocalD1(file);
  db.exec(await fs.readFile(path.join(root,'miniapp/features/schema.sql'),'utf8'));
  if(integrated){await prepareStaging();db.exec(await fs.readFile(path.join(OUT,'seed.sql'),'utf8'));}
  const reviewed=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-20261011/reviewed-visual.json'),'utf8')).profiles,photos=new Map(),catalog=[];
  for(const dataset of ['shadow-20261011','shadow-prospective-20261011']){
    const report=JSON.parse(await fs.readFile(path.join(root,'docs',dataset,'report.json'),'utf8'));
    for(const p of report.products){
      if(photos.has(p.id))continue;const photoPath=path.join(root,'docs',dataset,'photos',`${p.id}.webp`),bytes=await fs.readFile(photoPath);
      if(createHash('sha256').update(bytes).digest('hex')!==p.imageHash)continue;
      const product={...p,displayImage:`/photos/${p.id}.webp`},visual=reviewed[p.id]??null;
      photos.set(p.id,bytes);catalog.push({product,visual});
      await db.prepare('INSERT INTO feature_catalog(id,data,visual,checked_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,visual=excluded.visual,checked_at=excluded.checked_at').bind(p.id,JSON.stringify(product),JSON.stringify(visual),p.photoVerifiedAt??0).run();
      if(p.alreadyPublished===true)await db.prepare('INSERT OR IGNORE INTO feature_publications(pid) VALUES(?)').bind(p.id).run();
    }
  }
  await db.prepare("INSERT OR REPLACE INTO feature_meta VALUES('shared_catalog_snapshot',?)").bind(JSON.stringify({products:catalog.slice(0,120)})).run();
  const publicToken=randomBytes(32).toString('hex'),adminToken=randomBytes(32).toString('hex');
  const origin=`http://127.0.0.1:${port}`,env={DB:db,FEATURE_PREVIEW:'1',MINIAPP_BOT_TOKEN:publicToken,TG_BOT_TOKEN:adminToken,MINIAPP_ADMIN_ID:'10003',
    ASSETS:{async fetch(request){const u=new URL(request.url),name=integrated?u.pathname==='/style'?'style/index.html':u.pathname==='/'?'index.html':u.pathname.slice(1):u.pathname==='/feature/app.js'?'app.js':u.pathname==='/feature/app.css'?'app.css':'index.html';
      if(integrated&&!['index.html','style/index.html','static/app.js','static/app.css','feature/app.js','feature/app.css','style-navigation.js'].includes(name))return new Response('Not found',{status:404});
      return new Response(await fs.readFile(path.join(integrated?path.join(OUT,'assets'):path.join(root,'miniapp/features/ui'),name)),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8'}});}}};
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403);res.end('Local preview only');return;}
      const u=new URL(req.url,origin);
      if(u.pathname==='/preview/session'&&req.method==='GET'){
        const profile=u.searchParams.get('profile')??'a',ids={a:10001,b:10002,admin:10003};if(!Object.hasOwn(ids,profile)){res.writeHead(400);res.end();return;}
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({initData:await signedPreviewData(ids[profile],profile==='admin'?adminToken:publicToken),profile,localOnly:true}));return;
      }
      const photo=/^\/(?:photos|style-photos)\/(\d{1,12})\.webp$/.exec(u.pathname);
      if(photo){const bytes=photos.get(Number(photo[1]));if(!bytes){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'public, max-age=3600'});res.end(bytes);return;}
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192){res.writeHead(413);res.end();return;}chunks.push(chunk);}
      const request=new Request(u,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
      const ctx={waitUntil:p=>p.catch(()=>{})},publicPath=/^\/api\/(?:catalog|me|preferences|outfits(?:\/saved(?:\/\d+)?)?|saved\/\d+)$/.test(u.pathname);
      const response=integrated&&(u.pathname==='/style-navigation.js')?await env.ASSETS.fetch(request):await (integrated&&(publicPath||u.pathname.startsWith('/static/'))?publicWorker:worker).fetch(request,env,ctx);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Локальный preview временно недоступен'}));}
  });await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  console.log(`LOCAL_FEATURE_PREVIEW ${origin}/style · owner preview ${origin}/superfind · real photos ${photos.size} · Cloudflare/Telegram/AI calls 0`);
  return {server,db,env,photos,close:async()=>{await new Promise(resolve=>server.close(resolve));db.close();}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await startPreview();
