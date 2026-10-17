// Private service-binding target. No public route, Cron, WB fetch, Telegram,
// AI, runtime init/start/stop endpoint or production D1 binding.
import {openPassivePriceStore} from './passive_store.mjs';
import {observeD1} from '../cloudflare/d1_budget.mjs';
export const LOCAL_PASSIVE_DB='local-isolated-passive-price-staging';
async function boundedJSON(request){
  if(!request.body)return null;const reader=request.body.getReader(),chunks=[];let length=0;
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>65536){await reader.cancel();return null;}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}
}
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function createPassivePriceWorker({approvedDatabaseId}={}){return {
  async fetch(request,env){
    // Early OFF guard is intentionally before request body or DB access.
    if(env.PRICE_CAPTURE_ENABLED!=='1')return json({status:'disabled'},404);
    const u=new URL(request.url);
    if(request.method!=='POST'||u.origin!=='https://price-observer.internal'||u.pathname!=='/capture'||u.search)return json({status:'not_found'},404);
    let event;try{event=await boundedJSON(request);}catch{return json({status:'invalid_event'},400);}
    if(!event||event.runId!==env.PRICE_OBSERVATION_RUN_ID)return json({status:'invalid_event'},400);
    try{
      openPassivePriceStore(env,{approvedDatabaseId}); // Validate unwrapped binding identity first.
      const meter=observeD1(env.PRICE_DB),store=openPassivePriceStore({...env,PRICE_DB:meter.DB},{approvedDatabaseId});
      const result=await store.capture(event,{now:Date.now()});
      return json({status:result.status??result.reason??'unavailable',accepted:result.responseCount,d1:{...meter.metrics,metadata_complete:meter.coverage.complete}});
    }catch{return json({status:'unavailable'},503);}
  }
};}
// This local identity is never a real deployment approval. Release preparation
// generates a pinned entrypoint for the operator-approved dedicated D1 ID.
export default createPassivePriceWorker({approvedDatabaseId:LOCAL_PASSIVE_DB});
