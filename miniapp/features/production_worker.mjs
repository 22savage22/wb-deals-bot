// Feature-gated composition: original production scheduler and routes stay in
// place. New subscriber features default OFF until explicitly enabled.
import original from '../cloudflare/worker.mjs';
import featureWorker from './worker.mjs';
import {telegramUser} from '../cloudflare/auth.mjs';
import {forgetSubscriber} from './store.mjs';
import {withReadBudget} from '../cloudflare/read_guard.mjs';
import {refreshCatalogueFromPublic,ingestVerifiedProducts} from './catalogue_adapter.mjs';
import {collectNewCatalogueProducts} from './catalogue_source.mjs';
import {stylePhoto} from './photo_proxy.mjs';
import {ownerPreviewRoute} from './staging_owner.mjs';
const flags=env=>({style:env.SUBSCRIBER_STYLE_ENABLED==='1',superfind:env.SUPERFIND_PREVIEW_ENABLED==='1'});
const denied=()=>Response.json({error:'Функция пока не включена'},{status:404,headers:{'Cache-Control':'no-store'}});
export function createProductionFeatures(core=original,features=featureWorker){return {
  async scheduled(controller,env,ctx){
    // Posting always runs first, unchanged; optional failure cannot fail it.
    const result=await core.scheduled(controller,env,ctx);
    if(flags(env).style&&env.STYLE_CATALOGUE_REFRESH_ENABLED==='1'&&Math.floor(controller.scheduledTime/60000)%20===0)
      ctx.waitUntil(withReadBudget(env,'optional',8000,async e=>{
        const plan=await refreshCatalogueFromPublic(e.DB,{enabled:true});
        if(plan.status!=='ok'||!plan.newCandidateIds?.length)return;
        const found=await collectNewCatalogueProducts(e.DB,plan.newCandidateIds,{enabled:true});
        if(found.entries?.length)await ingestVerifiedProducts(e.DB,found.entries,{enabled:true});
      },{writes:1200}).catch(()=>console.log('STYLE_CATALOGUE_DEFERRED; posting unaffected')));
    return result;
  },
  async fetch(request,env,ctx={waitUntil:()=>{}}){
    const url=new URL(request.url),path=url.pathname,f=flags(env);
    if(path==='/admin/feature-flags.js'&&request.method==='GET')return new Response('globalThis.__WB_SUPERFIND_PREVIEW__='+JSON.stringify(f.superfind)+';',{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    if(path==='/style-flags.js'&&request.method==='GET')return new Response('globalThis.__WB_STYLE_ENABLED__='+JSON.stringify(f.style)+';',{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    const styleAPI=path.startsWith('/api/style/'),ownerAPI=path.startsWith('/api/admin/superfind'),styleShell=['/style','/style/'].includes(path),ownerShell=path==='/superfind',photo=path.startsWith('/style-images/');
    if(styleAPI&&!f.style||ownerAPI&&!f.superfind||styleShell&&!f.style||ownerShell&&!f.superfind||photo&&!f.style)return denied();
    if(ownerAPI&&!ownerPreviewRoute(path,request.method))return denied();
    if(styleAPI||ownerAPI)return features.fetch(request,{...env,FEATURE_PREVIEW:'1',STYLE_STAGING:undefined},ctx);
    if((styleShell||ownerShell)&&request.method==='GET'){
      const served=await env.ASSETS.fetch(new Request(new URL('/style/index.html',url.origin),request)),out=new Response(served.body,served);
      out.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' https://*.wbbasket.ru; connect-src 'self'; frame-ancestors 'self' https://*.telegram.org; object-src 'none'; base-uri 'none'");out.headers.set('Referrer-Policy','no-referrer');out.headers.set('Cache-Control','no-cache');return out;
    }
    if(photo)return stylePhoto(request,env,ctx);
    if(path.startsWith('/feature/')||path.startsWith('/style-photos/')||path==='/style-navigation.js'){
      if(!f.style&&!f.superfind)return denied();return env.ASSETS.fetch(request);
    }
    const response=await core.fetch(request,env,ctx);
    if(f.style&&path==='/api/me'&&request.method==='DELETE'&&response.ok){
      try{const uid=await telegramUser(request.headers.get('X-Telegram-Init-Data'),env.MINIAPP_BOT_TOKEN);await withReadBudget(env,'optional',3000,e=>forgetSubscriber(e.DB,uid),{writes:2400});}
      catch{return Response.json({error:'Удаление профиля не завершено. Повторите запрос'},{status:503});}
    }
    return response;
  }
};}
export default createProductionFeatures();
