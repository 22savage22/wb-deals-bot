// One bounded, ordinary public search. A denial stops the entire budget probe:
// no retries, new credentials, proxy, cookies, AI or production source calls.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicGet} from './fashion_report.mjs';
const reportPath=fileURLToPath(new URL('../../docs/shadow-20261011/report.json',import.meta.url));
export function budgetProbeReceipt(response,at=Date.now()){
  const unavailable={status:'UNAVAILABLE',checkedAt:at,source:'search.wb.ru/exactmatch/ru/common/v9/search',attempts:1,http:response.blocked||response.invalid||null,error:response.error||null,tiers:[100,200,300],queriedCeiling:300,confirmedProducts:[],note:'Свежие цена и наличие не подтверждены. Исторические цены в галерее не являются текущими предложениями.'};
  if(response.blocked||response.invalid||response.error)return unavailable;
  // Search alone does not establish matching size-level stock/current payment
  // context. Do not promote even a successful response to a confirmed bargain.
  const rows=response.card?.data?.products||response.card?.products;
  return {...unavailable,http:200,found:Array.isArray(rows)?rows.length:0,note:'Поиск ответил, но цена конкретного размера и его наличие ещё не проверены; подтверждённых бюджетных предложений нет.'};
}
export async function probeBudget({get=publicGet,at=Date.now()}={}){
  const url=new URL('https://search.wb.ru/exactmatch/ru/common/v9/search');
  url.search=new URLSearchParams({appType:'1',curr:'rub',dest:'-1257786',spp:'30',lang:'ru',query:'футболка',page:'1',sort:'priceup',resultset:'catalog',priceU:'0;30000'}).toString();
  let response;try{response=await get(url.href);}catch{response={error:'PUBLIC_RESPONSE_UNAVAILABLE'};}
  return budgetProbeReceipt(response,at);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const receipt=await probeBudget(),report=JSON.parse(await fs.readFile(reportPath,'utf8'));
  report.budgetProbe=receipt;await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(receipt));
}
