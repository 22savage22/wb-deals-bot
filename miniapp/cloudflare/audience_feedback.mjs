import {VOTE_WINDOW,summariseVotes} from './audience_quality.mjs';
import {cachedProfiles} from './visual_enrichment.mjs';
import {profileFeatures,visualLabel} from './visual_features.mjs';
// Run only on a due posting attempt or an explicit owner diagnostic, NOT on
// every idle Cron/callback. Unique current votes, never cumulative toggle events.
export const FEEDBACK_SQL=`SELECT v.pid,v.voter,v.sentiment,COALESCE(i.data,p.data) AS data FROM
 (SELECT pid,voter,sentiment FROM reaction_votes INDEXED BY reaction_votes_quality_recent
  WHERE scope='channel' ORDER BY last_event DESC LIMIT ${VOTE_WINDOW}) v
 LEFT JOIN scheduler_inventory i ON i.pid=v.pid LEFT JOIN products p ON p.id=v.pid`;
export async function audienceContext(e,candidateIds=[]){
 try{
  const rows=(await e.DB.prepare(FEEDBACK_SQL).all()).results;
  const profiles=await cachedProfiles(e,[...new Set(rows.map(r=>r.pid))]);
  if(candidateIds.length)for(const [id,p] of await cachedProfiles(e,candidateIds))profiles.set(id,p);
  const visual=new Map([...profiles].map(([id,p])=>[id,Object.keys(profileFeatures(p)).filter(k=>!k.startsWith('visual.group=')&&!k.startsWith('visual.combo=')&&!(k.startsWith('visual.style=')&&p.fields?.style?.hypothesis!==false))]));
  const result=summariseVotes(rows.map(r=>({...r,visual_keys:visual.get(r.pid)||[]})));
  for(const [key,stat] of result.traits)if(key.startsWith('visual.'))stat.label=visualLabel(key);
  return {...result,visual,profiles,available:true};
 }catch(error){
  // Feedback store failures never bypass owner exclusions or stop posting.
  console.log('AUDIENCE_FEEDBACK unavailable; unchanged Legacy fallback');
  return {...summariseVotes([]),visual:new Map(),available:false};
 }
}
export const feedbackSummary=c=>({available:c.available,likes:c.likes,dislikes:c.dislikes,positive_ratio:c.likes+c.dislikes?c.likes/(c.likes+c.dislikes):null,sampled_votes:c.sampled_votes,truncated:c.truncated,traits:[...c.traits.values()].sort((a,b)=>b.dislikes-a.dislikes).slice(0,30),note:'Текущие уникальные голоса канала (до 500 последних), не сумма повторных нажатий. Общая категория не меняется после одного-двух дизлайков. Стиль-гипотеза не используется.'});
