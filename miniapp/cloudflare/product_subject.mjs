// The WB price endpoint often supplies only a numeric subjectId. Do not invent
// a subject name or infer visual style. Use the product's observed official CDN.
import {fashionMetadata} from './fashion_selection.mjs';
const generic=s=>['','другое','other'].includes(String(s||'').toLowerCase());
export function subjectURL(p){
 try{const u=new URL(p.image);if(u.protocol!=='https:'||!/^basket-\d+\.wbbasket\.ru$/.test(u.hostname)||u.username||u.password||u.port||u.search)return null;
 const suffix=new RegExp('/'+Number(p.id)+'/images/(?:big|c246x328|c516x688)/\\d+\\.(?:webp|jpg|png)$');
 if(!suffix.test(u.pathname))return null;u.pathname=u.pathname.replace(/\/images\/[^/]+\/[^/]+$/,'/info/ru/card.json');return u.href;
 }catch{return null;}
}
export async function enrichSubject(p,fetcher=fetch,{cached=null,now=Math.floor(Date.now()/1000),fashion=false}={}){
 // SHADOW may parse a response we already need, never trigger extra CDN work
 // or change Legacy category resolution for an already known subject.
 if(!generic(p.category))return p;
 if(cached?.category_source==='wb-cdn'&&cached.id===p.id&&cached.title===p.title&&cached.image===p.image&&!generic(cached.category)&&now-Number(cached.category_checked_at||0)<86400){
  return {...p,category:cached.category,category_root:cached.category_root,category_source:'wb-cdn',category_checked_at:cached.category_checked_at,...(fashion&&cached.fashion_metadata?.pid===p.id&&cached.fashion_metadata?.image===p.image?{fashion_metadata:cached.fashion_metadata}:{})};}
 const url=subjectURL(p);if(!url)return p;
 try{const r=await fetcher(url,{headers:{Accept:'application/json'},redirect:'manual',signal:AbortSignal.timeout(3000)});if(!r.ok)return p;
  const reader=r.body.getReader(),chunks=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>256000){await reader.cancel();return p;}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const d=JSON.parse(new TextDecoder().decode(bytes));
  if(Number(d.nm_id)!==Number(p.id)||typeof d.subj_name!=='string'||!d.subj_name.trim()||d.subj_name.length>120)return p;
  return {...p,category:d.subj_name.trim(),category_root:typeof d.subj_root_name==='string'?d.subj_root_name.slice(0,120):'',category_source:'wb-cdn',category_checked_at:now,...(fashion?{fashion_metadata:fashionMetadata(d,p,now)}:{})};
 }catch{return p;} // One attempt, no recursive retries, never holds a posting lease forever.
}
