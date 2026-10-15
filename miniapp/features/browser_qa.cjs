// Optional local browser QA. Uses an already installed Playwright; no new packages.
// A separate disposable SQLite file and port, NEVER real users/production.
const fs=require('node:fs/promises'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.WB_BROWSER_QA_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'../..'),out=path.join(root,'.test-temp/feature-browser-qa');await fs.mkdir(out,{recursive:true});
  const run=await fs.mkdtemp(path.join(out,'run-')),{startPreview}=await import(pathToFileURL(path.join(__dirname,'preview_server.mjs')).href);
  const preview=await startPreview({port:8774,file:path.join(run,'qa.sqlite3')});let browser;
  try{
    // Use the full installed browser when headless-shell is unavailable on Windows.
    // All disposable browser files remain in this QA run's own directory.
    const browserOptions={headless:true,timeout:15000,env:{...process.env,TEMP:run,TMP:run}};
    if(process.env.WB_BROWSER_QA_EXECUTABLE)browserOptions.executablePath=process.env.WB_BROWSER_QA_EXECUTABLE;
    browser=await chromium.launch(browserOptions);
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    // No external service is needed to test the local UI; do not call Telegram SDK.
    await page.route('https://telegram.org/**',route=>route.abort());
    await page.goto('http://127.0.0.1:8774/style',{waitUntil:'networkidle',timeout:15000});
    await page.locator('#card img').waitFor();await page.locator('#card img').evaluate(img=>img.decode());
    const assert=(condition,message)=>{if(!condition)throw Error(message);};
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert(!overflow,'MOBILE_OVERFLOW');
    await page.screenshot({path:path.join(run,'my-style-mobile.png'),fullPage:true});
    const latency=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.startsWith('/api/')).map(r=>({path:new URL(r.name).pathname,milliseconds:Math.round(r.duration*10)/10})));
    await page.getByRole('button',{name:'В избранное',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);
    let dropped=false;
    await page.route('**/api/style/vote',async route=>{if(!dropped){dropped=true;await route.fetch();await route.abort();}else await route.continue();});
    await page.locator('[data-action="like"]').click();await page.locator('#error').waitFor({state:'visible'});
    const beforeRetry=preview.db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=10001').get().n;
    await page.locator('#retry').click();await page.waitForFunction(()=>document.querySelector('#progress').textContent==='1 оценено');
    const afterRetry=preview.db.sqlite.prepare('SELECT count(*) AS n FROM style_votes WHERE user_id=10001').get().n;assert(beforeRetry===1&&afterRetry===1,'LOST_RESPONSE_DUPLICATED_VOTE');
    await page.unroute('**/api/style/vote');
    await page.locator('[data-action="more"]').dblclick({delay:0});await page.waitForFunction(()=>document.querySelector('#progress').textContent==='2 оценено');
    for(const action of ['dislike','block_similar']){await page.waitForFunction(()=>!document.querySelector('[data-action="like"]').disabled);await page.locator(`[data-action="${action}"]`).click();}
    await page.waitForFunction(()=>document.querySelector('#progress').textContent==='4 оценено');
    await page.locator('#demo-profile').selectOption('b');await page.waitForURL('**/style?profile=b');await page.waitForFunction(()=>document.querySelector('#progress').textContent==='0 оценено');
    await page.locator('[data-tab="favorites"]').click();await page.getByText('Сохраняйте вещи сердечком на фотографии.').waitFor();
    await page.locator('#demo-profile').selectOption('a');await page.waitForURL('**/style?profile=a');await page.waitForFunction(()=>document.querySelector('#progress').textContent==='4 оценено');
    await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#progress').textContent==='4 оценено');
    const account=preview.db.sqlite.prepare('SELECT model FROM style_accounts WHERE user_id=10001').get(),a=JSON.parse(account.model);
    assert(a.samples===4&&a.saved===1,'PERSISTENCE_FAILED');assert(!preview.db.sqlite.prepare('SELECT user_id FROM style_accounts WHERE user_id=10002').get(),'B_WROTE_DEFAULTS');
    const actionLatency=await page.evaluate(()=>performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.startsWith('/api/')).map(r=>({path:new URL(r.name).pathname,milliseconds:Math.round(r.duration*10)/10})));
    await page.goto('http://127.0.0.1:8774/superfind',{waitUntil:'networkidle'});await page.locator('#refresh-super').click();
    await page.waitForFunction(()=>document.querySelector('#job-status').textContent.includes('Проверено'),{timeout:15000});
    const status=await page.locator('#job-status').innerText();assert(status.includes('прошло 0'),'HISTORICAL_CARD_BECAME_SUPERFIND');
    await page.locator('#super-rejected').locator('..').evaluate(el=>el.open=true);
    await page.screenshot({path:path.join(run,'superfind-mobile.png'),fullPage:false});
    assert(errors.length===0,errors.join(';'));
    const metrics={statements:preview.db.queries.length,returnedRows:preview.db.queries.reduce((n,q)=>n+(q.returned??0),0),billingRowsRead:'UNKNOWN_LOCAL_SQLITE_NOT_D1'};
    const result={viewport:'390x844',photos:preview.photos.size,overflow,pageErrors:errors,lostResponse:{beforeRetry,afterRetry},doubleClick:'ONE_VOTE',subscriberA:{ratings:a.samples,favorites:a.saved},subscriberB:'SEPARATE_EMPTY_PROFILE',persistence:'PASS',superfind:status,localInitialApiLatency:latency,localReloadApiLatency:actionLatency,localSql:metrics,productionCalls:0,aiCalls:0,reportDirectory:run};
    await fs.writeFile(path.join(run,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser?.close();await preview.close();}
})().catch(error=>{console.error('LOCAL_BROWSER_QA_FAILED',error.message);process.exitCode=1;});
