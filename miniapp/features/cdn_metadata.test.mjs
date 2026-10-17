import test from 'node:test';import assert from 'node:assert/strict';
import {metadataURL,cardAudience,collectMetadata} from './cdn_metadata.mjs';
test('audience comes from exact WB nmId and explicit gender option, never title/style guesses',()=>{
  const card={nm_id:123,subj_name:'Блузки',options:[{name:'Пол',value:'Женский'}]};assert.equal(cardAudience(card,123),'women');assert.equal(cardAudience(card,456),null);
  assert.equal(cardAudience({...card,options:[{name:'Пол',value:'Мужской'}]},123),'men');
  assert.equal(cardAudience({...card,options:[{name:'Пол',value:'Унисекс'}]},123),'neutral');
  assert.equal(cardAudience({...card,options:[{name:'Пол',value:'Женский; Мужской'}]},123),'neutral');
  assert.equal(cardAudience({...card,options:[{name:'Пол',value:'Для девочек'}]},123),null);
  assert.equal(cardAudience({...card,options:[],title:'Женская розовая приталенная'},123),null);
});
test('metadata URL is pinned to genuine same-product WB photo path; blocks SSRF/credentials',()=>{
  assert.equal(metadataURL('https://basket-17.wbbasket.ru/vol1/part12/123/images/big/1.webp',123),'https://basket-17.wbbasket.ru/vol1/part12/123/info/ru/card.json');
  for(const url of ['http://basket-17.wbbasket.ru/123/images/big/1.webp','https://evil.test/123/images/big/1.webp','https://basket-17.wbbasket.ru/124/images/big/1.webp','https://x:secret@basket-17.wbbasket.ru/123/images/big/1.webp'])assert.throws(()=>metadataURL(url,123));
});
test('one upstream429 stops metadata batch without retry or substitute source',async()=>{
  let calls=0;const rows=[1,2,3].map(id=>({id,image:`https://basket-17.wbbasket.ru/vol0/part0/${id}/images/big/1.webp`}));
  const result=await collectMetadata(rows,{fetcher:async()=>{calls++;return new Response('',{status:429});}});
  assert.equal(calls,1);assert.equal(result.attempted,1);assert.equal(result.priceEvidence,'NONE');assert.equal(result.aiCalls,0);
});
