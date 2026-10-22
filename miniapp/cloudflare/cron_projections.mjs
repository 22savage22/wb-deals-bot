// Isolated prototype only. No imports of runtime modules, migrations on reads,
// network, model calls, schedules, policies, voters or aggregate feedback cache.
// Parent supplies the ORIGINAL pure implementations from its prototype copy.
export const PROJECTION_CORE_ID='aacdeded-216b-4f5a-af1a-081eef724d04';
export const PROJECTION_LIMITS=Object.freeze({prepare:20,read:300,readChunks:4,records:1000,rawChars:32768,outputChars:16384,batchChars:196608});
const forbidden=new Set(['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20','653d8f5c-a0f5-43b0-9118-fbaaa4bef69f']);
export const PROJECTION_SCHEMA=Object.freeze([
 `CREATE TABLE IF NOT EXISTS cron_product_projections(
  pid INTEGER PRIMARY KEY CHECK(pid>0),source_kind TEXT NOT NULL CHECK(source_kind IN ('inventory','products')),
  raw_product TEXT NOT NULL CHECK(length(raw_product)<=32768),raw_profile TEXT CHECK(length(raw_profile)<=32768),
  version_key TEXT NOT NULL,image_key TEXT NOT NULL,output TEXT NOT NULL CHECK(json_valid(output) AND length(output)<=16384),
  prepared_at INTEGER NOT NULL CHECK(prepared_at>0))`,
 'CREATE INDEX IF NOT EXISTS cron_projections_prepared ON cron_product_projections(prepared_at,pid)',
 'CREATE TABLE IF NOT EXISTS cron_projection_counts(id INTEGER PRIMARY KEY CHECK(id=1),records INTEGER NOT NULL CHECK(records BETWEEN 0 AND 1000))',
 'INSERT OR IGNORE INTO cron_projection_counts SELECT 1,COUNT(*) FROM cron_product_projections',
 `CREATE TRIGGER IF NOT EXISTS cron_projection_capacity BEFORE INSERT ON cron_product_projections
  WHEN NOT EXISTS(SELECT 1 FROM cron_product_projections WHERE pid=NEW.pid) AND (SELECT records FROM cron_projection_counts WHERE id=1)>=1000
  BEGIN SELECT RAISE(IGNORE); END`,
 'CREATE TRIGGER IF NOT EXISTS cron_projection_insert AFTER INSERT ON cron_product_projections BEGIN UPDATE cron_projection_counts SET records=records+1 WHERE id=1; END',
 'CREATE TRIGGER IF NOT EXISTS cron_projection_delete AFTER DELETE ON cron_product_projections BEGIN UPDATE cron_projection_counts SET records=records-1 WHERE id=1; END'
]);
const currentProduct='COALESCE(i.data,p.data)',currentProfile="CASE WHEN i.pid IS NOT NULL THEN v.profile ELSE NULL END",currentKind="CASE WHEN i.pid IS NOT NULL THEN 'inventory' ELSE 'products' END";
const exactCurrent=`c.raw_product=${currentProduct} AND c.raw_profile IS (${currentProfile}) AND c.source_kind=(${currentKind})`;
// No raw profile/product leaves this hit query. Exact BINARY string comparisons
// happen inside D1; JSON/model/image validity was established before the CAS.
export const PROJECTION_READ_SQL=`SELECT c.pid,c.output FROM cron_product_projections c
 JOIN (SELECT DISTINCT value AS pid FROM json_each(?) LIMIT 300) wanted ON wanted.pid=c.pid
 LEFT JOIN scheduler_inventory i ON i.pid=c.pid LEFT JOIN products p ON p.id=c.pid AND i.data IS NULL
 LEFT JOIN visual_profiles v ON v.pid=i.pid
 WHERE c.version_key=? AND c.image_key=json_extract(c.output,'$.imageKey') AND ${exactCurrent} LIMIT 300`;
export const PROJECTION_READ_KNOWN_SQL=`SELECT c.pid,c.output FROM cron_product_projections c
 JOIN (SELECT json_extract(value,'$.pid') AS pid,json_extract(value,'$.data') AS data FROM json_each(?) LIMIT 300) wanted ON wanted.pid=c.pid
 LEFT JOIN scheduler_inventory i ON i.pid=c.pid LEFT JOIN products p ON p.id=c.pid AND i.data IS NULL
 LEFT JOIN visual_profiles v ON v.pid=i.pid
 WHERE c.version_key=? AND c.image_key=json_extract(c.output,'$.imageKey') AND c.raw_product=wanted.data AND ${exactCurrent} LIMIT 300`;
export const PROJECTION_FEEDBACK_SQL=`SELECT votes.pid,votes.voter,votes.sentiment,
 CASE WHEN json_type(c.output,'$.productType')='text' THEN json_extract(c.output,'$.productType') ELSE NULL END AS projected_type,
 json_extract(c.output,'$.qualityVisualKeys') AS projected_visualKeys,
 CASE WHEN json_type(c.output,'$.visualPresent') IN ('true','false') THEN json_extract(c.output,'$.visualPresent') ELSE NULL END AS visualPresent
 FROM (SELECT pid,voter,sentiment FROM reaction_votes INDEXED BY reaction_votes_quality_recent
 WHERE scope='channel' ORDER BY last_event DESC LIMIT 500) votes
 LEFT JOIN scheduler_inventory i ON i.pid=votes.pid LEFT JOIN products p ON p.id=votes.pid AND i.data IS NULL
 LEFT JOIN visual_profiles v ON v.pid=i.pid LEFT JOIN cron_product_projections c ON c.pid=votes.pid
 AND c.version_key=? AND json_extract(c.output,'$.versionKey')=c.version_key
 AND c.image_key=json_extract(c.output,'$.imageKey') AND ${exactCurrent}`;
const sourcesSQL=`SELECT wanted.pid,${currentProduct} AS raw_product,${currentProfile} AS raw_profile,${currentKind} AS source_kind,
 CASE WHEN c.version_key=? AND ${exactCurrent} THEN 1 ELSE 0 END AS already_current
 FROM (SELECT value AS pid FROM json_each(?) LIMIT 20) wanted
 LEFT JOIN scheduler_inventory i ON i.pid=wanted.pid LEFT JOIN products p ON p.id=wanted.pid AND i.data IS NULL
 LEFT JOIN visual_profiles v ON v.pid=i.pid LEFT JOIN cron_product_projections c ON c.pid=wanted.pid`;
const upsertSQL=`INSERT INTO cron_product_projections(pid,source_kind,raw_product,raw_profile,version_key,image_key,output,prepared_at)
 SELECT json_extract(patch.value,'$.pid'),json_extract(patch.value,'$.source_kind'),json_extract(patch.value,'$.raw_product'),
 json_extract(patch.value,'$.raw_profile'),json_extract(patch.value,'$.version_key'),json_extract(patch.value,'$.image_key'),
 json_extract(patch.value,'$.output'),json_extract(patch.value,'$.prepared_at') FROM json_each(?) patch
 LEFT JOIN scheduler_inventory i ON i.pid=json_extract(patch.value,'$.pid')
 LEFT JOIN products p ON p.id=json_extract(patch.value,'$.pid') AND i.data IS NULL LEFT JOIN visual_profiles v ON v.pid=i.pid
 WHERE json_extract(patch.value,'$.raw_product')=${currentProduct}
 AND json_extract(patch.value,'$.raw_profile') IS (${currentProfile})
 AND json_extract(patch.value,'$.source_kind')=(${currentKind})
 ON CONFLICT(pid) DO UPDATE SET source_kind=excluded.source_kind,raw_product=excluded.raw_product,raw_profile=excluded.raw_profile,
 version_key=excluded.version_key,image_key=excluded.image_key,output=excluded.output,prepared_at=excluded.prepared_at
 RETURNING pid`;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>Number.isSafeInteger(value)&&value>0&&value<1e12;
function idsInput(ids,max){if(!Array.isArray(ids)||ids.length>max||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw Error('PROJECTION_IDS_INVALID');return ids;}
function time(value){if(!Number.isSafeInteger(value)||value<=0)throw Error('PROJECTION_TIME_INVALID');return value;}
function boundedRaw(value,nullable=false){return nullable&&value===null||typeof value==='string'&&value.length>0&&value.length<=PROJECTION_LIMITS.rawChars;}
function chunks(records){
 const result=[];let group=[],chars=2;
 for(const record of records){const entry=JSON.stringify(record);if(entry.length+2>PROJECTION_LIMITS.batchChars)throw Error('PROJECTION_RECORD_TOO_LARGE');
  if(group.length&&chars+entry.length+1>PROJECTION_LIMITS.batchChars){result.push('['+group.join(',')+']');group=[];chars=2;}
  group.push(entry);chars+=entry.length+1;
 }if(group.length)result.push('['+group.join(',')+']');return result;
}
export function createCronProjectionTools(deps={}){
 const functions=['productType','ownerCategory','productGroup','audience','nativeGroups','profileFeatures','visualSourceVersion'];
 if(functions.some(key=>typeof deps[key]!=='function')||typeof deps.visualModel!=='string'||!deps.visualModel||deps.visualModel.length>200
  ||!Number.isSafeInteger(deps.visualVersion)||deps.visualVersion<1||!Number.isSafeInteger(deps.normalizationRevision)||deps.normalizationRevision<1
  ||typeof deps.algorithmVersion!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(deps.algorithmVersion))throw Error('PROJECTION_DEPENDENCIES_INVALID');
 // Copy dependencies and version stamp, so mutating the caller's options cannot
 // make an old output pass as a result of another implementation.
 const {productType,ownerCategory,productGroup,audience,nativeGroups,profileFeatures,visualSourceVersion,visualModel,visualVersion,normalizationRevision,algorithmVersion}=deps;
 const versionKey=JSON.stringify([algorithmVersion,visualModel,visualVersion,normalizationRevision]);
 function outputValue(raw){
  if(typeof raw!=='string'||raw.length>PROJECTION_LIMITS.outputChars)return null;
  let p;try{p=JSON.parse(raw);}catch{return null;}
  const native=p?.nativeGroups;
  if(!object(p)||p.versionKey!==versionKey||typeof p.productType!=='string'||!p.productType||typeof p.imageKey!=='string'
   ||!(p.ownerCategory===null||['textbooks','study_aids','notebooks','stationery','books'].includes(p.ownerCategory))
   ||!['clothes','shoes','accessories','other'].includes(p.productGroup)||!['children','unisex','women','men','unknown'].includes(p.audience)
   ||!object(native)||!['women','men','neutral'].includes(native.audience)||!(native.accessory===null||['bags','belts','caps','jewelry'].includes(native.accessory))
   ||!Array.isArray(p.qualityVisualKeys)||p.qualityVisualKeys.length>18||p.qualityVisualKeys.some(k=>typeof k!=='string'||k.length>1024||!k.startsWith('visual.')||k.startsWith('visual.group=')||k.startsWith('visual.combo='))
   ||!object(p.riverFeatures)||Object.keys(p.riverFeatures).length>27||Object.entries(p.riverFeatures).some(([key,value])=>!key.startsWith('visual.')||key.length>1024||value!==1)
   ||typeof p.visualPresent!=='boolean')return null;
  return {...p,nativeGroups:{audience:native.audience,accessory:native.accessory===null?undefined:native.accessory}};
 }
 function prepareProductProjection({pid,rawProduct,rawProfile=null,sourceKind='inventory',now=Date.now()}={}){
  if(!validId(pid)||!boundedRaw(rawProduct)||!boundedRaw(rawProfile,true)||!['inventory','products'].includes(sourceKind)||sourceKind==='products'&&rawProfile!==null)return null;
  time(now);let product,profile=null,imageKey,result;
  try{
   product=JSON.parse(rawProduct);if(!object(product))return null;
   imageKey=visualSourceVersion(product);if(typeof imageKey!=='string'||imageKey.length>PROJECTION_LIMITS.rawChars)return null;
   if(rawProfile!==null){
    profile=JSON.parse(rawProfile);
    // Do not create negative cache entries for malformed, stale or wrong-model
    // profiles. Caller must execute ORIGINAL error/filter semantics on a miss.
    if(!object(profile)||profile.version!==visualVersion||profile.model!==visualModel||profile.source_version!==imageKey)return null;
   }
   const riverFeatures=profileFeatures(profile),qualityVisualKeys=Object.keys(riverFeatures).filter(k=>!k.startsWith('visual.group=')&&!k.startsWith('visual.combo=')&&!(k.startsWith('visual.style=')&&profile.fields?.style?.hypothesis!==false));
   const native=nativeGroups(product);
   result={versionKey,productType:productType(product),ownerCategory:ownerCategory(product),productGroup:productGroup(product),audience:audience(product),
    nativeGroups:{audience:native.audience,accessory:native.accessory??null},qualityVisualKeys,riverFeatures,visualPresent:profile!==null,imageKey};
  }catch{return null;}
  let output;try{output=JSON.stringify(result);}catch{return null;}if(!outputValue(output))return null;
  return {pid,source_kind:sourceKind,raw_product:rawProduct,raw_profile:rawProfile,version_key:versionKey,image_key:imageKey,output,prepared_at:now};
 }
 // Pure proof helper: no hash substitutes for exact raw source identity.
 function validateProductProjection(record,{pid=record?.pid,rawProduct,rawProfile=null,sourceKind='inventory'}={}){
  if(!object(record)||!validId(pid)||record.pid!==pid||record.version_key!==versionKey||record.raw_product!==rawProduct||record.raw_profile!==rawProfile||record.source_kind!==sourceKind)return null;
  const result=outputValue(record.output);return result&&record.image_key===result.imageKey?result:null;
 }
 function knownInput(rows){
  if(!Array.isArray(rows)||rows.length>PROJECTION_LIMITS.read||rows.some(r=>!object(r)||!validId(r.pid)||!boundedRaw(r.data))||new Set(rows.map(r=>r.pid)).size!==rows.length)throw Error('PROJECTION_ROWS_INVALID');
  let payloads;try{payloads=chunks(rows.map(r=>({pid:r.pid,data:r.data})));}catch{return null;}
  return payloads.length<=PROJECTION_LIMITS.readChunks?{payloads,inputs:new Map(rows.map(r=>[r.pid,r.data])),requested:rows.length}:null;
 }
 function knownResult(rows,input,queries){
  const projections=new Map();for(const row of rows){const result=outputValue(row.output);if(result&&input.inputs.has(row.pid))projections.set(row.pid,{...result,sourceData:input.inputs.get(row.pid)});}
  return {available:true,projections,requested:input.requested,hits:projections.size,queries};
 }
 const unavailableKnown=(requested,queries,reason='PROJECTION_READ_UNAVAILABLE')=>({available:false,projections:new Map(),requested,hits:0,queries,reason});
 const unavailableFeedback=(reason='PROJECTION_FEEDBACK_UNAVAILABLE')=>({available:false,rows:[],hits:0,queries:1,reason});
 function feedbackResult(rows){
  if(!Array.isArray(rows)||rows.length>500)return unavailableFeedback();
  const keys=new Map();
  for(const row of rows){
   if(!validId(row.pid)||typeof row.voter!=='string'||typeof row.sentiment!=='string'||typeof row.projected_type!=='string'||!row.projected_type||row.projected_type.length>PROJECTION_LIMITS.outputChars
    ||typeof row.projected_visualKeys!=='string'||row.projected_visualKeys.length>PROJECTION_LIMITS.outputChars||![0,1].includes(row.visualPresent))return unavailableFeedback('PROJECTION_FEEDBACK_MISS');
   if(!keys.has(row.projected_visualKeys)){
    const values=JSON.parse(row.projected_visualKeys);
    if(!Array.isArray(values)||values.length>18||values.some(k=>typeof k!=='string'||k.length>1024||!k.startsWith('visual.')||k.startsWith('visual.group=')||k.startsWith('visual.combo=')))return unavailableFeedback('PROJECTION_FEEDBACK_MISS');
    keys.set(row.projected_visualKeys,values);
   }
   if(row.visualPresent===0&&keys.get(row.projected_visualKeys).length)return unavailableFeedback('PROJECTION_FEEDBACK_MISS');
  }
  return {available:true,rows:rows.map(r=>({...r,visualPresent:r.visualPresent===1})),hits:rows.length,queries:1};
 }
 function openStore(env,{approvedDatabaseId}={}){
  if(env?.PROJECTION_ISOLATED!=='true'||!env.DB||typeof env.DB.prepare!=='function'||typeof env.DB.batch!=='function')throw Error('PROJECTION_ISOLATED_CORE_REQUIRED');
  if(approvedDatabaseId!==PROJECTION_CORE_ID||env.PROJECTION_DATABASE_ID!==approvedDatabaseId||forbidden.has(String(approvedDatabaseId).toLowerCase()))throw Error('PROJECTION_APPROVED_CORE_REQUIRED');
  const db=env.DB,q=(sql,...args)=>db.prepare(sql).bind(...args);
  return {
   async init(){try{await db.batch(PROJECTION_SCHEMA.map(sql=>db.prepare(sql)));return {initialized:true,databaseId:approvedDatabaseId};}catch{throw Error('PROJECTION_INITIALIZATION_UNAVAILABLE');}},
   async prepare({ids,now=Date.now()}={}){
    idsInput(ids,PROJECTION_LIMITS.prepare);time(now);if(!ids.length)return {requested:0,written:0,alreadyCurrent:0,uncacheable:0,missing:0,casSkipped:0,queries:0};
    try{
     const rows=(await q(sourcesSQL,versionKey,JSON.stringify(ids)).all()).results,records=[];let alreadyCurrent=0,uncacheable=0,missing=0;
     for(const row of rows){if(row.already_current){alreadyCurrent++;continue;}if(row.raw_product===null){missing++;continue;}
      const record=prepareProductProjection({pid:row.pid,rawProduct:row.raw_product,rawProfile:row.raw_profile,sourceKind:row.source_kind,now});
      if(record)records.push(record);else uncacheable++;
     }
     let written=0,queries=1;for(const payload of chunks(records)){written+=(await q(upsertSQL,payload).all()).results.length;queries++;}
     return {requested:ids.length,written,alreadyCurrent,uncacheable,missing,casSkipped:records.length-written,queries};
    }catch{throw Error('PROJECTION_PREPARE_UNAVAILABLE');}
   },
   async read(ids){
    idsInput(ids,PROJECTION_LIMITS.read);if(!ids.length)return {available:true,projections:new Map(),requested:0,hits:0,queries:0};
    try{
     const rows=(await q(PROJECTION_READ_SQL,JSON.stringify(ids),versionKey).all()).results,projections=new Map();
     for(const row of rows){const result=outputValue(row.output);if(result&&validId(row.pid))projections.set(row.pid,result);}
     return {available:true,projections,requested:ids.length,hits:projections.size,queries:1};
    }catch{return {available:false,projections:new Map(),requested:ids.length,hits:0,queries:1,reason:'PROJECTION_READ_UNAVAILABLE'};}
   },
   async readKnown(rows){
    const input=knownInput(rows);if(!input)return unavailableKnown(rows.length,0,'PROJECTION_INPUT_TOO_LARGE');let queries=0;
    try{
     const found=[];for(const payload of input.payloads){queries++;found.push(...(await q(PROJECTION_READ_KNOWN_SQL,payload,versionKey).all()).results);}
     return knownResult(found,input,queries);
    }catch{return unavailableKnown(rows.length,queries);}
   },
   async readFeedback(){
    try{return feedbackResult((await q(PROJECTION_FEEDBACK_SQL,versionKey).all()).results);}catch{return unavailableFeedback();}
   },
   async readContext(rows){
    const input=knownInput(rows);if(!input)return {available:false,feedback:unavailableFeedback(),known:unavailableKnown(rows.length,0,'PROJECTION_INPUT_TOO_LARGE'),queries:0};
    const statements=[q(PROJECTION_FEEDBACK_SQL,versionKey),...input.payloads.map(payload=>q(PROJECTION_READ_KNOWN_SQL,payload,versionKey))];
    try{
     // D1 batch is one transaction: feedback order, source/profile validation
     // and candidate metadata all belong to the same database snapshot.
     const results=await db.batch(statements);if(results.length!==statements.length)throw Error('PROJECTION_BATCH_INVALID');
     const feedback=feedbackResult(results[0].results),known=knownResult(results.slice(1).flatMap(r=>r.results),input,input.payloads.length);
     return {available:feedback.available&&known.available,feedback,known,queries:statements.length};
    }catch{return {available:false,feedback:unavailableFeedback(),known:unavailableKnown(rows.length,input.payloads.length),queries:statements.length};}
   }
  };
 }
 return Object.freeze({versionKey,prepareProductProjection,validateProductProjection,openStore});
}
