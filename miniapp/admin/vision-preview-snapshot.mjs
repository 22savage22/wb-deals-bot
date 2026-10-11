// Local preview only. Imports verified, public staging artifacts, never credentials.
// Not imported by the Worker bundle and never connects to Cloudflare or Workers AI.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ensureVisual,VISUAL_MODEL,visualSourceVersion} from '../cloudflare/visual_enrichment.mjs';

export async function seedVisionPreview(e){
  if(e.SCHEDULER_DRIVER!=='isolated-preview')throw new Error('Vision snapshot requires an isolated local database');
  const report=JSON.parse(await readFile(new URL('../../docs/vision-gemma-20261011/report.json',import.meta.url),'utf8'));
  const gallery=await readFile(new URL('../../docs/vision-gemma-20261011/gallery.html',import.meta.url),'utf8');
  const images=[...gallery.matchAll(/<img src="data:image\/webp;base64,([A-Za-z0-9+/=]+)"/g)].map(m=>Buffer.from(m[1],'base64'));
  if(report.production_changed!==false||report.results.length!==10||images.length!==10)throw new Error('Unexpected staging snapshot');
  const photos=new Map();
  for(const [index,result] of report.results.entries()){
    const p=result.profile,bytes=images[index];
    if(!['complete','cached'].includes(result.state)||p?.model!==VISUAL_MODEL||!Object.keys(p.fields||{}).length||createHash('sha256').update(bytes).digest('hex')!==p.images[0].hash)throw new Error('Invalid cached profile/photo');
    photos.set(result.nmId,bytes);
  }
  await ensureVisual(e);
  // Atomic, one-time local import. Reopening the page never writes defaults.
  if(!e.db.prepare("SELECT value FROM metadata WHERE key='vision_preview_snapshot'").get()){
    e.db.exec('BEGIN');
    try{
      for(const result of report.results){
        const p=result.profile,[urls,imageVersion]=JSON.parse(p.source_version);
        const data={id:result.nmId,title:result.title,image:urls[0],images:urls,image_version:imageVersion,visual_group:p.group};
        if(visualSourceVersion(data)!==p.source_version)throw new Error('Source version mismatch');
        // Historical image cards have no current verified price and are NOT ready for posting.
        e.db.prepare("INSERT INTO scheduler_inventory(pid,data,topic,title_key,queued_at,checked_at,expires,state) VALUES(?,?,?,'visual-preview-only',?,?,?,'preview_only')").run(result.nmId,JSON.stringify(data),p.group,p.analyzed_at,p.analyzed_at,p.analyzed_at+86400);
        e.db.prepare('INSERT INTO visual_profiles(pid,version,analyzed_at,profile,backfill_pending) VALUES(?,?,?,?,0)').run(result.nmId,p.version,p.analyzed_at,JSON.stringify(p));
        for(const image of p.images)e.db.prepare('INSERT INTO visual_images VALUES(?,?,?,?,?)').run(result.nmId,image.index,image.url,image.hash,JSON.stringify({fields:p.fields,usage:image.usage}));
        e.db.prepare("INSERT INTO visual_queue(pid,state,queued_at) VALUES(?,'done',?)").run(result.nmId,p.analyzed_at);
        const day=new Date(p.analyzed_at*1000).toISOString().slice(0,10);
        e.db.prepare('INSERT OR IGNORE INTO visual_daily_products VALUES(?,?)').run(day,result.nmId);
      }
      // Provider-metered experiment totals include the rejected eighth response too.
      // Keep original UTC dates: tomorrow's UI must not call this 'today's usage'.
      for(const experiment of [report.prior_experiment,report.additional_experiment]){
        const date=experiment.id.match(/(\d{4})(\d{2})(\d{2})/);
        if(!date)throw new Error('Missing experiment date');
        const day=date.slice(1).join('-');
        e.db.prepare('INSERT INTO visual_neuron_budget VALUES(?,?)').run(day,experiment.charged);
        e.db.prepare('INSERT INTO visual_usage VALUES(?,?)').run(day,experiment.calls);
      }
      e.db.prepare('UPDATE visual_state SET enabled=0,last_success=?,last_run=? WHERE id=1').run(Math.max(...report.results.map(r=>r.profile.analyzed_at)),Math.max(...report.results.map(r=>r.profile.analyzed_at)));
      e.db.prepare("INSERT INTO metadata VALUES('vision_preview_snapshot',?)").run(JSON.stringify({at:report.finished_at,profiles:10,neurons_total:report.neurons_total_gemma,cache:report.cache_verification}));
      e.db.exec('COMMIT');
    }catch(error){e.db.exec('ROLLBACK');throw error;}
  }
  return {photos,gallery,at:report.finished_at,total:report.neurons_total_gemma};
}
