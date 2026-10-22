/** Browser acceptance for standalone Nebula Home composition study.
 * Tests layout and affordances only, NOT native Skia or real backend.
 */
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
const {chromium}=require("playwright");
const html=path.resolve(__dirname,"../../docs/prototypes/nebula-home-composition-v03.html");
(async()=>{
 assert(fs.existsSync(html),"Home composition prototype missing");
 const browser=await chromium.launch({headless:true,args:["--no-sandbox"],...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:960},reducedMotion:"reduce"});
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("file://"+html);
  const orb=page.locator(".orb");
  await orb.waitFor();
  assert(await orb.evaluate(el=>el.naturalWidth>0),"Approved REF-ORB-B must load from repository art");
  assert.equal(await page.getByText("Чем помочь сегодня?").count(),0);
  assert.equal(await page.getByLabel("Сообщение").isEditable(),true);
  for(const width of [320,360,390,430]){
    await page.locator("#device").selectOption(String(width));
    const phone=await page.locator(".phone").boundingBox();
    assert(phone.width<=width+2,"Phone should respect selected width "+width);
    for(const label of ["Прикрепить файл","Голосовой ввод","Отправить демонстрационное сообщение"]){
      const rect=await page.getByLabel(label).boundingBox();
      assert(rect.x>=phone.x-1&&rect.x+rect.width<=phone.x+phone.width+1,label+" exceeds "+width+"dp");
    }
  }
  await page.getByRole("button",{name:"Диалог"}).click();
  assert(await page.locator(".msg").count()>=4,"Mock conversation must render");
  await page.getByRole("button",{name:"ИИ думает"}).click();
  assert(await page.getByText("Обрабатываю запрос",{exact:true}).count()>=1,"Real state should have visual target");
  await page.getByRole("button",{name:"Клавиатура"}).click();
  assert(await page.locator(".kbd.open").isVisible(),"Keyboard state must be selectable");
  const c=await page.locator(".composer").boundingBox(),n=await page.locator(".tabs").boundingBox();
  assert(c.y+c.height<=n.y+1,"Keyboard must not overlap bottom navigation/composer");
  await page.getByLabel("Прикрепить файл").click();
  await page.getByRole("button",{name:"▣ PDF"}).click();
  assert(await page.locator(".file").count()===1,"Attachment chip shown");
  await page.locator(".file button").click();
  assert(await page.locator(".file").count()===0,"Attachment chip can be removed");
  await page.getByLabel("Сообщение").fill("Проверочный текст");
  await page.getByLabel("Отправить демонстрационное сообщение").click();
  assert(await page.getByText(/Демонстрация, не отправлено/).count()===1,"No mock response masquerades as production");
  assert.deepEqual(errors,[],"No JS runtime errors");
  console.log("PASS Nebula Home prototype: 4 widths, image, chat, keyboard, attachment, draft and no page errors");
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
