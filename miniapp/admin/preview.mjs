// Local UI fixture only. No production credentials, Telegram calls or D1 writes.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {DEFAULT_SCHEDULE} from '../cloudflare/scheduler_api.mjs';
import {nextPost} from '../cloudflare/admin_api.mjs';
const now=()=>Math.floor(Date.now()/1000);
let schedule={...DEFAULT_SCHEDULE,post_interval_minutes:30},revision=17;
const status=()=>({cron_active:true,last_post_success:now()-600,last_automatic_tick:now(),last_search_success:now()-300,last_scan_success:now()-300,queue_size:39,next_post:nextPost(schedule,now()-600),next_search:now()+900,search_retry_at:0,last_error:'',search_receipt:{found:100,added:3},native_credentials_ok:true});
let commands=0,saves=0,previewCalls=0;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),send=(value,code=200)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(url.pathname==='/stats')return send({commands,saves,previewCalls,interval:schedule.post_interval_minutes,revision});
  if(url.pathname.startsWith('/api/admin/')){
    let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
    if(url.pathname.endsWith('/session'))return send({ok:true});
    if(url.pathname.endsWith('/preview')){previewCalls++;return send({next_post:nextPost(body.schedule,now()-600),preview:true});}
    if(url.pathname==='/api/admin/schedule'&&req.method==='PUT'){schedule=body.schedule;revision++;saves++;return send({ok:true});}
    if(url.pathname.endsWith('/overview'))return send({schedule,revision,status:status(),operations:{post:null,search:null}});
    if(url.pathname.endsWith('/learning'))return send({config:{mode:'SHADOW',exploration_percent:10},current_votes:{likes:0,dislikes:0,bought:0},backfill_complete:true,today_reactions:0,insights:[],feedback_events:0,last_feedback:0,model_updated_at:0,trained_events:0,comparison:{samples:0,paired_observations:0,sufficient:false,explanation:'Локальная проверка UI. Реальные реакции здесь не имитируются.'},legacy_fallback:true});
    if(url.pathname.endsWith('/queue'))return send({items:[{pid:1,title:'Пример карточки — только локальный UI',price:799,category:'Одежда',reason:'Проверка раскладки, не production товар.',url:'https://www.wildberries.ru/'}],next_cursor:null,note:'Локальный пример для проверки мобильной ширины'});
    if(url.pathname.endsWith('/diagnostics'))return send({worker:true,d1:true,telegram:true,wb_source:true,heartbeat:now(),budget:[],last_error:'',webhook:null});
    commands++;return send({accepted:true},202);
  }
  if(url.pathname==='/admin'||url.pathname==='/'){
    const dark=url.searchParams.get('theme')==='dark',params=dark?{bg_color:'#17212b',secondary_bg_color:'#0e1621',text_color:'#f5f5f5',hint_color:'#91a2b2',button_color:'#5288c1',button_text_color:'#ffffff'}:{bg_color:'#ffffff',secondary_bg_color:'#f2f4f8',text_color:'#172338',hint_color:'#65718a',button_color:'#2481cc',button_text_color:'#ffffff'};
    const js="window.Telegram={WebApp:{initData:'LOCAL_UI_PREVIEW_NOT_AUTH',colorScheme:"+JSON.stringify(dark?'dark':'light')+",platform:'ios',themeParams:"+JSON.stringify(params)+",ready(){},expand(){},onEvent(){},offEvent(){}}};";
    const style=Object.entries(params).map(([k,v])=>'--tg-theme-'+k.replaceAll('_','-')+':'+v).join(';');
    let html=readFileSync(new URL('../public/admin/index.html',import.meta.url),'utf8').replace('<script src="https://telegram.org/js/telegram-web-app.js"></script>','<script>'+js+'</script>').replace('<head>','<head><style>:root{'+style+'}</style>').replace('<body>','<body><div style="text-align:center;padding:8px;font-size:11px;color:#888">LOCAL UI PREVIEW · НЕ PRODUCTION</div>');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(html);
  }
  const files={'/admin/app.js':['../public/admin/app.js','application/javascript'],'/admin/app.css':['../public/admin/app.css','text/css']};
  if(files[url.pathname]){const [file,type]=files[url.pathname];res.writeHead(200,{'content-type':type});return res.end(readFileSync(new URL(file,import.meta.url)));}
  res.writeHead(404);res.end();
});
server.listen(8789,'127.0.0.1',()=>console.log('LOCAL_UI_PREVIEW http://127.0.0.1:8789/admin'));

