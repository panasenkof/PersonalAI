// Browser smoke against a local static server: node scripts/verify-web.cjs
// Requires playwright; BASE_URL defaults to http://127.0.0.1:8765/app/.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    for(const width of [320,390,768,1440]) {
      const page=await browser.newPage({viewport:{width,height:900},colorScheme:width===390?'dark':'light'});
      const errors=[]; page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/v1/**',route=>{
        const url=route.request().url();
        route.fulfill({json:url.includes('conversations')?[]:url.includes('/facts')?{facts:[]}:url.includes('/auth/token')?{access_token:'test'}:{}});
      });
      await page.goto(process.env.BASE_URL||'http://127.0.0.1:8765/app/');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#email').fill('user@example.com'); await page.locator('#password').fill('12345678'); await page.locator('#btnLogin').click();
      await page.locator('#welcome').waitFor();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      if(width<700) {await page.locator('#btnChats').click();assert.equal(await page.locator('aside').isVisible(),true);await page.locator('#btnNew').click();}
      await page.locator('#welcome button').first().click();assert.equal(await page.locator('#input').inputValue(),'Что ты умеешь?');
      await page.locator('#btnSettings').click();assert.equal(await page.locator('#settings').isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#btnCloseSettings').click();
      if(process.env.SCREENSHOT_DIR) await page.screenshot({path:`${process.env.SCREENSHOT_DIR}/web-${width}.png`,fullPage:true});
      assert.deepEqual(errors,[]);console.log(`PASS ${width}px auth, onboarding, navigation, settings, no overflow`);await page.close();
    }
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
