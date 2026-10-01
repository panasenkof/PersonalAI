// Browser smoke: starts its own /app/ static server unless BASE_URL is supplied.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { startWebTestServer } = require('./web-test-server.cjs');
(async()=>{
  const server=process.env.BASE_URL?null:await startWebTestServer();
  const base=process.env.BASE_URL||server.baseURL;
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
    for(const width of [320,390,768,1440]) {
      const page=await browser.newPage({viewport:{width,height:900},colorScheme:width===390?'dark':'light'});
      const actions=[]; const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/v1/**',route=>{
        const url=route.request().url();
        if(url.includes('/account/export')) {actions.push(JSON.parse(route.request().postData()));return route.fulfill({contentType:'application/zip',body:'test archive'});}
        if(url.includes('/password/reset')) actions.push(JSON.parse(route.request().postData()));
        route.fulfill({json:url.includes('conversations')?[]:url.includes('/facts')?{facts:[]}:url.includes('/auth/token')?{access_token:'test'}:url.includes('/auth/me')?{email:'demo@example.com',totp_enabled:false}:url.includes('/service/info')?{name:'PIA Agent',version:'0.3.0',operator:'Demo',backup_retention_days:30}:url.includes('/settings/llm/test')?{message:'Модель отвечает.'}:url.includes('/settings/llm')?{provider_kind:'cloud',base_url:'https://api.openai.com/v1',default_model:'test-model'}:url.includes('/password/reset')?{message:'Пароль изменён.'}:{}});
      });
      const response=await page.goto(base);
      assert.equal(response.status(),200,`Login page unavailable at ${base}`);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#email').fill('user@example.com'); await page.locator('#password').fill('12345678'); await page.locator('#btnLogin').click();
      await page.locator('#welcome').waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(width<700) {await page.locator('#btnChats').click();assert.equal(await page.locator('aside').isVisible(),true);await page.locator('#btnNew').click();}
      await page.locator('#welcome button').first().click();assert.equal(await page.locator('#input').inputValue(),'Что ты умеешь?');
      await page.locator('#btnSettings').click();assert.equal(await page.locator('#settings').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#dataPass').fill('private-password');
      const download=page.waitForEvent('download');await page.locator('#btnExport').click();
      assert.equal((await download).suggestedFilename(),'pia-account.zip');
      assert.equal(actions.at(-1).password,'private-password');
      await page.locator('#btnTestModel').click();await page.getByText('Модель отвечает.',{exact:true}).waitFor();
      await page.locator('#btnCloseSettings').click();
      assert.equal(await page.locator('#dataPass').inputValue(),'');
      if(process.env.SCREENSHOT_DIR) await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/web-${width}.png`,fullPage:true});
      await page.goto(base+'access.html#reset='+ 'a'.repeat(32));
      assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#code').inputValue(),'a'.repeat(32));
      await page.locator('#newPassword').fill('new-password');await page.locator('#finishButton').click();
      await page.getByText('Пароль изменён.',{exact:true}).waitFor();assert.equal(await page.locator('#newPassword').inputValue(),'');
      for(const document of ['service.html','start.html']){await page.goto(base+document);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${document} overflows at ${width}px`);}
      assert.deepEqual(errors,[]);console.log(`PASS ${width}px auth, onboarding, settings, export, reset, public pages, no overflow`);await page.close();
    }
  } finally {try {await browser?.close();} finally {await server?.close();}}
})().catch(error=>{console.error(error);process.exitCode=1;});
