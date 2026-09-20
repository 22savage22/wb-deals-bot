const encoder=new TextEncoder();
export async function hmac(key,message) {
  const imported=await crypto.subtle.importKey('raw',typeof key==='string'?encoder.encode(key):key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',imported,encoder.encode(message)));
}
export function equal(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false;
  let difference=0;for(let i=0;i<a.length;i++) difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;
}
export async function telegramUser(raw,token,now=Date.now()/1000) {
  if(!token||!raw||raw.length>12000) throw new Error('Telegram authentication required');
  const pairs=[...new URLSearchParams(raw)], fields=new Map(pairs);
  if(fields.size!==pairs.length) throw new Error('Duplicate fields');
  const supplied=fields.get('hash')||'';fields.delete('hash');
  if(!/^[a-f0-9]{64}$/.test(supplied)) throw new Error('Invalid hash');
  const check=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=await hmac('WebAppData',token), digest=await hmac(secret,check);
  const expected=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  if(!equal(expected,supplied)) throw new Error('Invalid signature');
  const date=Number(fields.get('auth_date'));
  if(!Number.isSafeInteger(date)||date<=0||now-date < -30||now-date>3600) throw new Error('Expired session');
  const user=JSON.parse(fields.get('user')||'{}');
  if(!user||typeof user!=='object'||!Number.isSafeInteger(user.id)||user.id<=0) throw new Error('Invalid user');
  return user.id;
}
