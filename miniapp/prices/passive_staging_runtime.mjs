// Safety-locked staging driver for the real native scheduler. Every WB/photo/TG
// response is local fixture data; this entrypoint has NO external fetch call.
import {nativeTick} from '../cloudflare/native_scheduler.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
import {createPassiveObserver} from './passive_capture.mjs';
export default {async fetch(request,env,ctx){
  if(env.PRICE_LOCAL_STAGING!=='1'||env.TG_BOT_TOKEN!=='123:fixture-passive-price'||request.method!=='POST'||new URL(request.url).pathname!=='/replay')return new Response('LOCAL_STAGING_ONLY',{status:404});
  const counts={wbDetails:0,wbSearch:0,photos:0,simulatedTelegram:0,actualExternalRequests:0};
  const fixtureFetch=async(url,options)=>{
    const u=new URL(url);
    if(u.hostname==='card.wb.ru'){
      counts.wbDetails++;const ids=(u.searchParams.get('nm')||'').split(';').map(Number);
      if(env.PRICE_STAGE_WB_ERROR==='1')return new Response('fixture WB denied',{status:403});
      return Response.json({products:ids.map(id=>({id,name:'Fixture товар '+id,subjectName:'Футболки',brand:'Fixture',reviewRating:4.9,feedbacks:120,
        sizes:[{chrtId:id*10+1,name:'S',qty:0,price:{product:10000,basic:100000}},{chrtId:id*10+2,name:'M',qty:3,price:{product:24999,basic:100000}}]}))});
    }
    if(u.hostname==='search.wb.ru'){counts.wbSearch++;return Response.json({products:[]});}
    if(/^basket-\d+\.wbbasket\.ru$/.test(u.hostname)){counts.photos++;return new Response('fixture-photo',{headers:{'Content-Type':'image/webp'}});}
    if(u.hostname==='api.telegram.org'&&u.pathname.endsWith('/sendPhoto')){counts.simulatedTelegram++;return Response.json({ok:true,result:{message_id:9000+counts.simulatedTelegram}});}
    throw Error('EXTERNAL_ACCESS_FORBIDDEN');
  };
  const waits=[],collector=[];
  const stageCtx={waitUntil:p=>{waits.push(p);ctx.waitUntil(p);}};
  const meter=observeD1(env.DB),onWBResponse=createPassiveObserver(env,stageCtx,{onSafeResult:r=>collector.push(r)}),started=performance.now();
  const result=await nativeTick({...env,DB:meter.DB},Date.now(),fixtureFetch,'cron',{onWBResponse});
  const coreWallMs=performance.now()-started;
  // Only the staging driver awaits observations so its receipt is deterministic.
  // The deployed production composition uses ctx.waitUntil without awaiting.
  await Promise.all(waits);
  return Response.json({scope:'SYNTHETIC_NATIVE_SCHEDULER_STAGING',result,counts,mainD1:meter.metrics,mainMetadataComplete:meter.coverage.complete,coreWallMs,collector,wallMs:performance.now()-started,livePricesValidated:0});
}};
