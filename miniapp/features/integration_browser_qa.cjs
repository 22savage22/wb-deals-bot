// Local UI integration fixtures only; never a real-account success claim.
const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {chromium}=require(process.env.WB_BROWSER_QA_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'../..'),base=path.join(root,'.test-temp/style-integration-qa');await fs.mkdir(base,{recursive:true});const out=await fs.mkdtemp(path.join(base,'run-'));
  const {startPreview}=await import(pathToFileURL(path.join(__dirname,'preview_server.mjs')).href),server=await startPreview({port:8775,file:path.join(out,'qa.sqlite3'),integrated:true});let browser;
  try{
    browser=await chromium.launch({headless:true,timeout:15000,executablePath:process.env.WB_BROWSER_QA_EXECUTABLE,env:{...process.env,TEMP:out,TMP:out}});
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await context.route('https://telegram.org/**',route=>route.abort());
    const auth=await (await context.request.get('http://127.0.0.1:8775/preview/session?profile=a')).json();
    await context.addInitScript(init=>{if(window===parent)window.Telegram={WebApp:{initData:init,ready(){},expand(){},BackButton:{onClick(){},show(){},hide(){}}}};},auth.initData);
    await page.goto('http://127.0.0.1:8775/',{waitUntil:'networkidle',timeout:15000});await page.locator('#skip-discovery').click();await page.locator('#open-my-style').click();
    const frame=page.frameLocator('.style-overlay');await frame.locator('#card img').evaluate(img=>img.decode());
    await frame.locator('[data-action="like"]').click();await frame.locator('#progress').filter({hasText:'1 оценено'}).waitFor();
    await frame.getByRole('button',{name:'← Находки',exact:true}).click();await page.locator('.style-overlay').waitFor({state:'detached'});
    await page.locator('#open-my-style').click();await frame.locator('#progress').filter({hasText:'1 оценено'}).waitFor();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(overflow||errors.length)throw Error('INTEGRATION_UI_ERROR');
    await frame.locator('[data-action="like"]').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'style-in-existing-app.png')});
    const result={localFixture:true,realTelegramAccountsTested:0,viewport:'390x844',navigation:'PASS',sameOriginHandshake:'PASS',closeReopenPersistence:'PASS',errors,overflow,productionCalls:0,reportDirectory:out};await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser?.close();await server.close();}
})().catch(e=>{console.error('LOCAL_INTEGRATION_QA_FAILED',e.message);process.exitCode=1;});
