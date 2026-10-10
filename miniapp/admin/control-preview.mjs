// Isolated local development server: real Worker handlers + SQLite D1 adapter.
// No production credentials or external service requests. Never deployed.
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {adminEnvironment,signedAdmin} from '../cloudflare/admin_test_support.mjs';
import {ensureControl} from '../cloudflare/admin_history.mjs';
import {ensureLearning} from '../cloudflare/learning.mjs';
import {ensureReactions} from '../cloudflare/feedback.mjs';
import worker from '../cloudflare/worker.mjs';
import {runDiscovery,readHeader} from '../cloudflare/native_scheduler.mjs';
const observed={id:498913016,title:'Худи спортивное',query:'худи мужское',price:614,product:614,category:'Худи',image:'https://basket-27.wbbasket.ru/vol4989/part498913/498913016/images/big/1.webp'};
export async function startControlPreview({path=':memory:',port=0}={}){
  const e=await adminEnvironment(null,{path});e.SCHEDULER_DRIVER='isolated-preview';e.TG_BOT_TOKEN='local-only-'+crypto.randomUUID();
  await ensureControl(e);await ensureLearning(e);await ensureReactions(e);
  if(!e.db.prepare("SELECT value FROM metadata WHERE key='control_preview_seed'").get()){
    e.db.prepare('UPDATE scheduler_policy SET data=? WHERE id=1').run(JSON.stringify({queries:[observed.query],disabled_topics:[],max_price:0,min_rating:0,min_feedbacks:0,blocked_words:[],blacklist:[],total_posts:0,chat_id:''}));
    e.db.prepare("INSERT OR IGNORE INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires) VALUES(?,?,?,'preview-observed-hoodie',?,?,?)").run(observed.id,JSON.stringify(observed),observed.query,1791623621,1791623621,Math.floor(Date.now()/1000)+30*86400);
    e.db.prepare('INSERT OR IGNORE INTO products(id,data,checked_at) VALUES(?,?,?)').run(observed.id,JSON.stringify(observed),1791623621);
    e.db.prepare("INSERT INTO metadata VALUES('control_preview_seed','production-observation-38041179075')").run();
  }
  const tasks=new Set(),waitUntil=task=>{tasks.add(task);task.finally(()=>tasks.delete(task)).catch(()=>{});};
  let origin;
  const fixtureFetch=async url=>{
    const u=new URL(url);
    if(u.hostname==='search.wb.ru'||u.hostname==='card.wb.ru'){
      const compatible=!u.searchParams.has('query')||/худи/i.test(u.searchParams.get('query'));
      return Response.json({products:compatible?[{id:observed.id,name:observed.title,subjectName:'Худи',sizes:[{qty:1,price:{product:61400,basic:61400}}]}]:[]});
    }
    if(u.hostname.endsWith('.wbbasket.ru'))return new Response('local fixture, not downloaded',{headers:{'content-type':'image/webp'}});
    throw new Error('External requests disabled in isolated preview');
  };
  const server=createServer(async(req,res)=>{
    const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
    try{
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')return send({error:'Этот preview доступен только с локальной страницы'},403);
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&['/','/admin','/admin/'].includes(url.pathname)){
        const dark=url.searchParams.get('theme')==='dark';
        const js='window.Telegram={WebApp:'+JSON.stringify({initData:signedAdmin(e),colorScheme:dark?'dark':'light',platform:'ios',themeParams:{bg_color:dark?'#101824':'#f4f7fb',secondary_bg_color:dark?'#172338':'#ffffff',text_color:dark?'#edf2fa':'#172338',hint_color:'#8290a6',button_color:'#477be8',button_text_color:'#ffffff'}}).slice(0,-1)+',ready(){},expand(){},onEvent(){},offEvent(){}}};';
        const themedJS=js+'Object.entries(window.Telegram.WebApp.themeParams).forEach(([k,v])=>document.documentElement.style.setProperty("--tg-theme-"+k.replaceAll("_","-"),v));';
        const html=(await readFile(new URL('../public/admin/index.html',import.meta.url),'utf8')).replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>','<script>'+themedJS+'</script>').replace('<body>','<body><aside style="padding:14px;background:#fff1c4;color:#483916;font:13px/1.5 system-ui;text-align:center">🧪 Изолированная тестовая админка. Настройки и поиск — локальная учебная база.<br>Один товар взят из снимка 10.10.2026. Полный production-список сюда не скопирован.<br>Тест поиска использует сохранённую карточку; внешние запросы WB, Telegram и AI отключены.</aside>');
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(html);return;
      }
      const asset={'/admin/app.js':['../public/admin/app.js','text/javascript'],'/admin/app.css':['../public/admin/app.css','text/css']}[url.pathname];
      if(asset&&req.method==='GET'){res.writeHead(200,{'content-type':asset[1],'cache-control':'no-store'});res.end(await readFile(new URL(asset[0],import.meta.url)));return;}
      if(!url.pathname.startsWith('/api/admin/'))return send({error:'Не найдено'},404);
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>128000)return send({error:'Слишком большой запрос'},413);chunks.push(chunk);}const body=Buffer.concat(chunks),data=body.length?JSON.parse(body.toString('utf8')):null;
      if(['/api/admin/check','/api/admin/schedule/check'].includes(url.pathname)||url.pathname.includes('/visual/')||data?.action==='post_now'||url.pathname==='/api/admin/queue'&&data?.action==='post')return send({error:'Внешние проверки и Telegram-публикации отключены в тестовой админке'},409);
      const result=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,...(body.length?{body}:{})}),e,{waitUntil});
      res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
      if((url.pathname==='/api/admin/search/test'||url.pathname==='/api/admin/schedule/action'&&data?.action==='search_now')&&result.status===202)waitUntil(runDiscovery(e,await readHeader(e),fixtureFetch));
    }catch{if(!res.headersSent)send({error:'Локальная проверка не завершилась; production не затронут'},500);else res.end();}
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  return {origin,env:e,async close(){await Promise.allSettled([...tasks]);await new Promise(resolve=>server.close(resolve));e.db.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await mkdir('.test-temp',{recursive:true});const port=Number(process.argv.find(x=>x.startsWith('--port='))?.slice(7)||0);const app=await startControlPreview({path:'.test-temp/admin-preview.sqlite',port});console.log('ISOLATED_ADMIN_PREVIEW '+app.origin+'/admin');}
