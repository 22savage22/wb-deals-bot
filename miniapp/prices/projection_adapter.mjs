// PROTOTYPE COPY ONLY. The builder imports this into the pinned price-only tree.
// No production entrypoint imports it. Policies/votes/models are never cached.
import {createCronProjectionTools,PROJECTION_CORE_ID} from '../cloudflare/cron_projections.mjs';
import {productType,ownerCategory,summariseVotes} from '../cloudflare/audience_quality.mjs';
import {productGroup,audience} from '../cloudflare/selection_policy.mjs';
import {projectionNativeGroups} from '../cloudflare/native_scheduler.mjs';
import {cachedProfiles,visualSourceVersion,VISUAL_MODEL} from '../cloudflare/visual_enrichment.mjs';
import {profileFeatures,visualLabel,VISUAL_VERSION,NORMALIZATION_REVISION} from '../cloudflare/visual_features.mjs';

// Weak keys refer to immutable, private decoded objects, not env/DB/request IDs.
// Persistent hits come exclusively from the exact-source D1 queries.
const products=new WeakMap();let tools;
export function projectionTools(){
  return tools??=createCronProjectionTools({productType,ownerCategory,productGroup,audience,nativeGroups:projectionNativeGroups,
    profileFeatures,visualSourceVersion,visualModel:VISUAL_MODEL,visualVersion:VISUAL_VERSION,
    normalizationRevision:NORMALIZATION_REVISION,algorithmVersion:__WB_PROJECTION_ALGORITHM__});
}
export function projectionStore(env){return projectionTools().openStore(env,{approvedDatabaseId:PROJECTION_CORE_ID});}
export const preparedProduct=p=>p!==null&&typeof p==='object'?products.get(p):undefined;
function immutableProduct(product,projection){
  if(product&&typeof product==='object'&&!Array.isArray(product)){
    // Only fields consumed by the cached classifiers are shallow scalar fields.
    // The decoded clone is private; original input rows remain untouched.
    Object.freeze(product);products.set(product,projection);
  }
  return product;
}
export function decodePreparedProduct(raw,projection){
  const product=JSON.parse(raw);
  return projection?.sourceData===raw?immutableProduct(product,projection):product;
}
function note(env,kind,hit,miss){env.PROJECTION_STATS?.push({kind,hit,miss});}

export async function preparedAudienceContext(env,candidateIds,candidateRows,original){
  const rows=candidateRows.slice(0,300).map(r=>({pid:r.pid,data:r.data}));
  let context;
  try{context=await projectionStore(env).readContext(rows);}catch{}
  if(!context?.feedback?.available||!context?.known?.available||context.known.hits!==rows.length){
    note(env,'audience-miss',context?.known?.hits||0,rows.length-(context?.known?.hits||0));
    const fallback=await original(env,candidateIds);
    // A new cache miss is not permission to ignore feedback. If even ORIGINAL
    // cannot get fresh data, this prototype defers the publication attempt.
    return {...fallback,projectionUnsafe:fallback.available!==true};
  }
  const votes=context.feedback.rows,projections=context.known.projections;
  const profileIds=new Set([...new Set(votes.map(r=>r.pid))].slice(0,300)),visual=new Map();
  for(const vote of votes)if(profileIds.has(vote.pid)&&vote.visualPresent&&!visual.has(vote.pid))visual.set(vote.pid,JSON.parse(vote.projected_visualKeys));
  for(const id of candidateIds.slice(0,300)){
    const projection=projections.get(id);
    if(projection?.visualPresent)visual.set(id,projection.qualityVisualKeys);
  }
  const typed=votes.map(vote=>({pid:vote.pid,voter:vote.voter,sentiment:vote.sentiment,
    data:immutableProduct({}, {productType:vote.projected_type}),visual_keys:visual.get(vote.pid)||[]}));
  const result=summariseVotes(typed);
  for(const [key,stat] of result.traits)if(key.startsWith('visual.'))stat.label=visualLabel(key);
  note(env,'audience-hit',context.feedback.hits+context.known.hits,0);
  return {...result,visual,available:true,projections};
}

export async function preparedShadowVisuals(env,requestedIds){
  // Preserve the pre-SQL 300-ID bound of cachedProfiles, then deduplicate.
  const ids=[...new Set(requestedIds.slice(0,300))];
  let result;try{result=await projectionStore(env).read(ids);}catch{}
  const hits=result?.projections||new Map(),missing=ids.filter(id=>!hits.has(id));
  // A refreshed selected product commonly invalidates ONE projection. Read
  // just those current originals instead of discarding all valid hit results.
  const originals=await cachedProfiles(env,missing),features=new Map();
  for(const id of ids){const projection=hits.get(id);features.set(id,projection?projection.riverFeatures:profileFeatures(originals.get(id)));}
  note(env,'shadow',hits.size,missing.length);
  return id=>features.get(id)||{};
}
