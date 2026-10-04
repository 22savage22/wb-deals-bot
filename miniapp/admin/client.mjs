export function createClient(initData,fetcher=fetch,storage=globalThis.sessionStorage){
  let locked=false;
  async function api(path,method='GET',data){
    const response=await fetcher(path,{method,headers:{'X-Telegram-Init-Data':initData,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(8000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить');return result;
  }
  return {api,async action(action){
    if(locked)return {duplicate:true};locked=true;
    const key='admin-request:'+action;
    let request_id=storage?.getItem(key)||crypto.randomUUID();storage?.setItem(key,request_id);
    try{const result=await api(action==='check'?'/api/admin/check':'/api/admin/schedule/action','POST',{action,request_id});storage?.removeItem(key);return result;}finally{locked=false;}
  }};
}
