import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {createTasteState,setTasteRating,setAudienceSignals,buildTasteProfile,trimTasteState} from './taste.mjs';
import {compareSameCandidates} from './comparison.mjs';
import {fashionCategory} from './calibration.mjs';
import {normalizeTasteInput,buildTasteReport,trustedTraitsForProduct} from './taste_report.mjs';
import {recommendForProfiles} from './recommendations.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function createGalleryServer({reportPath=path.join(root,'docs/shadow-20261011/report.json'),statePath=path.join(root,'.test-temp/value-taste/ratings.json'),visualPath=path.join(root,'docs/shadow-20261011/reviewed-visual.json'),priceCheckPath=path.join(root,'docs/shadow-20261011/price-check.json'),port=8772,clock=Date.now}={}){
  const report=JSON.parse(await fs.readFile(reportPath,'utf8')),products=new Map(report.products.map(p=>[p.id,p]));
  const fashionIds=new Set(report.products.filter(p=>fashionCategory(p).allowed&&(!report.fashionIds||report.fashionIds.includes(p.id))).map(p=>p.id));
  const fashionProducts=report.products.filter(p=>fashionIds.has(p.id));
  const html=await fs.readFile(new URL('./gallery.html',import.meta.url));
  let ratings=createTasteState(),serial=Promise.resolve();const csrf=randomBytes(32).toString('base64url');
  // A wall-clock correction during one session must not trim just-saved votes.
  // This is a local logical clock, not a fabricated product observation time.
  let logicalTime=clock();const now=()=>logicalTime=Math.max(logicalTime,clock());
  try{ratings=JSON.parse(await fs.readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('LOCAL_TASTE_FILE_INVALID');}
  ratings=trimTasteState(ratings,{now:now()}).state;
  let revision=Number(ratings.localRevision||0);
  const verifiedPhoto=async id=>{const p=products.get(id);if(!p||!/^[a-f0-9]{64}$/.test(p.imageHash||''))throw Error('PHOTO_NOT_VERIFIED');const bytes=await fs.readFile(path.join(path.dirname(reportPath),'photos',`${id}.webp`));if(createHash('sha256').update(bytes).digest('hex')!==p.imageHash)throw Error('PHOTO_NOT_VERIFIED');return bytes;};
  let visual={},priceCheck=report.budgetProbe||null;
  try{visual=JSON.parse(await fs.readFile(visualPath,'utf8')).profiles||{};}catch(e){if(e.code!=='ENOENT')throw Error('LOCAL_VISUAL_FILE_INVALID');}
  try{priceCheck=JSON.parse(await fs.readFile(priceCheckPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('LOCAL_PRICE_RECEIPT_INVALID');}
  // Explicitly reviewed artifact + exact file hash, never raw model confidence.
  const traitsById={},photoObservationsById={};
  for(const p of fashionProducts){const traits=trustedTraitsForProduct(p,visual);if(!traits)continue;try{await verifiedPhoto(p.id);traitsById[p.id]=traits;}catch{/* Invalid photo: no traits or invented replacement. */}}
  try{
    const observations=JSON.parse(await fs.readFile(path.join(root,'docs/shadow-20261011/photo-observations.json'),'utf8'));
    if(observations.trainingUse===false&&observations.source==='manual_photo_review')for(const p of fashionProducts){const note=observations.products?.[p.id];if(note?.imageHash!==p.imageHash||typeof note.text!=='string')continue;try{await verifiedPhoto(p.id);photoObservationsById[p.id]={text:note.text,source:observations.source};}catch{/* Unverified observation cannot be displayed. */}}
  }catch(e){if(e.code!=='ENOENT')throw Error('LOCAL_PHOTO_OBSERVATIONS_INVALID');}
  const candidateHash=createHash('sha256').update(JSON.stringify(fashionProducts.map(p=>[p.id,p.imageHash,p.category,p.price,p.observedAt]))).digest('hex');
  // Import ONLY public aggregate feedback supplied in an offline artifact,
  // never voters, user IDs, production credentials or current D1 reads.
  for(const row of report.audienceSignals||[])if(products.has(row.id))ratings=setAudienceSignals(ratings,{nmId:row.id,product:products.get(row.id),likes:row.likes,dislikes:row.dislikes,bought:row.bought},{now:now()}).state;
  const summary=()=>{
    const at=now();ratings=trimTasteState(ratings,{now:at}).state;
    // Derived feature refresh is read-only. Never rewrite original votes merely
    // for opening results or receiving a newer trusted Visual artifact.
    const canonical=normalizeTasteInput(ratings,{products:fashionProducts,now:at,traitsById}).state;
    const scope={...canonical,audience:ratings.audience.filter(r=>fashionIds.has(r.nmId))};
    const profiles=Object.fromEntries(['owner','wife','audience'].map(p=>[p,buildTasteProfile(scope,p)]));
    const counter=report.comparison?.legacyCounter||0;
    const compareByProfile=Object.fromEntries(['owner','wife'].map(p=>[p,compareSameCandidates(fashionProducts,{profile:profiles[p],now:at,legacyCounter:counter,traitsById})]));
    const assessmentsByProfile=Object.fromEntries(['owner','wife'].map(p=>[p,compareByProfile[p].assessments]));
    const tasteReport=buildTasteReport(ratings,fashionProducts,{now:at,traitsById});
    tasteReport.photoObservationsById=photoObservationsById;
    const recommendationsByProfile=recommendForProfiles(fashionProducts,ratings,{now:at,traitsById,legacyCounter:counter});
    const archiveCounts=tasteReport.archiveCounts;
    return {revision,ratings:ratings.ratings,profiles,archiveCounts,compareByProfile,assessments:assessmentsByProfile.owner,assessmentsByProfile,tasteReport,recommendationsByProfile,
      analysis:{candidateCount:fashionProducts.length,candidateHash,revision,comparisonKind:'COUNTERFACTUAL_NEUTRAL_VS_CURRENT',source:priceCheck,reviewedVisualProducts:Object.keys(traitsById).length,additionalAiCalls:0,productionWrites:0,mode:'SHADOW'}};
  };
  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
  const server=http.createServer(async(req,res)=>{try{
    const ownPort=server.address().port,hosts=new Set([`127.0.0.1:${ownPort}`,`localhost:${ownPort}`]);
    if(!hosts.has(req.headers.host))return json(res,403,{error:'LOCAL_HOST_REQUIRED'});
    const url=new URL(req.url,`http://${req.headers.host}`),origin=req.headers.origin;
    if(origin&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'CROSS_ORIGIN_DENIED'});
    if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});return res.end(html);}
    if(req.method==='GET'&&url.pathname==='/api/state'){await serial.catch(()=>{});return json(res,200,{...summary(),report,csrf});}
    if(req.method==='GET'&&/^\/photos\/\d{1,12}\.webp$/.test(url.pathname)){
      const id=Number(url.pathname.split('/').at(-1).split('.')[0]);if(!products.has(id))return json(res,404,{error:'UNKNOWN_PHOTO'});
      const photo=await verifiedPhoto(id);res.writeHead(200,{'content-type':'image/webp','cache-control':'private,max-age=3600','x-content-type-options':'nosniff'});return res.end(photo);
    }
    if(req.method==='POST'&&url.pathname==='/api/rate'){
      if(origin!==`http://${req.headers.host}`||req.headers['x-shadow-csrf']!==csrf)return json(res,403,{error:'CSRF_DENIED'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>1000)return json(res,413,{error:'BODY_TOO_LARGE'});}
      const data=JSON.parse(body);if(Object.keys(data).some(k=>!['profile','id','action'].includes(k))||!['owner','wife'].includes(data.profile)||!products.has(data.id)||!fashionIds.has(data.id))return json(res,400,{error:'INVALID_RATING'});
      if(data.action!=='undo')await verifiedPhoto(data.id);
      // Resolve all product/feature data SERVER-side; never trust client traits.
      serial=serial.catch(()=>{}).then(async()=>{
        const before=ratings,at=now(),product=products.get(data.id),next=setTasteRating(before,{profile:data.profile,nmId:data.id,action:data.action,product,traits:trustedTraitsForProduct(product,traitsById)},{now:at});
        if(next.changed){const safe=trimTasteState(next.state,{now:at}).state;safe.localRevision=revision+1;await fs.mkdir(path.dirname(statePath),{recursive:true});const tmp=statePath+'.tmp';await fs.writeFile(tmp,JSON.stringify(safe)+'\n');await fs.rename(tmp,statePath);ratings=safe;revision=safe.localRevision;}
        return summary();
      });return json(res,200,await serial);
    }
    return json(res,404,{error:'NOT_FOUND'});
  }catch(e){json(res,400,{error:/TASTE_/.test(e.message)?e.message:'LOCAL_OPERATION_FAILED'});}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const server=await createGalleryServer();console.log(`SHADOW_GALLERY http://127.0.0.1:${server.address().port}/ · local only · production untouched`);
}
