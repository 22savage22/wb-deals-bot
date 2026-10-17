// LOCAL_FIXTURE_NOT_REAL_TELEGRAM. Runs only against its own loopback preview.
// Requires the preinstalled browser package; never installs or calls paid APIs.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');

async function main(){
  assert.ok(process.env.WB_BROWSER_QA_MODULE,'Set WB_BROWSER_QA_MODULE to the existing bundled playwright module');
  const {chromium}=require(process.env.WB_BROWSER_QA_MODULE);
  const root=path.resolve(__dirname,'../..'),base=path.join(root,'.test-temp/style-product-qa');
  await fs.mkdir(base,{recursive:true});const out=await fs.mkdtemp(path.join(base,'run-'));
  const origin='http://127.0.0.1:8777',file=path.join(out,'qa.sqlite3');
  const report={label:'LOCAL_FIXTURE_NOT_REAL_TELEGRAM',realTelegramAccountsTested:0,productionCalls:0,aiCalls:0,telegramCalls:0,startedAt:new Date().toISOString(),steps:[],requests:[],screenshots:[],pageErrors:[],blockedExternalRequests:[],reportDirectory:out};
  let preview,browser;const contexts=[];
  async function checkpoint(){await fs.writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));}
  async function step(name,fn){
    const started=Date.now();let timer;const row={name,status:'RUNNING'};report.steps.push(row);await checkpoint();console.log('LOCAL_PRODUCT_QA_STEP',name);
    try{const evidence=await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Step exceeded 25 seconds: '+name)),25000);})]);row.status='PASS';if(evidence!==undefined)row.evidence=evidence;}
    catch(error){row.status='FAIL';row.error=error.message;throw error;}
    finally{clearTimeout(timer);row.milliseconds=Date.now()-started;await checkpoint();}
  }
  const snapshot=uid=>{
    const row=preview.db.sqlite.prepare('SELECT version,model,filters FROM style_accounts WHERE user_id=?').get(uid);
    return {accountExists:!!row,version:row?.version??0,model:row?JSON.parse(row.model):null,filters:row?JSON.parse(row.filters):null,
      votes:preview.db.sqlite.prepare('SELECT pid,action FROM style_votes WHERE user_id=? ORDER BY pid').all(uid),
      saved:preview.db.sqlite.prepare('SELECT pid FROM style_saved WHERE user_id=? ORDER BY pid').all(uid),
      receipts:preview.db.sqlite.prepare('SELECT id,version FROM feature_requests WHERE user_id=? ORDER BY version').all(uid)};
  };
  async function contextFor(profile,viewport={width:390,height:844}){
    const context=await browser.newContext({viewport,deviceScaleFactor:1});contexts.push(context);context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(10000);
    // Deny ALL external browser traffic, not merely Telegram's SDK.
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin||url.protocol==='data:')return route.continue();
      report.blockedExternalRequests.push({host:url.host,path:url.pathname});return route.abort('blockedbyclient');
    });
    const session=await (await context.request.get(origin+'/preview/session?profile='+profile,{timeout:10000})).json();
    assert.equal(session.localOnly,true);
    await context.addInitScript(init=>{
      if(window!==parent)return;
      window.Telegram={WebApp:{initData:init,ready(){},expand(){},BackButton:{isVisible:false,onClick(){},show(){this.isVisible=true;},hide(){this.isVisible=false;}}}};
    },session.initData);
    context.on('request',request=>{
      const url=new URL(request.url());if(url.origin!==origin||!url.pathname.startsWith('/api/style/'))return;
      const entry={profile,path:url.pathname,method:request.method()};
      if(request.postData()){try{entry.body=JSON.parse(request.postData());}catch{entry.body='INVALID_JSON';}}
      // Headers and signed initData are deliberately not recorded.
      report.requests.push(entry);
    });return context;
  }
  async function pageFor(context){const page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());return page;}
  async function open(page){await page.goto(origin+'/style',{waitUntil:'domcontentloaded'});await page.locator('#filter-label').filter({hasNotText:'Загружаем'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#apply-filters').disabled);}
  async function readyCard(page){await page.locator('#card img').waitFor();await page.locator('#card img').evaluate(image=>image.decode());await page.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);}
  async function choose(page,{audience='all',groups=[],max='',min=''}={}){
    await page.locator('#filters-panel').evaluate(panel=>{panel.open=true;});await page.locator(`[name="audience"][value="${audience}"]`).check();
    for(const group of ['clothing','shoes','bags','accessories'])await page.locator(`[name="groups"][value="${group}"]`).setChecked(groups.includes(group));
    await page.locator('#min-price').fill(String(min));await page.locator('#max-price').fill(String(max));
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/style/filters'&&r.request().method()==='PUT');await page.locator('#apply-filters').click();assert.equal((await response).status(),200);
    await page.waitForFunction(()=>!document.querySelector('#apply-filters').disabled);
  }
  async function screen(page,name){const target=path.join(out,name+'.png');await page.screenshot({path:target,fullPage:false});report.screenshots.push(target);}
  async function overflow(page){const result=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:document.documentElement.scrollWidth>innerWidth}));assert.equal(result.overflow,false,'Horizontal overflow');return result;}
  try{
    const {startPreview}=await import(pathToFileURL(path.join(__dirname,'preview_server.mjs')).href);
    await step('start_isolated_integrated_preview',async()=>{preview=await startPreview({port:8777,file,integrated:true});return {photos:preview.photos.size,port:8777,localSqliteNotD1:true};});
    browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.WB_BROWSER_QA_EXECUTABLE||chromium.executablePath(),env:{...process.env,TEMP:out,TMP:out}});
    const aContext=await contextFor('a',{width:320,height:740});let a=await pageFor(aContext),bContext,b;
    await step('first_open_is_read_only_320x740',async()=>{
      const before=snapshot(10001);await open(a);assert.equal(await a.locator('#onboarding-copy').isVisible(),true);const after=snapshot(10001);assert.deepEqual(after,before);assert.equal(after.accountExists,false);
      await screen(a,'onboarding-320');return {before,after,...await overflow(a)};
    });
    await step('audience_categories_budget_saved_no_stale_price',async()=>{
      await choose(a,{audience:'women',groups:['clothing','bags'],max:1000});
      const after=snapshot(10001);assert.equal(after.filters.audience,'women');assert.deepEqual(after.filters.groups,['clothing','bags']);assert.equal(after.filters.maxPrice,1000);
      await a.getByText('Нет подтверждённых цен под этот бюджет',{exact:true}).waitFor();assert.equal(await a.locator('#card .product-price').count(),0);await screen(a,'verified-price-unavailable-320');return after;
    });
    await step('explicit_all_interests_load_real_photos_320_and_390',async()=>{
      await choose(a);await readyCard(a);await a.locator('#actions').scrollIntoViewIfNeeded();const narrow=await overflow(a);await screen(a,'rating-card-320');
      const buttons=await a.locator('#actions button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {text:n.textContent.trim(),width:r.width,height:r.height};}));assert.ok(buttons.every(button=>button.height>=44&&button.width>=44));
      await a.setViewportSize({width:390,height:844});await a.locator('#actions').scrollIntoViewIfNeeded();const wide=await overflow(a);await screen(a,'rating-card-390');return {narrow,wide,buttons};
    });
    await step('favorite_and_committed_lost_vote_response_safe_retry',async()=>{
      const favoriteResponse=a.waitForResponse(r=>new URL(r.url()).pathname==='/api/style/favorite');await a.getByRole('button',{name:'В избранное',exact:true}).click();assert.equal((await favoriteResponse).status(),200);await a.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);
      let dropped=false;await aContext.route('**/api/style/vote',async route=>{if(dropped)return route.continue();dropped=true;const committed=await route.fetch({timeout:10000});assert.equal(committed.status(),200);await route.abort('failed');});
      const before=snapshot(10001);await a.locator('[data-action="like"]').click();await a.locator('#error').waitFor({state:'visible'});const committed=snapshot(10001);assert.equal(committed.votes.length,1);assert.equal(committed.model.samples,1);assert.equal(await a.locator('[data-action="like"]').isDisabled(),true);
      await a.locator('#retry').click();await a.locator('#progress').filter({hasText:'1 оценено'}).waitFor();await a.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);await aContext.unroute('**/api/style/vote');
      const after=snapshot(10001),attempts=report.requests.filter(request=>request.profile==='a'&&request.path==='/api/style/vote');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);assert.deepEqual(after.votes,committed.votes);assert.equal(after.receipts.length,committed.receipts.length);return {before,afterCommitBeforeRetry:committed,afterRetry:after,sameRequestId:attempts[0].body.requestId};
    });
    await step('double_click_creates_only_one_vote',async()=>{
      const before=snapshot(10001);await a.locator('[data-action="more"]').dblclick({delay:0});await a.locator('#progress').filter({hasText:'2 оценено'}).waitFor();await a.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);const after=snapshot(10001);assert.equal(after.votes.length,before.votes.length+1);assert.equal(after.model.samples,2);return {before,after};
    });
    await step('full_page_close_reopen_keeps_votes_favorites_filters',async()=>{
      const before=snapshot(10001);await a.close();a=await pageFor(aContext);await open(a);await readyCard(a);await a.locator('#progress').filter({hasText:'2 оценено'}).waitFor();await a.locator('[data-tab="favorites"]').click();await a.locator('#favorites-list .product-card').waitFor();assert.equal(await a.locator('#favorites-list .product-card').count(),1);assert.deepEqual(snapshot(10001),before);await screen(a,'favorites-390');return snapshot(10001);
    });
    await step('existing_ratings_empty_filters_read_without_default_write',async()=>{
      // Explicit LOCAL legacy-record fixture: real preceding local UI votes,
      // but no filter document, matching accounts created before onboarding.
      preview.db.sqlite.prepare("UPDATE style_accounts SET filters='{}' WHERE user_id=10001").run();
      const before=snapshot(10001),putsBefore=report.requests.filter(request=>request.profile==='a'&&request.path==='/api/style/filters'&&request.method==='PUT').length;
      await a.close();a=await pageFor(aContext);await open(a);await readyCard(a);await a.locator('#progress').filter({hasText:'2 оценено'}).waitFor();assert.equal(await a.locator('#onboarding-copy').isHidden(),true);
      await a.locator('[data-tab="recommend"]').click();await readyCard(a);
      const putsAfter=report.requests.filter(request=>request.profile==='a'&&request.path==='/api/style/filters'&&request.method==='PUT').length;
      assert.equal(putsAfter,putsBefore);assert.deepEqual(snapshot(10001),before);assert.deepEqual(before.filters,{});return {localLegacyShapeFixture:true,ratings:before.model.samples,seen:before.model.seen,extraSettingsWrites:putsAfter-putsBefore,filtersStillEmpty:true,learnAndRecommendationsAvailable:true};
    });
    await step('second_local_fixture_separate_profile_not_real_account',async()=>{
      bContext=await contextFor('b');b=await pageFor(bContext);await open(b);assert.equal(snapshot(10002).accountExists,false);await choose(b,{groups:['shoes']});await readyCard(b);const favorite=b.waitForResponse(r=>new URL(r.url()).pathname==='/api/style/favorite');await b.getByRole('button',{name:'В избранное',exact:true}).click();assert.equal((await favorite).status(),200);await b.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);await b.locator('[data-action="dislike"]').click();await b.locator('#progress').filter({hasText:'1 оценено'}).waitFor();
      const aa=snapshot(10001),bb=snapshot(10002);assert.equal(aa.model.samples,2);assert.equal(bb.model.samples,1);assert.deepEqual(bb.filters.groups,['shoes']);assert.equal(bb.saved.length,1);return {a:aa,b:bb};
    });
    await step('offline_read_error_then_retry_recovers',async()=>{
      const before=snapshot(10001);await aContext.setOffline(true);await a.locator('[data-tab="recommend"]').click();await a.locator('#error').waitFor({state:'visible'});await a.getByText('Вы без интернета.',{exact:false}).waitFor();await screen(a,'offline-error-390');assert.deepEqual(snapshot(10001),before);
      await aContext.setOffline(false);await a.locator('#retry').click();await readyCard(a);assert.equal(await a.locator('#error').isHidden(),true);assert.deepEqual(snapshot(10001),before);return {recovered:true,unchangedProfile:true};
    });
    await step('slow_feed_shows_loading_without_duplicate_actions',async()=>{
      let delayed=false;await aContext.route('**/api/style/feed?**',async route=>{if(!delayed){delayed=true;await new Promise(resolve=>setTimeout(resolve,1400));}await route.continue();});
      const before=snapshot(10001),started=Date.now();await a.locator('[data-tab="learn"]').click();await a.locator('#operation-status').filter({hasText:'Загружаем'}).waitFor();assert.equal(await a.locator('#apply-filters').isDisabled(),true);assert.equal(await a.locator('[data-tab="favorites"]').isDisabled(),true);await readyCard(a);await aContext.unroute('**/api/style/feed?**');assert.deepEqual(snapshot(10001),before);return {delayedMilliseconds:Date.now()-started,readOnly:true};
    });
    await step('same_origin_public_app_return_and_overlay_handshake',async()=>{
      await a.getByRole('button',{name:'← Находки',exact:true}).click();await a.waitForURL(origin+'/');const discovery=a.locator('#skip-discovery');if(await discovery.isVisible())await discovery.click();await a.locator('#open-my-style').click();const frame=a.frameLocator('#my-style-frame');await frame.locator('#progress').filter({hasText:'2 оценено'}).waitFor();await frame.getByRole('button',{name:'← Находки',exact:true}).click();await a.locator('#my-style-frame').waitFor({state:'detached'});assert.equal(await a.locator('#open-my-style').getAttribute('aria-expanded'),'false');await a.goto(origin+'/style',{waitUntil:'domcontentloaded'});await readyCard(a);return {sameOriginHandshake:true,publicFunctionsPreserved:true};
    });
    await step('reset_keeps_favorite_and_other_user',async()=>{
      const beforeB=snapshot(10002);await a.locator('[data-tab="preferences"]').click();await a.locator('#reset').click();await a.getByText('0 ваших оценок',{exact:true}).waitFor();await a.waitForFunction(()=>!document.querySelector('#reset').disabled);const after=snapshot(10001);assert.equal(after.votes.length,0);assert.equal(after.saved.length,1);assert.deepEqual(after.filters,{});assert.deepEqual(snapshot(10002),beforeB);return {a:after,bUnchanged:true};
    });
    await step('delete_all_history_keeps_only_revision_and_preserves_user_B',async()=>{
      const beforeB=snapshot(10002);await choose(a);await readyCard(a);await a.locator('[data-action="like"]').click();await a.locator('#progress').filter({hasText:'1 оценено'}).waitFor();await a.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);await a.locator('[data-tab="preferences"]').click();await a.getByRole('button',{name:'Удалить также избранное «Моего стиля»',exact:true}).click();await a.getByText('0 ваших оценок',{exact:true}).waitFor();await a.waitForFunction(()=>!document.querySelector('#reset').disabled);
      const after=snapshot(10001);assert.equal(after.votes.length,0);assert.equal(after.saved.length,0);assert.deepEqual(after.filters,{});assert.deepEqual(after.model.stats,{});assert.equal(after.model.samples,0);assert.deepEqual(snapshot(10002),beforeB);return {a:after,bUnchanged:true,retainedEmptyRevisionTombstone:true};
    });
    await step('restart_worker_local_sqlite_persists_real_rows',async()=>{
      const beforeA=snapshot(10001),beforeB=snapshot(10002);await aContext.close();await bContext.close();preview.server.closeAllConnections();await preview.close();preview=await startPreview({port:8777,file,integrated:true});
      const nextContext=await contextFor('b'),next=await pageFor(nextContext);await open(next);await readyCard(next);await next.locator('#progress').filter({hasText:'1 оценено'}).waitFor();await next.locator('[data-tab="favorites"]').click();await next.locator('#favorites-list .product-card').waitFor();assert.deepEqual(snapshot(10001),beforeA);assert.deepEqual(snapshot(10002),beforeB);return {profileAndFavoritesSurvive:true,a:beforeA,b:beforeB};
    });
    assert.deepEqual(report.pageErrors,[]);report.status='PASS';report.final={subscriberA:snapshot(10001),subscriberB:snapshot(10002),billingRowsRead:'UNKNOWN_LOCAL_SQLITE_NOT_D1',localSqlStatements:preview.db.queries.length,localReturnedRows:preview.db.queries.reduce((n,q)=>n+(q.returned??0),0),realAccountsVerified:false};
  }catch(error){report.status='FAIL';report.error=error.message;for(const context of contexts)for(const page of context.pages())try{await screen(page,'failure-'+report.screenshots.length);}catch{};throw error;}
  finally{
    report.finishedAt=new Date().toISOString();await checkpoint();
    await browser?.close();if(preview){preview.server.closeAllConnections();await preview.close().catch(()=>{});}console.log('LOCAL_PRODUCT_QA_RESULT',path.join(out,'result.json'));console.log(JSON.stringify({label:report.label,status:report.status,steps:report.steps.map(step=>({name:step.name,status:step.status})),reportDirectory:out,error:report.error}));
  }
}
main().catch(error=>{console.error('LOCAL_PRODUCT_QA_FAILED',error.message);process.exitCode=1;});
