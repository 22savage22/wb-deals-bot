// Dependency-injected staging driver. No real fetch, tokens or deployments.
// The reviewed builder supplies the pinned ORIGINAL worker composition.
import {fixtureIdentity} from './projection_fixture.mjs';
export const PROJECTION_FIXTURE_CORE='aacdeded-216b-4f5a-af1a-081eef724d04';
let invocations=0;
export function createProjectionStagingDriver({worker,observeD1,storeFactory=null,buildLabel='primary'}){
  return {async fetch(request,env,ctx){
    const url=new URL(request.url);
    if(env.PRICE_LOCAL_STAGING!=='1'||env.TG_BOT_TOKEN!=='123:fixture-passive-price'||
      env.PROJECTION_ISOLATED!=='true'||env.PROJECTION_DATABASE_ID!==PROJECTION_FIXTURE_CORE||env.AI||
      request.method!=='POST'||!['/replay','/prepare','/init'].includes(url.pathname))return new Response('ISOLATED_STAGING_ONLY',{status:404});
    const firstInvocation=invocations++===0,stats=[],simulatedMessages=[],counts={wbDetails:0,wbSearch:0,photos:0,simulatedTelegram:0,actualExternalRequests:0};
    const fixtureFetch=async(input,options)=>{
      const target=new URL(input);
      if(target.hostname==='card.wb.ru'){
        counts.wbDetails++;const ids=(target.searchParams.get('nm')||'').split(';').map(Number);
        return Response.json({products:ids.map(id=>{const identity=fixtureIdentity(id);return {id,name:identity.title,subjectName:identity.category,brand:identity.brand,reviewRating:4.9,feedbacks:120,
          sizes:[{chrtId:id*10+1,name:'S',qty:0,price:{product:10000,basic:100000}},{chrtId:id*10+2,name:'M',qty:3,price:{product:24999,basic:100000}}]};})});
      }
      if(target.hostname==='search.wb.ru'){counts.wbSearch++;return Response.json({products:[]});}
      if(/^basket-\d+\.wbbasket\.ru$/.test(target.hostname)){counts.photos++;return new Response('fixture-photo',{headers:{'Content-Type':'image/webp'}});}
      if(target.hostname==='api.telegram.org'&&target.pathname.endsWith('/sendPhoto')){
        const {caption,reply_markup,photo}=JSON.parse(options.body);
        const callback=reply_markup?.inline_keyboard?.flat()?.find(button=>/^l[0-9]+$/.test(button.callback_data||''))?.callback_data;
        const pid=Number(callback?.slice(1));fixtureIdentity(pid);
        simulatedMessages.push({caption,reply_markup,photo});counts.simulatedTelegram++;
        return Response.json({ok:true,result:{message_id:900000+pid}});
      }
      if(target.hostname==='api.telegram.org'&&target.pathname.endsWith('/editMessageReplyMarkup'))return Response.json({ok:true,result:{reply_markup:JSON.parse(options.body).reply_markup}});
      throw Error('EXTERNAL_ACCESS_FORBIDDEN');
    };
    const meter=observeD1(env.DB,{trackQueries:false}),runtime={...env,DB:meter.DB,PROJECTION_FIXTURE_FETCH:fixtureFetch,PROJECTION_STATS:stats};
    let result;
    if(url.pathname!=='/replay'){
      if(!storeFactory)return new Response('PREPARATION_NOT_IN_REFERENCE',{status:404});
      const store=storeFactory(runtime);
      result=url.pathname==='/init'?await store.init():await store.prepare(await request.json());
    }else{
      const waits=[],localCtx={waitUntil:p=>{waits.push(p);ctx?.waitUntil(p);}};
      result=await worker.scheduled({scheduledTime:Date.now()},runtime,localCtx);await Promise.all(waits);
    }
    return Response.json({scope:'SYNTHETIC_FULL_CRON_PROJECTION_STAGING',buildLabel,firstInvocation,result,counts,simulatedMessages,projection:stats,
      mainD1:meter.metrics,metadataComplete:meter.coverage.complete,livePricesValidated:0});
  }};
}
