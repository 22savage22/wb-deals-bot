// Imported ONLY by the isolated fetch-only harness, never production.
import {inferenceUsage,VISUAL_MODEL} from './visual_enrichment.mjs';
import {inspectAnalysis} from './visual_features.mjs';
import samples from './visual_staging_samples.json' with {type:'json'};
export const EXPERIMENT='gemma-schema-20261011-150';
export const EXPERIMENT_LIMIT=150, EXPERIMENT_RESERVE=110, EXPERIMENT_MAX_CALLS=3;
export const EXPERIMENT_PRODUCTS=samples.products.filter(p=>[1113687154,1138890506,449731422].includes(p.id));
const DB_ID='5779987d-1100-45ad-8cd4-9df9c1436a20';
const q=(e,s,...args)=>e.DB.prepare(s).bind(...args);
export function checkInputs(model,inputs){
  // One image: Google Gemma 4 documents <=1120 visual tokens. Text byte
  // ceiling4096 + generous4096 template allowance +600 completion =101.04
  // Neurons at9091/27273 perM. Reserve110; never use the full256k context
  // as though this fixed single-photo request actually filled it.
  const c=inputs?.messages?.[0]?.content;
  if(model!==VISUAL_MODEL||inputs?.messages?.length!==1||!Array.isArray(c)||c.length!==2||c[0].type!=='text'||typeof c[0].text!=='string'||new TextEncoder().encode(c[0].text).length>4096||c[1].type!=='image_url'||!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(c[1].image_url?.url||'')||inputs.max_completion_tokens!==600||inputs.chat_template_kwargs?.enable_thinking!==false||inputs.response_format?.type!=='json_object'||inputs.stream||inputs.n>1)throw Error('STAGING_INPUT_BOUND_REFUSED');
}
export async function initExperiment(e){
  if(e.VISUAL_STAGING!=='isolated'||e.VISUAL_STAGING_DB_ID!==DB_ID)throw Error('STAGING_ISOLATION_REFUSED');
  await e.DB.batch([
    q(e,'CREATE TABLE IF NOT EXISTS visual_experiment(id TEXT PRIMARY KEY,charged REAL NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,hold TEXT NOT NULL DEFAULT \'\')'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_experiment_calls(id TEXT PRIMARY KEY,experiment TEXT NOT NULL,image_hash TEXT NOT NULL,charged REAL NOT NULL,outcome TEXT NOT NULL,diagnostic TEXT NOT NULL,UNIQUE(experiment,image_hash))'),
    q(e,'INSERT OR IGNORE INTO visual_experiment(id) VALUES(?)',EXPERIMENT)
  ]);
  // Explicit owner-approved validator retest, only the three remaining hashes.
  // Keep the prior500 ledger and all failures/charges; do not reset any queue.
}
export async function experimentStatus(e){
  const budget=await q(e,'SELECT * FROM visual_experiment WHERE id=?',EXPERIMENT).first();
  const calls=(await q(e,'SELECT image_hash,charged,outcome,diagnostic FROM visual_experiment_calls WHERE experiment=? LIMIT 10',EXPERIMENT).all()).results.map(r=>({...r,diagnostic:JSON.parse(r.diagnostic)}));
  return {...budget,limit:EXPERIMENT_LIMIT,reserve:EXPERIMENT_RESERVE,max_calls:EXPERIMENT_MAX_CALLS,allowed_products:EXPERIMENT_PRODUCTS.map(p=>p.id),calls_receipts:calls};
}
export function responseDiagnostic(result){
  const raw=result?.response??result?.description??result?.choices?.[0]?.message?.content;
  let parsed=null;try{parsed=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
  const fields=parsed?.fields;
  let validation='VISUAL_INVALID_JSON',audit={rejected:[],accepted_fields:0};
  try{audit=inspectAnalysis(raw).diagnostic;validation=audit.accepted_fields>=2?'VALID_PROFILE':'VISUAL_EMPTY_PROFILE';}catch(error){if(/^VISUAL_(INVALID_JSON|INVALID_PROFILE)$/.test(error.message))validation=error.message;audit=error.validation||audit;}
  // Structure ONLY; no raw text, prompts, field evidence, URLs or credentials.
  return {validation,...audit,response_type:raw===null?'null':Array.isArray(raw)?'array':typeof raw,response_length:typeof raw==='string'?raw.length:null,json_parse_ok:!!parsed&&typeof parsed==='object'&&!Array.isArray(parsed),root_group_type:typeof parsed?.group,fields_count:fields&&typeof fields==='object'?Object.keys(fields).length:0,valid_evidence_fields:fields&&typeof fields==='object'?Object.values(fields).filter(f=>typeof f?.value==='string'&&typeof f?.confidence==='number'&&f.confidence>=.8&&typeof f?.evidence==='string'&&f.evidence.trim().length>=5).length:0,finish_reason:['stop','length','content_filter'].includes(result?.choices?.[0]?.finish_reason)?result.choices[0].finish_reason:null};
}
export async function reserveExperiment(e,hash){
  if(!EXPERIMENT_PRODUCTS.some(p=>p.hash===hash))throw Error('STAGING_IMAGE_BOUND_REFUSED');
  if(await q(e,'SELECT id FROM visual_experiment_calls WHERE experiment=? AND image_hash=?',EXPERIMENT,hash).first())throw Error('STAGING_REPEAT_REFUSED');
  const id=crypto.randomUUID();
  const reserved=await q(e,"UPDATE visual_experiment SET charged=charged+?,calls=calls+1,hold=? WHERE id=? AND hold='' AND calls<? AND charged+?<=?",EXPERIMENT_RESERVE,id,EXPERIMENT,EXPERIMENT_MAX_CALLS,EXPERIMENT_RESERVE,EXPERIMENT_LIMIT).run();
  if(!reserved.meta.changes)throw Error('STAGING_BUDGET_REFUSED');
  await q(e,"INSERT INTO visual_experiment_calls VALUES(?,?,?,?,?,?)",id,EXPERIMENT,hash,EXPERIMENT_RESERVE,'attempt','{}').run();
  return id;
}
export async function settleExperiment(e,id,cost,diagnostic){
  if(cost===null){await q(e,"UPDATE visual_experiment_calls SET outcome='cost_unknown',diagnostic=? WHERE id=?",JSON.stringify(diagnostic),id).run();return;}
  await e.DB.batch([
    q(e,"UPDATE visual_experiment SET charged=charged+?,hold=? WHERE id=? AND hold=? AND EXISTS(SELECT 1 FROM visual_experiment_calls WHERE id=? AND outcome='attempt')",cost-EXPERIMENT_RESERVE,cost>EXPERIMENT_RESERVE?'provider_exceeded_reserve':'',EXPERIMENT,id,id),
    q(e,"UPDATE visual_experiment_calls SET charged=?,outcome='provider_metered',diagnostic=? WHERE id=? AND outcome='attempt'",cost,JSON.stringify(diagnostic),id)
  ]);
}
export function experimentalAI(e){
  const ai=e.AI;
  return {get lastRequestId(){return ai.lastRequestId;},async run(model,inputs,options){
    checkInputs(model,inputs);
    const bytes=Uint8Array.from(atob(inputs.messages[0].content[1].image_url.url.split(',')[1]),c=>c.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    // Atomic reserve across isolates. Failed/unmetered calls keep the reserve;
    // a pending call blocks subsequent inference, including after redeployment.
    const id=await reserveExperiment(e,hash);
    const response=await ai.run(model,inputs,options);
    const envelope=response instanceof Response?await response.clone().json():response;
    const result=envelope?.result||envelope,headers=response instanceof Response?response.headers:null;
    const inner=inferenceUsage(result,headers,model),outer=inferenceUsage(envelope,headers,model),cost=inner.provider_neurons??outer.provider_neurons;
    const diagnostic=responseDiagnostic(result);
    await settleExperiment(e,id,cost,diagnostic);
    return response;
  }};
}
