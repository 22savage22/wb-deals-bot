// Official Telegram third-party validation. No bot token, cookies or client ID trust.
// https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
const encoder=new TextEncoder();
const PRODUCTION_KEY='e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
let officialKey;
export async function verifyTelegramSignature(raw,botId,key,now=Date.now()/1000){
  if(typeof raw!=='string'||!raw||raw.length>12000||!/^\d{6,12}$/.test(String(botId)))throw Error('TELEGRAM_AUTH_REQUIRED');
  const pairs=[...new URLSearchParams(raw)],fields=new Map(pairs);
  if(pairs.length!==fields.size)throw Error('TELEGRAM_DUPLICATE_FIELDS');
  const signature=fields.get('signature')??'';
  if(!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature))throw Error('TELEGRAM_SIGNATURE_REQUIRED');
  const date=Number(fields.get('auth_date'));
  if(!Number.isSafeInteger(date)||date<=0||now-date < -30||now-date>3600)throw Error('TELEGRAM_SESSION_EXPIRED');
  fields.delete('hash');fields.delete('signature');
  const check=String(botId)+':WebAppData\n'+[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('\n');
  const bytes=Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
  if(bytes.length!==64||!await crypto.subtle.verify('Ed25519',key,bytes,encoder.encode(check)))throw Error('TELEGRAM_SIGNATURE_INVALID');
  const user=JSON.parse(fields.get('user')??'null');
  if(!user||!Number.isSafeInteger(user.id)||user.id<=0||user.is_bot===true)throw Error('TELEGRAM_USER_INVALID');
  return user.id;
}
export async function telegramPublicUser(raw,botId){
  officialKey??=crypto.subtle.importKey('raw',Uint8Array.from(PRODUCTION_KEY.match(/../g),x=>parseInt(x,16)),'Ed25519',false,['verify']);
  return verifyTelegramSignature(raw,botId,await officialKey);
}
