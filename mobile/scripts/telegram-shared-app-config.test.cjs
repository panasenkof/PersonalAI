const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");

const source=fs.readFileSync(path.resolve(__dirname,"../app.config.js"),"utf8");
function configuration(env){
  const module={exports:{}};
  const context={
    module,exports:module.exports,process:{env},
    require(name){
      if(name==="./scripts/generate-brand.cjs")return {buildApprovedBrand(){}};
      throw new Error("Unexpected dependency "+name);
    },
  };
  vm.runInNewContext(source,context,{filename:"app.config.js"});
  return module.exports({config:{
    version:"0.3.0",plugins:[],extra:{},ios:{},android:{},
  }});
}
const credentials={
  PERSAI_TELEGRAM_API_ID:"456789",
  PERSAI_TELEGRAM_API_HASH:"A".repeat(32),
};
test("ordinary signed APK without TDLib never ships shared Telegram app hash",()=>{
  const config=configuration({PIA_ANDROID_RELEASE:"true",...credentials});
  assert.equal(config.extra.persaiTelegramApi,undefined);
});
test("reviewed TDLib signed APK receives one build-owned Telegram app identity",()=>{
  const config=configuration({
    PIA_ANDROID_RELEASE:"true",TDLIB_EXPLICIT_STAGE:"true",...credentials,
  });
  assert.equal(config.extra.persaiTelegramApi.apiId,456789);
  assert.equal(config.extra.persaiTelegramApi.apiHash,"a".repeat(32));
  assert.equal(config.android.package,"com.persai.app");
});
test("local developer builds can test shared Telegram identity without GitHub secrets",()=>{
  const config=configuration(credentials);
  assert.equal(config.extra.persaiTelegramApi.apiId,456789);
});
test("missing, invalid or partial API credentials fail the build without disclosing values",()=>{
  for(const env of [
    {PERSAI_TELEGRAM_API_ID:"456789"},
    {PERSAI_TELEGRAM_API_HASH:"a".repeat(32)},
    {PERSAI_TELEGRAM_API_ID:"0",PERSAI_TELEGRAM_API_HASH:"a".repeat(32)},
    {PERSAI_TELEGRAM_API_ID:"456789",PERSAI_TELEGRAM_API_HASH:"not-a-hash"},
  ]){
    assert.throws(()=>configuration({...env,PIA_ANDROID_RELEASE:"true"}),
      /Set BOTH valid PERSAI_TELEGRAM_API_ID and PERSAI_TELEGRAM_API_HASH/);
  }
  const config=configuration({PIA_ANDROID_RELEASE:"true",TDLIB_EXPLICIT_STAGE:"true"});
  assert.equal(config.extra.persaiTelegramApi,undefined); // CI hard-fails this combination
});
