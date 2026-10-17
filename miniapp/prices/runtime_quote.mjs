// Shared chooser for publication and passive capture. The established normalizer
// checks stock consistency and kopecks. Stable identity is required beforehand.
import {normalizeWBCard} from '../shadow/discovery.mjs';
const valid=id=>Number.isSafeInteger(id)&&id>0&&id<1e12;
export function normalizeRuntimeQuote(card,options={}){
  if(!Array.isArray(card?.sizes))return null;
  const sizes=card.sizes.slice(0,100).filter(s=>s&&valid(s.chrtId??s.chrtID??s.sizeId));
  const keys=sizes.map(s=>s.chrtId??s.chrtID??s.sizeId);
  // A duplicate key can make price and stock ambiguous even within one card.
  if(!sizes.length||new Set(keys).size!==keys.length)return null;
  return normalizeWBCard({...card,sizes},options);
}
