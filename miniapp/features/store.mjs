import {emptySubscriber,applySubscriberVote,subscriberFeatures,personalDeck,subscriberSummary,STYLE_GROUPS,STYLE_AUDIENCES,stylePriceEvidence,productAudience,audienceMatches} from './subscriber_taste.mjs';
import {SUPERFIND_DEFAULTS,superfindSettings,assessSuperfind,superfindPreview} from './superfind.mjs';
import {fashionCategory} from '../shadow/calibration.mjs';
const q=(db,sql,...args)=>db.prepare(sql).bind(...args);
const rows=async stmt=>(await stmt.all()).results;
export class FeatureError extends Error{constructor(status,message){super(message);this.status=status;}}
export const bad=(status,message)=>{throw new FeatureError(status,message);};
const validId=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
export async function catalogue(db){
  // One persistent shared snapshot row. It is refreshed by the catalogue adapter,
  // NEVER by page traffic or a swipe. Individual writes use indexed id lookups.
  const row=await q(db,"SELECT value FROM feature_meta WHERE key='shared_catalog_snapshot'").first();if(!row)return [];
  const snapshot=JSON.parse(row.value);if(!Array.isArray(snapshot.products)||snapshot.products.length>120)bad(503,'Каталог временно недоступен');return snapshot.products;
}
export async function account(db,uid){const row=await q(db,'SELECT version,model,filters FROM style_accounts WHERE user_id=?',uid).first();return row?{version:row.version,model:JSON.parse(row.model),filters:JSON.parse(row.filters)}:{version:0,model:emptySubscriber(),filters:{}};}
export async function styleMe(db,uid){const a=await account(db,uid);return {version:a.version,filters:filters(a.filters),filtersConfigured:Object.keys(a.filters).length>0,...subscriberSummary(a.model),source:'INDIVIDUAL_SUBSCRIBER_ONLY'};}
export async function forgetSubscriber(db,uid){
  // Atomic privacy cleanup. Empty revision is the only retained tombstone;
  // stale in-flight writes cannot resurrect erased personal history.
  await db.batch([
    q(db,`INSERT INTO style_accounts(user_id,version,model,filters,last_request) VALUES(?,1,?,'{}',?) ON CONFLICT(user_id) DO UPDATE SET version=style_accounts.version+1,model=excluded.model,filters=excluded.filters,last_request=excluded.last_request`,uid,JSON.stringify(emptySubscriber()),crypto.randomUUID()),
    q(db,'DELETE FROM style_votes WHERE user_id=?',uid),q(db,'DELETE FROM style_saved WHERE user_id=?',uid),q(db,'DELETE FROM feature_requests WHERE user_id=?',uid)
  ]);
}
export async function styleFeed(db,uid,{mode='learn',cursor=0,now=Date.now()}={}){
  const a=await account(db,uid),catalog=await catalogue(db),ids=JSON.stringify(catalog.map(row=>row.product.id));
  const [rated,saved]=await Promise.all([
    rows(q(db,'SELECT pid FROM style_votes WHERE user_id=? AND pid IN (SELECT value FROM json_each(?))',uid,ids)),
    rows(q(db,'SELECT pid FROM style_saved WHERE user_id=? AND pid IN (SELECT value FROM json_each(?))',uid,ids))]);
  const deck=personalDeck(catalog.map(row=>row.product),a.model,{seenIds:rated.map(row=>row.pid),savedIds:saved.map(row=>row.pid),visualById:Object.fromEntries(catalog.map(row=>[row.product.id,row.visual])),now,mode,filters:a.filters,seed:uid+cursor,limit:20});
  const selectedFilters=filters(a.filters),selectedGroups=selectedFilters.groups,
    matching=catalog.filter(({product:p})=>{const category=fashionCategory(p);return category.allowed&&(!selectedGroups.length||selectedGroups.includes(category.group));}),
    audienceCount=matching.filter(({product:p})=>audienceMatches(p,selectedFilters.audience)).length,
    freshPriceCount=matching.filter(({product:p})=>audienceMatches(p,selectedFilters.audience)&&stylePriceEvidence(p,now).confirmed).length,
    hasPriceFilter=selectedFilters.minPrice!=null||selectedFilters.maxPrice!=null;
  return {version:a.version,items:deck,mode,modelReady:a.model.samples>=5,priceFilterRequiresFreshEvidence:true,noMoreVerifiedPhotos:deck.length===0,
    emptyReason:deck.length?null:hasPriceFilter&&!freshPriceCount?'fresh_price_evidence_unavailable':selectedFilters.audience!=='all'&&!audienceCount?'audience_evidence_unavailable':'no_unseen_matching_products',
    catalogueEvidence:{total:catalog.length,audienceKnown:catalog.filter(({product:p})=>productAudience(p)!=='unknown').length,matchingAudience:audienceCount,freshPriceCount}};
}
export async function favorites(db,uid){
  const list=await rows(q(db,'SELECT c.data FROM style_saved s JOIN feature_catalog c ON c.id=s.pid WHERE s.user_id=? ORDER BY s.ts DESC,s.pid DESC LIMIT 100',uid));
  return list.map(({data})=>{const p=JSON.parse(data);return {id:p.id,name:p.name,image:p.displayImage??p.image,url:`https://www.wildberries.ru/catalog/${p.id}/detail.aspx`};});
}
export function filters(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['group','groups','audience','minPrice','maxPrice'].includes(key)))bad(400,'Некорректные фильтры');
  const result={audience:input.audience??'all',groups:[]};if(!STYLE_AUDIENCES.includes(result.audience))bad(400,'Некорректная аудитория');
  if(input.group!=null&&input.group!==''&&!STYLE_GROUPS.includes(input.group))bad(400,'Некорректная категория');
  if(input.groups!=null){
    if(!Array.isArray(input.groups)||input.groups.length>4||input.groups.some(group=>!STYLE_GROUPS.includes(group)))bad(400,'Некорректные категории');
    result.groups=STYLE_GROUPS.filter(group=>input.groups.includes(group));
    if(input.group&&!(result.groups.length===1&&result.groups[0]===input.group))bad(400,'Конфликт фильтров категорий');
  }else if(input.group)result.groups=[input.group];
  if(result.groups.length===1)result.group=result.groups[0]; // Read compatibility for the earlier single-category UI.
  for(const key of ['minPrice','maxPrice'])if(input[key]!=null){if(!Number.isFinite(input[key])||input[key]<0||input[key]>1000000)bad(400,'Некорректная цена');result[key]=input[key];}
  if(result.minPrice!=null&&result.maxPrice!=null&&result.minPrice>result.maxPrice)bad(400,'Минимальная цена выше максимальной');return result;
}
export async function mutate(db,uid,input,kind,{now=Date.now()}={}){
  if(!Number.isSafeInteger(input.version)||input.version<0||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{16,80}$/.test(input.requestId))bad(400,'Некорректный запрос');
  const signature=JSON.stringify({kind,version:input.version,id:input.id,action:input.action,saved:input.saved,filters:input.filters,settings:input.settings}),
    priorReceipt=await q(db,'SELECT payload,response FROM feature_requests WHERE user_id=? AND id=?',uid,input.requestId).first();
  if(priorReceipt){if(priorReceipt.payload!==signature)bad(409,'Этот запрос уже использован для другого действия');return JSON.parse(priorReceipt.response);}
  const a=await account(db,uid);if(a.version!==input.version)bad(409,'Настройки изменились в другой вкладке. Обновите экран');
  const model=structuredClone(a.model),nextVersion=a.version+1,response={ok:true,version:nextVersion,requestId:input.requestId},operations=[],attempt=crypto.randomUUID();
  const gate=`EXISTS(SELECT 1 FROM style_accounts WHERE user_id=? AND version=? AND last_request=?)`;
  // The gate identifies THIS successful CAS attempt, not the client request ID.
  // Identical concurrent retries share an ID; reusing it as the gate allowed a
  // losing batch to execute side effects against its winner's revision.
  const gated=(sql,...args)=>q(db,sql,...args,uid,nextVersion,attempt);
  let nextModel=model,nextFilters=a.filters;
  if(['vote','favorite'].includes(kind)){
    if(!validId(input.id))bad(400,'Некорректный товар');
    const row=await q(db,'SELECT data,visual FROM feature_catalog WHERE id=?',input.id).first();if(!row)bad(404,'Товар не найден');
    const p=JSON.parse(row.data),visual=JSON.parse(row.visual);
    if(kind==='vote'){
      if(!['like','dislike','more','block_similar','skip'].includes(input.action))bad(400,'Некорректная оценка');
      const old=await q(db,'SELECT action,features FROM style_votes WHERE user_id=? AND pid=?',uid,input.id).first();
      if(!old&&model.seen>=500)bad(409,'Сохранено 500 оценок/пропусков. Можно начать обучение заново');
      const vote={id:input.id,action:input.action,features:subscriberFeatures(p,visual,now)};
      nextModel=applySubscriberVote(model,old?{id:input.id,action:old.action,features:JSON.parse(old.features)}:null,vote);
      operations.push(gated(`INSERT INTO style_votes(user_id,pid,action,features,ts) SELECT ?,?,?,?,? WHERE ${gate} ON CONFLICT(user_id,pid) DO UPDATE SET action=excluded.action,features=excluded.features,ts=excluded.ts`,uid,input.id,input.action,JSON.stringify(vote.features),now));
    }else{
      if(typeof input.saved!=='boolean')bad(400,'Некорректное сохранение');
      const existing=await q(db,'SELECT pid FROM style_saved WHERE user_id=? AND pid=?',uid,input.id).first();
      if(input.saved&&!existing&&(model.saved??0)>=100)bad(409,'В избранном максимум 100 вещей');
      nextModel.saved=(model.saved??0)+(input.saved&&!existing?1:!input.saved&&existing?-1:0);
      if(input.saved)operations.push(gated(`INSERT INTO style_saved(user_id,pid,ts) SELECT ?,?,? WHERE ${gate} ON CONFLICT(user_id,pid) DO NOTHING`,uid,input.id,now));
      else operations.push(gated(`DELETE FROM style_saved WHERE user_id=? AND pid=? AND ${gate}`,uid,input.id));
    }
  }else if(kind==='filters')nextFilters=filters(input.filters);
  else if(kind==='reset'||kind==='forget'){
    nextModel=emptySubscriber();nextModel.saved=kind==='reset'?model.saved??0:0;nextFilters={};
    operations.push(gated(`DELETE FROM style_votes WHERE user_id=? AND ${gate}`,uid),gated(`DELETE FROM feature_requests WHERE user_id=? AND ${gate}`,uid));
    if(kind==='forget')operations.push(gated(`DELETE FROM style_saved WHERE user_id=? AND ${gate}`,uid));
    // Keep only an empty account revision to reject stale pre-deletion requests.
    response.deletedHistory=true;response.favoritesKept=kind==='reset';
  }else if(kind==='super-settings'){
    const settings=superfindSettings(input.settings);
    operations.push(gated(`INSERT INTO superfind_settings(id,version,data) SELECT 1,?,? WHERE ${gate} ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data`,nextVersion,JSON.stringify(settings)));
  }else if(kind==='super-decision'){
    if(!validId(input.id)||!['approve','reject'].includes(input.action))bad(400,'Некорректное решение');
    const row=await q(db,'SELECT data,evidence_hash,state FROM superfind_candidates WHERE pid=?',input.id).first();if(!row)bad(404,'Кандидат не найден');
    if(input.action==='approve'){
      const p=await q(db,'SELECT data FROM feature_catalog WHERE id=?',input.id).first();if(!p)bad(409,'Карточка недоступна');
      const current=await settings(db),history=await publicationStatus(db,input.id);
      const assessment=assessSuperfind(JSON.parse(p.data),{now,settings:current.data,...history,comparables:(await catalogue(db)).map(row=>row.product)});
      if(!current.data.enabled||!assessment.eligible)bad(409,'Нет свежего подтверждения. Обновите кандидатов');
      if(await digest(JSON.stringify(JSON.parse(p.data)))!==row.evidence_hash)bad(409,'Карточка изменилась — требуется новый предпросмотр');
    }
    const nextState=input.action==='approve'?'approved_preview':'rejected_by_owner';
    if(row.state!==nextState)operations.push(gated(`UPDATE superfind_candidates SET state=? WHERE pid=? AND state<>? AND ${gate}`,nextState,input.id,nextState),
      gated(`INSERT INTO superfind_decisions(pid,decision,ts,evidence_hash) SELECT ?,?,?,? WHERE ${gate}`,input.id,nextState,now,row.evidence_hash),
      gated(`DELETE FROM superfind_decisions WHERE id IN (SELECT id FROM superfind_decisions ORDER BY ts DESC,id DESC LIMIT 10 OFFSET 100) AND ${gate}`));
    response.publication='FORBIDDEN_PREVIEW';
  }else bad(400,'Неизвестное действие');
  response.profile={...subscriberSummary(nextModel),filters:filters(nextFilters),filtersConfigured:Object.keys(nextFilters).length>0};
  const batch=[q(db,'INSERT OR IGNORE INTO style_accounts(user_id) VALUES(?)',uid),
    q(db,'UPDATE style_accounts SET version=?,model=?,filters=?,last_request=? WHERE user_id=? AND version=?',nextVersion,JSON.stringify(nextModel),JSON.stringify(nextFilters),attempt,uid,a.version),...operations,
    gated(`INSERT INTO feature_requests(user_id,id,payload,response,version) SELECT ?,?,?,?,? WHERE ${gate}`,uid,input.requestId,signature,JSON.stringify(response),nextVersion),
    gated(`DELETE FROM feature_requests WHERE user_id=? AND version<? AND ${gate}`,uid,nextVersion-40)];
  const results=await db.batch(batch);if(!results[1].meta.changes){
    // Concurrent retries of ONE request can both miss its first SELECT. The CAS
    // loser returns the winner's durable receipt, not an invented second action.
    const receipt=await q(db,'SELECT payload,response FROM feature_requests WHERE user_id=? AND id=?',uid,input.requestId).first();
    if(receipt?.payload===signature)return JSON.parse(receipt.response);
    bad(409,'Параллельное изменение. Обновите экран');
  }return response;
}
export async function settings(db){const row=await q(db,'SELECT version,data FROM superfind_settings WHERE id=1').first();return row?{version:row.version,data:JSON.parse(row.data)}:{version:0,data:{...SUPERFIND_DEFAULTS}};}
export async function publicationStatus(db,pid){
  const [proof,posted]=await Promise.all([q(db,"SELECT value FROM feature_meta WHERE key='publication_history_complete'").first(),q(db,'SELECT pid FROM feature_publications WHERE pid=?',pid).first()]);
  return {historyChecked:proof?.value==='1',published:!!posted};
}
async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function refreshSuperfind(db,id,now=Date.now()){
  const owner=crypto.randomUUID(),lease=await db.batch([
    q(db,`INSERT INTO feature_job_lock(id,job_id,owner,expires) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET job_id=excluded.job_id,owner=excluded.owner,expires=excluded.expires WHERE feature_job_lock.expires<=? OR (feature_job_lock.job_id=? AND feature_job_lock.owner=?)`,id,owner,now+30000,now,id,'queued:'+id),
    q(db,"UPDATE feature_jobs SET status='running',lease_until=? WHERE id=? AND (status='queued' OR (status='running' AND lease_until<=?)) AND EXISTS(SELECT 1 FROM feature_job_lock WHERE id=1 AND job_id=? AND owner=?)",now+30000,id,now,id,owner)
  ]);if(!lease[1].meta.changes){
    // A replay of an already completed job must not leave the shared slot busy.
    if(lease[0].meta.changes)await q(db,'UPDATE feature_job_lock SET expires=0 WHERE id=1 AND job_id=? AND owner=?',id,owner).run();
    return;
  }
  const gate='EXISTS(SELECT 1 FROM feature_job_lock WHERE id=1 AND job_id=? AND owner=?)';
  try{
    const catalog=await catalogue(db),s=await settings(db),proof=await q(db,"SELECT value FROM feature_meta WHERE key='publication_history_complete'").first(),
      published=new Set((await rows(q(db,'SELECT pid FROM feature_publications WHERE pid IN (SELECT value FROM json_each(?))',JSON.stringify(catalog.map(row=>row.product.id))))).map(row=>row.pid));
    const operations=[],rejections={};let eligible=0;
    for(const {product:p} of catalog.slice(0,40)){
      const a=assessSuperfind(p,{now,settings:s.data,comparables:catalog.map(row=>row.product),historyChecked:proof?.value==='1',published:published.has(p.id)});
      for(const reason of a.reasons)rejections[reason]=(rejections[reason]??0)+1;if(a.eligible)eligible++;
      operations.push(q(db,`INSERT INTO superfind_candidates(pid,data,assessment,evidence_hash,state,ts) SELECT ?,?,?,?,?,? WHERE ${gate} ON CONFLICT(pid) DO UPDATE SET data=excluded.data,assessment=excluded.assessment,evidence_hash=excluded.evidence_hash,state=CASE WHEN superfind_candidates.evidence_hash=excluded.evidence_hash AND superfind_candidates.state IN ('rejected_by_owner','approved_preview') THEN superfind_candidates.state ELSE excluded.state END,ts=excluded.ts`,p.id,JSON.stringify(p),JSON.stringify(a),await digest(JSON.stringify(p)),a.eligible?'pending_preview':'not_eligible',now,id,owner));
    }
    await db.batch([...operations,
      q(db,`DELETE FROM feature_jobs WHERE id IN (SELECT id FROM feature_jobs ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET 100) AND id<>? AND ${gate}`,id,id,owner),
      q(db,`UPDATE feature_jobs SET status='done',lease_until=0,result=? WHERE id=? AND ${gate}`,JSON.stringify({scanned:operations.length,eligible,rejections,publication:'NONE',sourceCalls:0,aiCalls:0}),id,id,owner)]);
  }catch{await q(db,`UPDATE feature_jobs SET status='error',lease_until=0,result=? WHERE id=? AND ${gate}`,JSON.stringify({error:'Проверка каталога временно недоступна',retryable:true}),id,id,owner).run();}
  finally{await q(db,'UPDATE feature_job_lock SET expires=0 WHERE id=1 AND job_id=? AND owner=?',id,owner).run();}
}
export async function superfindState(db,uid){
  const [config,owner,candidates,history]=await Promise.all([settings(db),account(db,uid),
    rows(q(db,"SELECT pid,data,assessment,state,ts FROM superfind_candidates WHERE state='pending_preview' ORDER BY ts DESC,pid LIMIT 20")),
    rows(q(db,'SELECT pid,decision,ts FROM superfind_decisions ORDER BY ts DESC,id DESC LIMIT 30'))]);
  const rejected=await rows(q(db,"SELECT pid,data,assessment,state,ts FROM superfind_candidates WHERE state='not_eligible' ORDER BY ts DESC,pid LIMIT 10"));
  const current=await catalogue(db),byId=new Map(current.map(row=>[row.product.id,row.product]));
  const proof=await q(db,"SELECT value FROM feature_meta WHERE key='publication_history_complete'").first(),posted=new Set((await rows(q(db,'SELECT pid FROM feature_publications WHERE pid IN (SELECT value FROM json_each(?))',JSON.stringify(candidates.map(row=>row.pid))))).map(row=>row.pid));
  const view=(row,recheck=false)=>{const p=byId.get(row.pid)??JSON.parse(row.data),assessment=recheck?assessSuperfind(p,{settings:config.data,comparables:current.map(row=>row.product),historyChecked:proof?.value==='1',published:posted.has(row.pid)}):JSON.parse(row.assessment);
    if(recheck&&!byId.has(row.pid)){assessment.eligible=false;assessment.reasons.push('card_missing_from_current_catalog');}
    return {id:row.pid,name:p.name,image:p.displayImage??p.image,state:row.state,reasons:assessment.reasons,proof:assessment.value.price,...(assessment.eligible?{preview:superfindPreview(p,assessment)}:{})};};
  const live=candidates.map(row=>view(row,true));
  return {version:owner.version,settings:config.data,candidates:live.filter(row=>row.preview),rejected:[...live.filter(row=>!row.preview),...rejected.map(row=>view(row))].slice(0,20),history,mode:'PREVIEW_ONLY',publicationEnabled:false,postingIntervalUntouched:true};
}
