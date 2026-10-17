// Private collector unit tests: local SQLite or inert bindings only. The fixture
// supplies synthetic write metadata for admission tests, never account billing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalD1} from '../features/local_d1.mjs';
import {openPassivePriceStore,PASSIVE_SCHEMA} from './passive_store.mjs';
import localWorker,{createPassivePriceWorker,LOCAL_PASSIVE_DB} from './passive_worker.mjs';

const ID='unit-passive-worker-approved-db',RUN='passive-worker-run-001';
const URL='https://price-observer.internal/capture';
const worker=()=>createPassivePriceWorker({approvedDatabaseId:ID});
const event=(at=Date.now()-10)=>({
  runId:RUN,eventId:'passive-worker-event-001',at,source:'wb_card',method:'GET',
  acquisition:'native_details',httpStatus:200,fallback:false,outcome:'success',
  requestedContext:{currency:'RUB',destination:'-1257786',spp:'30',paymentBasis:'unknown'},
  offers:[{id:123,variantKey:'12300',size:'M (48)',price:199.95,currency:'RUB',
    available:true,priceObservedAt:at,stockObservedAt:at,verificationStatus:'api_observed',
    retailConfirmed:false,context:{currency:'RUB',destination:'-1257786',paymentBasis:'unknown'}}]
});
function binding(){
  const calls={prepare:0,batch:0};
  return {calls,db:{prepare(){calls.prepare++;throw Error('UNEXPECTED_D1');},batch(){calls.batch++;throw Error('UNEXPECTED_D1');}}};
}
function env(db,patch={}){
  return {PRICE_CAPTURE_ENABLED:'1',PRICE_PASSIVE_ENABLED:'true',PRICE_ISOLATED:'true',
    PRICE_DATABASE_ID:ID,PRICE_OBSERVATION_RUN_ID:RUN,PRICE_DB:db,
    DB:{prepare(){throw Error('PRODUCTION_D1_FORBIDDEN');}},...patch};
}
function request(value=event(),options={}){
  return new Request(options.url??URL,{method:options.method??'POST',body:typeof value==='string'?value:JSON.stringify(value)});
}
async function reply(response,status){
  assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');
  return response.json();
}
function streamingRequest(chunks){
  const calls={reads:0,cancel:0,released:0};let at=0;
  const reader={
    async read(){calls.reads++;return at<chunks.length?{done:false,value:chunks[at++]}:{done:true};},
    async cancel(){calls.cancel++;},releaseLock(){calls.released++;}
  };
  return {calls,request:{url:URL,method:'POST',body:{getReader(){return reader;}}}};
}

test('capture defaults OFF and reads neither request nor D1, even for malformed input',async()=>{
  for(const enabled of [undefined,'0','true',true,1,false]){
    let touched=0;
    const request=new Proxy({}, {get(){touched++;throw Error('REQUEST_MUST_NOT_BE_READ');}});
    const settings={PRICE_CAPTURE_ENABLED:enabled};
    Object.defineProperty(settings,'PRICE_DB',{get(){touched++;throw Error('DB_MUST_NOT_BE_READ');}});
    assert.deepEqual(await reply(await worker().fetch(request,settings),404),{status:'disabled'});
    assert.equal(touched,0);
  }
});

test('only POST on the exact private capture origin/path with no query reaches a body',async()=>{
  const denied=[
    ['POST','https://outside.invalid/capture'],['POST','http://price-observer.internal/capture'],
    ['POST','https://price-observer.internal.outside.invalid/capture'],
    ['POST','https://price-observer.internal:8443/capture'],
    ...['/','/start','/stop','/init','/status','/capture/','/capture/extra'].map(path=>['POST','https://price-observer.internal'+path]),
    ['POST',URL+'?run='+RUN],['POST',URL+'?start=1'],['POST',URL+'?stop=1'],
    ...['GET','HEAD','PUT','PATCH','DELETE','OPTIONS'].map(method=>[method,URL])
  ];
  for(const [method,url] of denied){
    const {db,calls}=binding();let bodyReads=0;
    const input={url,method,get body(){bodyReads++;throw Error('DENIED_BODY_MUST_NOT_BE_READ');}};
    assert.deepEqual(await reply(await worker().fetch(input,env(db)),404),{status:'not_found'},method+' '+url);
    assert.equal(bodyReads,0);assert.deepEqual(calls,{prepare:0,batch:0});
  }
});

test('missing body, malformed JSON and mismatched run are rejected before D1',async()=>{
  const inputs=[{url:URL,method:'POST',body:null},request('{not-json'),request({...event(),runId:'passive-other-run-001'})];
  for(const input of inputs){
    const {db,calls}=binding();
    assert.deepEqual(await reply(await worker().fetch(input,env(db)),400),{status:'invalid_event'});
    assert.deepEqual(calls,{prepare:0,batch:0});
  }
});

test('64 KiB limit uses UTF-8 bytes and accepts the exact boundary without SQL when passive is OFF',async()=>{
  const {db,calls}=binding(),base=JSON.stringify({...event(),padding:''});
  const remaining=65536-new TextEncoder().encode(base).byteLength;
  const padding='я'.repeat(Math.floor(remaining/2))+'x'.repeat(remaining%2);
  const exact=JSON.stringify({...JSON.parse(base),padding});
  assert.equal(new TextEncoder().encode(exact).byteLength,65536);
  assert.deepEqual(await reply(await worker().fetch(request(exact),env(db,{PRICE_PASSIVE_ENABLED:'false'})),200),{
    status:'DISABLED',d1:{queries:0,rows_read:0,rows_written:0,metadata_available:false,metadata_complete:true}
  });
  assert.deepEqual(await reply(await worker().fetch(request(exact+' '),env(db)),400),{status:'invalid_event'});
  assert.deepEqual(calls,{prepare:0,batch:0});
});

test('oversize streaming input is cancelled at the bound and never drains remaining chunks or reaches D1',async()=>{
  const {db,calls}=binding(),input=streamingRequest([new Uint8Array(32768),new Uint8Array(32769),new Uint8Array(4096)]);
  assert.deepEqual(await reply(await worker().fetch(input.request,env(db)),400),{status:'invalid_event'});
  assert.deepEqual(input.calls,{reads:2,cancel:1,released:1});
  assert.deepEqual(calls,{prepare:0,batch:0});
});

test('factory pins a separate approved identity; local default cannot approve a deployment ID',async()=>{
  assert.notEqual(ID,LOCAL_PASSIVE_DB);const {db,calls}=binding(),settings=env(db,{PRICE_PASSIVE_ENABLED:'false'});
  assert.equal((await reply(await worker().fetch(request(),settings),200)).status,'DISABLED');
  assert.deepEqual(await reply(await localWorker.fetch(request(),settings),503),{status:'unavailable'});
  assert.deepEqual(await reply(await createPassivePriceWorker().fetch(request(),settings),503),{status:'unavailable'});
  assert.deepEqual(calls,{prepare:0,batch:0});
});

test('identity and isolation guard failures are generic unavailable and cannot touch SQL',async()=>{
  const variants=[{PRICE_ISOLATED:'false'},{PRICE_ISOLATED:true},{PRICE_DB:null},{PRICE_DATABASE_ID:'another-isolated-database-id'}];
  for(const patch of variants){
    const {db,calls}=binding();
    assert.deepEqual(await reply(await worker().fetch(request(),env(db,patch)),503),{status:'unavailable'});
    assert.deepEqual(calls,{prepare:0,batch:0});
  }
  for(const forbidden of ['d73d252d-3948-425b-b7c3-b65d0f5c6e5f','5779987d-1100-45ad-8cd4-9df9c1436a20']){
    const {db,calls}=binding();
    const denied=createPassivePriceWorker({approvedDatabaseId:forbidden});
    assert.deepEqual(await reply(await denied.fetch(request(),env(db,{PRICE_DATABASE_ID:forbidden})),503),{status:'unavailable'});
    assert.deepEqual(calls,{prepare:0,batch:0});
  }
});

test('same physical binding is rejected before wrapping can hide DB identity',async()=>{
  let propertyReads=0;
  const physical={get prepare(){propertyReads++;throw Error('IDENTITY_VALIDATION_TOO_LATE');},get batch(){propertyReads++;throw Error('IDENTITY_VALIDATION_TOO_LATE');}};
  assert.deepEqual(await reply(await worker().fetch(request(),env(physical,{DB:physical})),503),{status:'unavailable'});
  assert.equal(propertyReads,0);
});

class SyntheticWriteFixture extends LocalD1{
  async batch(statements){
    const before=this.sqlite.prepare('SELECT total_changes() n').get().n;
    const results=await super.batch(statements),after=this.sqlite.prepare('SELECT total_changes() n').get().n;
    results.forEach((result,index)=>result.meta.rows_written=index===0?after-before:0);
    return results;
  }
}
test('approved private capture persists a sanitized API observation and retry does not count twice',async t=>{
  const db=new SyntheticWriteFixture();t.after(()=>db.close());db.exec(PASSIVE_SCHEMA);
  const settings=env(db),store=openPassivePriceStore(settings,{approvedDatabaseId:ID}),now=Date.now()-1000;
  assert.equal((await store.start({runId:RUN,now,expiresAt:now+3600000,reviewed:true})).started,true);
  const input={...event(now+1),debug:'PRIVATE_REQUEST_DIAGNOSTIC_DO_NOT_ECHO'};
  const output=await reply(await worker().fetch(request(input),settings),200);
  assert.equal(output.status,'active');assert.equal(output.accepted,1);assert.ok(output.d1.queries>0);
  assert.equal(output.d1.metadata_complete,false);assert.equal(output.d1.metadata_available,false);
  assert.deepEqual(Object.keys(output).sort(),['accepted','d1','status']);
  assert.doesNotMatch(JSON.stringify(output),/PRIVATE_REQUEST|12300|199\.95|runId|offers/);
  const saved=db.sqlite.prepare('SELECT offers FROM passive_events').get();
  const offers=JSON.parse(saved.offers);assert.equal(offers[0].price,199.95);assert.equal(offers[0].verificationStatus,'api_observed');assert.equal(offers[0].retailConfirmed,false);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM observed_quote_history').get().n,1);
  assert.equal((await reply(await worker().fetch(request(input),settings),200)).accepted,1);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM passive_events').get().n,1);
});

test('unavailable D1 never exposes upstream/storage error text or claims accepted observations',async()=>{
  const marker='PRIVATE_STORAGE_DIAGNOSTIC_DO_NOT_ECHO';let first=0,batches=0;
  const db={prepare(){return {bind(){return this;},async first(){first++;throw Error(marker);},
    // observeD1 implements first() through all() to collect official metadata.
    async all(){return this.first();}};},async batch(){batches++;throw Error('BATCH_MUST_NOT_RUN');}};
  const response=await worker().fetch(request(),env(db)),body=await reply(response,200);
  assert.equal(body.status,'meter_unknown');assert.equal(body.d1.metadata_complete,false);
  assert.equal(body.accepted,undefined);assert.equal(first,1);assert.equal(batches,0);assert.doesNotMatch(JSON.stringify(body),new RegExp(marker));
  assert.deepEqual(Object.keys(body).sort(),['d1','status']);
});

test('broken request stream fails closed without propagating raw diagnostic details',async()=>{
  const {db,calls}=binding();let released=0;
  const input={url:URL,method:'POST',body:{getReader(){return {
    async read(){throw Error('PRIVATE_STREAM_DIAGNOSTIC_DO_NOT_ECHO');},releaseLock(){released++;}
  };}}};
  const body=await reply(await worker().fetch(input,env(db)),400);
  assert.deepEqual(body,{status:'invalid_event'});
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE_STREAM_DIAGNOSTIC/);assert.equal(released,1);
  assert.deepEqual(calls,{prepare:0,batch:0});
});
