// Local-only fixture preview. Never imported by the production Worker/build.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {DEFAULT_SCHEDULE} from '../miniapp/cloudflare/scheduler_api.mjs';
let schedule={...DEFAULT_SCHEDULE},revision=1,offline=false,requests=0;
const now=()=>Math.floor(Date.now()/1000),status=()=>({cron_active:true,queue_size:102,last_post_success:now()-120,last_search_success:now()-300,next_post:now()+480,next_search:now()+900});
const learning={config:{mode:'SHADOW',exploration_percent:10},feedback_events:7,feedback_weight:12,today_events:2,trained_events:7,model_updated_at:now()-900,categories:[],comparison:{samples:0,sufficient:false,explanation:'Тестовый макет: выводов об улучшении нет.'},legacy_fallback:true};
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  const json=(value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/')return res.end('<!doctype html><meta charset="utf-8"><h3>Локальный макет · НЕ production</h3><a href="/offline">Включить/выключить потерю сети</a> · <a href="/requests">Число заявок</a><br><iframe title="Мобильная админка" src="/admin" style="width:390px;height:844px;border:1px solid #ddd"></iframe>');
  if(path==='/offline'){offline=!offline;res.writeHead(302,{Location:'/'});return res.end();}
  if(path==='/requests')return json({requests});
  if(path.startsWith('/api/')){
    if(offline)return json({error:'Нет связи. Повтор безопасен.'},503);
    if(path==='/api/admin/overview')return json({schedule,revision,status:status(),operations:{post:null,search:null}});
    if(path==='/api/admin/learning')return json(learning);
    if(path==='/api/admin/diagnostics')return json({worker:true,d1:true,cron:true,telegram:true,wb_source:true,budget:[{reads:120000}],budget_note:'Тестовый макет',heartbeat:now(),last_error:''});
    let body='';for await(const c of req)body+=c;const data=JSON.parse(body||'{}');
    if(path==='/api/admin/schedule'&&req.method==='PUT'){schedule=data.schedule;revision++;return json({ok:true});}
    if(path==='/api/admin/schedule/action'){requests++;if(data.action==='pause')schedule.paused=true;if(data.action==='resume')schedule.paused=false;return json({accepted:true},202);}
    return json({accepted:true},202);
  }
  const file={'/admin':'index.html','/admin/app.js':'app.js','/admin/app.css':'app.css'}[path];
  if(!file){res.writeHead(404);return res.end();}
  let content=await readFile(new URL('../miniapp/public/admin/'+file,import.meta.url));
  if(file==='app.js')content=Buffer.concat([Buffer.from(`window.Telegram={WebApp:{initData:'LOCAL_FIXTURE_ONLY',platform:'ios',colorScheme:'light',themeParams:{},ready(){},expand(){},onEvent(){},offEvent(){}}};\n`),content]);
  res.writeHead(200,{'Content-Type':file.endsWith('js')?'text/javascript':file.endsWith('css')?'text/css':'text/html'});res.end(content);
});
server.listen(8772,'127.0.0.1',()=>console.log('ADMIN_LOCAL_PREVIEW http://127.0.0.1:8772 · fixture only'));
