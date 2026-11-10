'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {patchUpstream,SSL_ABIS,LIMITED_ABIS,NDK_LINKER,PAGE_FLAGS}=require('./patch-upstream.cjs');
function fixture(openssl=SSL_ABIS,tdlib=NDK_LINKER){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persai-tdlib-upstream-'));
  const ssl=path.join(dir,'build-openssl.sh'),td=path.join(dir,'build-tdlib.sh');
  fs.writeFileSync(ssl,'#!/bin/bash\n'+openssl+'\n  make -j4 -s\n done\n');
  fs.writeFileSync(td,'#!/bin/bash\ncmake '+tdlib+' -DTD_ANDROID_JSON_JAVA=ON .\n');
  return {dir,ssl,td};
}
test('only two required ABIs and explicit Android 16K page-size linker flags',()=>{
  const x=fixture();
  try{
    assert.deepEqual(patchUpstream(x.dir).abis,['arm64-v8a','x86_64']);
    const ssl=fs.readFileSync(x.ssl,'utf8'),td=fs.readFileSync(x.td,'utf8');
    assert.ok(ssl.includes(LIMITED_ABIS));
    assert.ok(!ssl.includes(SSL_ABIS));
    assert.ok(td.includes(NDK_LINKER+' '+PAGE_FLAGS));
    assert.ok(td.includes('TD_ANDROID_JSON_JAVA=ON'));
  }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('fails closed and never partially patches if TDLib script deviates',()=>{
  const x=fixture(SSL_ABIS,'-DANDROID_PLATFORM="android-35"');
  try{
    const original=fs.readFileSync(x.ssl,'utf8');
    assert.throws(()=>patchUpstream(x.dir),/tdlib_upstream_contract_tdlib_android_16k/);
    assert.equal(fs.readFileSync(x.ssl,'utf8'),original);
  }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('fails closed if upstream ABI loop changes; no source files modified',()=>{
  const x=fixture('for ABI in all ; do');
  try{
    const original=fs.readFileSync(x.td,'utf8');
    assert.throws(()=>patchUpstream(x.dir),/tdlib_upstream_contract_openssl_abis/);
    assert.equal(fs.readFileSync(x.td,'utf8'),original);
  }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
});
test('double patch or repeated upstream token is rejected',()=>{
  const x=fixture();
  try{
    patchUpstream(x.dir);
    assert.throws(()=>patchUpstream(x.dir),/tdlib_upstream_contract_openssl_abis/);
  }finally{fs.rmSync(x.dir,{recursive:true,force:true});}
  const y=fixture(SSL_ABIS,NDK_LINKER+' '+NDK_LINKER);
  try{
    assert.throws(()=>patchUpstream(y.dir),/tdlib_upstream_contract_tdlib_android_16k/);
  }finally{fs.rmSync(y.dir,{recursive:true,force:true});}
});
