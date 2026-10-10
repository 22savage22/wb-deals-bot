// Imported ONLY by the isolated fetch-only harness, never production.
import {inferenceUsage,VISUAL_MODEL} from './visual_enrichment.mjs';
import {normalizeAnalysis,COMMON,SPECIFIC} from './visual_features.mjs';
export const EXPERIMENT='gemma-native-20261010-500';
export const EXPERIMENT_LIMIT=500, EXPERIMENT_RESERVE=200;
const DB_ID='5779987d-1100-45ad-8cd4-9df9c1436a20';
const q=(e,s,...args)=>e.DB.prepare(s).bind(...args);
export function checkInputs(model,inputs){
  // One image: Google Gemma 4 documents <=1120 visual tokens. Text byte
  // ceiling4096 + generous4096 template allowance +900 completion =109.22
  // Neurons at9091/27273 perM. Reserve200; never use the full256k context
  // as though this fixed single-photo request actually filled it.
  const c=inputs?.messages?.[0]?.content;
  if(model!==VISUAL_MODEL||inputs.messages.length!==1||!Array.isArray(c)||c.length!==2||c[0].type!=='text'||new TextEncoder().encode(c[0].text).length>4096||c[1].type!=='image_url'||!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(c[1].image_url?.url||'')||inputs.max_completion_tokens!==900||inputs.chat_template_kwargs?.enable_thinking!==false||inputs.response_format?.type!=='json_object'||inputs.stream||inputs.n>1)throw Error('STAGING_INPUT_BOUND_REFUSED');
}
export async function initExperiment(e){
  if(e.VISUAL_STAGING!=='isolated'||e.VISUAL_STAGING_DB_ID!==DB_ID)throw Error('STAGING_ISOLATION_REFUSED');
  await e.DB.batch([
    q(e,'CREATE TABLE IF NOT EXISTS visual_experiment(id TEXT PRIMARY KEY,charged REAL NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,hold TEXT NOT NULL DEFAULT \'\')'),
    q(e,'CREATE TABLE IF NOT EXISTS visual_experiment_calls(id TEXT PRIMARY KEY,experiment TEXT NOT NULL,image_hash TEXT NOT NULL,charged REAL NOT NULL,outcome TEXT NOT NULL,diagnostic TEXT NOT NULL,UNIQUE(experiment,image_hash))'),
    q(e,'INSERT OR IGNORE INTO visual_experiment(id) VALUES(?)',EXPERIMENT)
  ]);
  // A different model is a genuinely new experiment, not a Llama format
  // retry. Keep old attempts/charges intact; never reset Gemma attempts.
  await q(e,"UPDATE visual_queue SET state='pending',retry_at=0,attempts=0,error='' WHERE error IN ('VISUAL_INVALID_JSON','VISUAL_INVALID_PROFILE','VISUAL_EMPTY_PROFILE','VISUAL_MODEL_UNAVAILABLE') AND NOT EXISTS(SELECT 1 FROM visual_inference_usage u WHERE u.pid=visual_queue.pid AND json_extract(u.usage,'$.model')=?)",VISUAL_MODEL).run();
}
export async function experimentStatus(e){
  const budget=await q(e,'SELECT * FROM visual_experiment WHERE id=?',EXPERIMENT).first();
  const calls=(await q(e,'SELECT image_hash,charged,outcome,diagnostic FROM visual_experiment_calls WHERE experiment=? LIMIT 10',EXPERIMENT).all()).results.map(r=>({...r,diagnostic:JSON.parse(r.diagnostic)}));
  return {...budget,limit:EXPERIMENT_LIMIT,reserve:EXPERIMENT_RESERVE,calls_receipts:calls};
}
export function responseDiagnostic(result){
  const raw=result?.response??result?.description??result?.choices?.[0]?.message?.content;
  let parsed=null;try{parsed=typeof raw==='string'?JSON.parse(raw):raw;}catch{}
  const fields=parsed?.fields;
  let validation='VISUAL_INVALID_JSON',accepted=0;
  try{const a=normalizeAnalysis(raw);accepted=Object.keys(a.fields).length;validation=accepted>=2?'VALID_PROFILE':'VISUAL_EMPTY_PROFILE';}catch(error){if(/^VISUAL_(INVALID_JSON|INVALID_PROFILE)$/.test(error.message))validation=error.message;}
  const allowed={...COMMON,...(SPECIFIC[parsed?.group]||{})};
  const rejected=[];
  if(fields&&typeof fields==='object')for(const [key,f] of Object.entries(fields).slice(0,24)){
    if(!allowed[key])continue;
    if(!f||typeof f!=='object'||Array.isArray(f)||typeof f.value!=='string'){rejected.push({field:key,reason:'FIELD_TYPE'});continue;}
    if(!Number.isFinite(f.confidence)||typeof f.evidence!=='string'){rejected.push({field:key,reason:'MISSING_CONFIDENCE_OR_EVIDENCE'});continue;}
    // Only field names from the closed vocabulary and fixed reason codes;
    // never persist the rejected arbitrary value or evidence text.
    if(f.confidence<.8||f.evidence.trim().length<5)rejected.push({field:key,reason:'WEAK_EVIDENCE'});
  }
  // Structure ONLY; no raw text, prompts, field evidence, URLs or credentials.
  return {validation,accepted_fields:accepted,rejected,response_type:raw===null?'null':Array.isArray(raw)?'array':typeof raw,response_length:typeof raw==='string'?raw.length:null,json_parse_ok:!!parsed&&typeof parsed==='object'&&!Array.isArray(parsed),root_group_type:typeof parsed?.group,fields_count:fields&&typeof fields==='object'?Object.keys(fields).length:0,valid_evidence_fields:fields&&typeof fields==='object'?Object.values(fields).filter(f=>typeof f?.value==='string'&&typeof f?.confidence==='number'&&f.confidence>=.8&&typeof f?.evidence==='string'&&f.evidence.trim().length>=5).length:0,finish_reason:['stop','length','content_filter'].includes(result?.choices?.[0]?.finish_reason)?result.choices[0].finish_reason:null};
}
export function experimentalAI(e){
  const ai=e.AI;
  return {get lastRequestId(){return ai.lastRequestId;},async run(model,inputs,options){
    checkInputs(model,inputs);
    const bytes=Uint8Array.from(atob(inputs.messages[0].content[1].image_url.url.split(',')[1]),c=>c.charCodeAt(0));
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(await q(e,'SELECT id FROM visual_experiment_calls WHERE experiment=? AND image_hash=?',EXPERIMENT,hash).first())throw Error('STAGING_REPEAT_REFUSED');
    const id=crypto.randomUUID();
    // Atomic reserve across isolates. Failed/unmetered calls keep the reserve;
    // a pending call blocks subsequent inference, including after redeployment.
    const reserved=await q(e,"UPDATE visual_experiment SET charged=charged+?,calls=calls+1,hold=? WHERE id=? AND hold='' AND calls<10 AND charged+?<=?",EXPERIMENT_RESERVE,id,EXPERIMENT,EXPERIMENT_RESERVE,EXPERIMENT_LIMIT).run();
    if(!reserved.meta.changes)throw Error('STAGING_BUDGET_REFUSED');
    await q(e,"INSERT INTO visual_experiment_calls VALUES(?,?,?,?,?,?)",id,EXPERIMENT,hash,EXPERIMENT_RESERVE,'attempt','{}').run();
    const response=await ai.run(model,inputs,options);
    const envelope=response instanceof Response?await response.clone().json():response;
    const result=envelope?.result||envelope,headers=response instanceof Response?response.headers:null;
    const inner=inferenceUsage(result,headers,model),outer=inferenceUsage(envelope,headers,model),cost=inner.provider_neurons??outer.provider_neurons;
    const diagnostic=responseDiagnostic(result);
    if(cost===null){await q(e,"UPDATE visual_experiment_calls SET outcome='cost_unknown',diagnostic=? WHERE id=?",JSON.stringify(diagnostic),id).run();return response;}
    await e.DB.batch([
      q(e,"UPDATE visual_experiment SET charged=charged+?,hold=? WHERE id=? AND hold=?",cost-EXPERIMENT_RESERVE,cost>EXPERIMENT_RESERVE?'provider_exceeded_reserve':'',EXPERIMENT,id),
      q(e,"UPDATE visual_experiment_calls SET charged=?,outcome='provider_metered',diagnostic=? WHERE id=?",cost,JSON.stringify(diagnostic),id)
    ]);
    return response;
  }};
}
