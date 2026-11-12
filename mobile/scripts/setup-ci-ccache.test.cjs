const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const cp=require("node:child_process");
const script=path.join(__dirname,"setup-ci-ccache.sh");
const executable=(file,content)=>{fs.writeFileSync(file,content,{mode:0o755});};
function withRunner(fn){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"persai-ccache-test-"));
  const bin=path.join(root,"bin"),envFile=path.join(root,"github-env");
  fs.mkdirSync(bin);fs.writeFileSync(envFile,"");
  try{return fn({root,bin,envFile});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
test("installed ccache is reused and exported for both native and release builds",()=>{
  withRunner(({bin,envFile})=>{
    executable(path.join(bin,"ccache"),'#!/bin/sh\n[ "$1" = "--version" ] && echo "ccache test"\nexit 0\n');
    fs.symlinkSync("/usr/bin/head",path.join(bin,"head"));
    cp.execFileSync("/bin/bash",[script],{env:{...process.env,PATH:bin,GITHUB_ENV:envFile},timeout:5000});
    assert.equal(fs.readFileSync(envFile,"utf8"),"PERSAI_CCACHE_BIN="+path.join(bin,"ccache")+"\n");
  });
});
test("Ubuntu DNS/apt outage is bounded, explicitly disables optional cache, and does not fail APK",()=>{
  withRunner(({bin,envFile})=>{
    // No network access or privileged apt: emulate both failed installation attempts.
    executable(path.join(bin,"sudo"),"#!/bin/sh\nexit 100\n");
    executable(path.join(bin,"sleep"),"#!/bin/sh\nexit 0\n");
    fs.symlinkSync("/usr/bin/timeout",path.join(bin,"timeout"));
    const output=cp.execFileSync("/bin/bash",[script],{
      env:{...process.env,PATH:bin,GITHUB_ENV:envFile},timeout:5000,encoding:"utf8",
    });
    assert.match(output,/ccache unavailable/);
    assert.equal(fs.readFileSync(envFile,"utf8"),"PERSAI_CCACHE_BIN=\n");
  });
});
test("both workflows use one optional setup and never unconditionally demand cached compilation",()=>{
  const root=path.resolve(__dirname,"../..");
  for(const file of [".github/workflows/mobile-native-sqlcipher.yml",
    ".github/workflows/android-test-apk.yml"]){
    const text=fs.readFileSync(path.join(root,file),"utf8");
    assert.match(text,/scripts\/setup-ci-ccache\.sh/);
    assert.match(text,/PERSAI_CCACHE_BIN:-/);
    assert.match(text,/without (?:optional )?ccache|without the optional compiler cache/);
    assert.doesNotMatch(text,/sudo apt-get install -y/);
  }
});
