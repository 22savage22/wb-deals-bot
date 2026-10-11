import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startControlPreview} from '../admin/control-preview.mjs';
import {seedVisionPreview} from '../admin/vision-preview-snapshot.mjs';
import {visualAvailability,insightText,visualErrorText} from '../admin/view.mjs';
import {signedAdmin} from './admin_test_support.mjs';
import {cachedProfiles,visualRun,VISUAL_MODEL} from './visual_enrichment.mjs';
const report=JSON.parse(await readFile(new URL('../../docs/vision-gemma-20261011/report.json',import.meta.url)));
const headers=e=>({'X-Telegram-Init-Data':signedAdmin(e),'Content-Type':'application/json'});
const config=e=>e.db.prepare('SELECT data FROM scheduler_config WHERE id=1').get().data;

test('combined preview reads ten verified staging profiles through real owner handlers without rewriting settings or calling AI',async t=>{
  const app=await startControlPreview({visionSnapshot:true});t.after(()=>app.close());
  let aiCalls=0;app.env.AI={async run(){aiCalls++;throw new Error('No inference allowed');}};
  const before=config(app.env),policy=app.env.db.prepare('SELECT data FROM scheduler_policy WHERE id=1').get().data;
  const h=headers(app.env),read=async path=>{const r=await fetch(app.origin+path,{headers:h});assert.equal(r.status,200);return r.json();};
  for(let n=0;n<3;n++){
    const overview=await read('/api/admin/overview');assert.equal(overview.schedule.post_interval_minutes,30);
    const learning=await read('/api/admin/learning'),v=learning.visual;
    assert.equal(learning.config.mode,'SHADOW');assert.equal(v.profiles,10);assert.equal(v.model,VISUAL_MODEL);
    assert.equal(v.enabled,false);assert.equal(v.automatic_analysis_allowed,false);assert.equal(v.real_feedback.events,0);
    const day=new Date().toISOString().slice(0,10),experiment=[report.prior_experiment,report.additional_experiment].find(e=>e.id.includes(day.replaceAll('-','')));
    assert.equal(v.neurons_charged,experiment?.charged||0);assert.equal(v.calls_today,experiment?.calls||0);
    assert.ok(v.examples.every(p=>p.images[0].url.startsWith('/preview/photos/')));
  }
  const writes=app.env.db.prepare('SELECT total_changes() n').get().n;
  for(let n=0;n<2;n++)assert.equal((await cachedProfiles(app.env,report.results.map(r=>r.nmId))).size,10);
  assert.equal(app.env.db.prepare('SELECT total_changes() n').get().n,writes);
  assert.equal((await visualRun(app.env)).state,'disabled');
  assert.equal(config(app.env),before);assert.equal(app.env.db.prepare('SELECT data FROM scheduler_policy WHERE id=1').get().data,policy);
  assert.equal(app.env.db.prepare('SELECT COUNT(*) n FROM scheduler_posts').get().n,0);assert.equal(aiCalls,0);
});

test('combined preview exposes hash-verified local photos, denies AI/posting and retains owner-only API authentication',async t=>{
  const app=await startControlPreview({visionSnapshot:true});t.after(()=>app.close());const h=headers(app.env);
  const page=await fetch(app.origin+'/admin');assert.match(page.headers.get('content-security-policy'),/connect-src 'self'/);
  const html=await page.text();assert.match(html,/НЕ текущее production-состояние/);assert.match(html,/новый расход 0/);
  const gallery=await(await fetch(app.origin+'/preview/vision-gallery')).text();assert.equal([...gallery.matchAll(/<article>/g)].length,10);
  for(const result of report.results){const photo=await fetch(app.origin+'/preview/photos/'+result.nmId+'.webp');assert.equal(photo.status,200);assert.equal(createHash('sha256').update(Buffer.from(await photo.arrayBuffer())).digest('hex'),result.profile.images[0].hash);}
  assert.equal((await fetch(app.origin+'/api/admin/learning')).status,401);
  assert.equal((await fetch(app.origin+'/api/admin/learning',{headers:{...h,'X-Telegram-Init-Data':signedAdmin(app.env,12)}})).status,403);
  for(const path of ['/api/admin/visual/activate','/api/admin/visual/run','/api/admin/schedule/action'])assert.equal((await fetch(app.origin+path,{method:'POST',headers:h,body:JSON.stringify({action:'post_now',request_id:'denied-preview'})})).status,409);
  assert.equal(app.env.db.prepare('SELECT enabled FROM visual_state WHERE id=1').get().enabled,0);
});

test('preview restart preserves cached JSON, metered totals, explicit local changes and SHADOW',async t=>{
  await mkdir('.test-temp',{recursive:true});const dir=await mkdtemp('.test-temp/integration-persistence-'),path=dir+'/local.sqlite';
  const first=await startControlPreview({visionSnapshot:true,path});
  const profiles=first.env.db.prepare('SELECT pid,profile FROM visual_profiles ORDER BY pid').all(),budget=first.env.db.prepare('SELECT * FROM visual_neuron_budget ORDER BY day').all();
  const schedule=JSON.parse(config(first.env));schedule.post_interval_minutes=20;first.env.db.prepare('UPDATE scheduler_config SET data=? WHERE id=1').run(JSON.stringify(schedule));
  await first.close();const second=await startControlPreview({visionSnapshot:true,path});t.after(()=>second.close());
  assert.deepEqual(second.env.db.prepare('SELECT pid,profile FROM visual_profiles ORDER BY pid').all(),profiles);
  assert.deepEqual(second.env.db.prepare('SELECT * FROM visual_neuron_budget ORDER BY day').all(),budget);
  assert.equal(JSON.parse(config(second.env)).post_interval_minutes,20);
  assert.equal(JSON.parse(second.env.db.prepare('SELECT config FROM learning_state WHERE id=1').get().config).mode,'SHADOW');
  await assert.rejects(()=>seedVisionPreview({...second.env,SCHEDULER_DRIVER:'cloudflare-native'}),/isolated/);
});

test('both UI conflict resolutions preserve evidence thresholds and do not mistake missing Vision data for enabled/zero',()=>{
  assert.match(visualAvailability(undefined).title,/не подключён/);
  assert.equal(visualAvailability({initialized:false}).settingsAvailable,false);
  assert.match(visualAvailability({initialized:true,configured_enabled:true,enabled:false,automatic_analysis_allowed:false}).title,/ВЫКЛ/);
  assert.equal(visualAvailability({initialized:true,enabled:true,automatic_analysis_allowed:true,budget_hold:{reason:'unknown'}}).settingsAvailable,false);
  assert.match(insightText({scope:'category',key:'Худи',rate:.7,observations:3,positive:2,negative:1}).detail,/3 событий/);
  assert.match(visualErrorText('VISUAL_DAILY_PRODUCTS'),/10 товаров/);
});

test('merged admin preserves Astra modules, read-before-save revisions and Vision evidence gate in the built UI',async()=>{
  const source=await readFile(new URL('../admin/app.jsx',import.meta.url),'utf8');
  for(const component of ['QueryManager','SelectionManager','QueueManager','ConfigHistory'])assert.match(source,new RegExp(component));
  assert.match(source,/i\.sufficient&&i\.direction!=='insufficient'/);assert.match(source,/20 лайков\/дизлайков/);
  assert.match(source,/revision:baseRevision\.current/);assert.match(source,/Ничего не перезаписываем/);
  assert.doesNotMatch(source,/<<<<<<<|>>>>>>>/);
  const built=await readFile(new URL('../public/admin/app.js',import.meta.url),'utf8');assert.ok(built.includes('Vision: '));assert.ok(built.includes('automatic_analysis_allowed'));
});
