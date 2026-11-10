'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {TD_SHA,createManifest,verifyBundle,stageBundle}=require('./bundle.cjs');
function sample(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tdlib-bundle-'));
 for(const [abi,arch] of [['arm64-v8a',183],['x86_64',62]]){
   const file=path.join(root,'libs',abi,'libtdjsonjava.so');
   fs.mkdirSync(path.dirname(file),{recursive:true});
   const bytes=Buffer.alloc(100001);
   bytes[0]=127;bytes.write('ELF',1);bytes[4]=2;bytes[5]=1;bytes.writeUInt16LE(arch,18);
   bytes.writeBigUInt64LE(64n,32);bytes.writeUInt16LE(56,54);bytes.writeUInt16LE(1,56);
   bytes.writeUInt32LE(1,64);bytes.writeBigUInt64LE(16384n,64+48);
   fs.writeFileSync(file,bytes);
 }
 const java=path.join(root,'java/org/drinkless/tdlib/JsonClient.java');
 fs.mkdirSync(path.dirname(java),{recursive:true});
 fs.writeFileSync(java,'package org.drinkless.tdlib; public final class JsonClient { public static native int createClientId(); }');
 return root;
}
test('verifies pinned manifest and stages exact ABI files',()=>{
 const root=sample(),dest=fs.mkdtempSync(path.join(os.tmpdir(),'tdlib-out-'));
 try{
   assert.equal(createManifest(root).tdlibCommit,TD_SHA);
   assert.deepEqual(verifyBundle(root).abis,['arm64-v8a','x86_64']);
   assert.equal(stageBundle(root,dest),3);
   assert.equal(fs.statSync(path.join(dest,'android/src/main/jniLibs/arm64-v8a/libtdjsonjava.so')).size,100001);
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(dest,{recursive:true,force:true});}
});
test('wrong SHA or tampered file blocks installation',()=>{
 const root=sample(),dest=fs.mkdtempSync(path.join(os.tmpdir(),'tdlib-out-'));
 try{
   createManifest(root);
   const f=path.join(root,'manifest.json'),m=JSON.parse(fs.readFileSync(f));
   m.tdlibCommit='0'.repeat(40);fs.writeFileSync(f,JSON.stringify(m));
   assert.throws(()=>stageBundle(root,dest),/bundle_manifest/);
   m.tdlibCommit=TD_SHA;fs.writeFileSync(f,JSON.stringify(m));
   fs.appendFileSync(path.join(root,'java/org/drinkless/tdlib/JsonClient.java'),'// changed');
   assert.throws(()=>stageBundle(root,dest),/bundle_checksum/);
   assert.equal(fs.existsSync(path.join(dest,'android')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(dest,{recursive:true,force:true});}
});
test('architecture mismatch and symlinked input are rejected',()=>{
 let root=sample();
 try{
   const file=path.join(root,'libs/arm64-v8a/libtdjsonjava.so');
   const b=fs.readFileSync(file);b.writeUInt16LE(62,18);fs.writeFileSync(file,b);
   assert.throws(()=>createManifest(root),/bundle_elf_arch/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
 root=sample();
 try{
   const java=path.join(root,'java/org/drinkless/tdlib/JsonClient.java');
   fs.renameSync(java,java+'.orig');fs.symlinkSync(java+'.orig',java);
   assert.throws(()=>createManifest(root),/bundle_unsafe_file/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('incompatible 4 KiB native page alignment cannot enter an Android 16 APK',()=>{
 const root=sample();
 try{
   const file=path.join(root,'libs/arm64-v8a/libtdjsonjava.so');
   const data=fs.readFileSync(file);
   data.writeBigUInt64LE(4096n,64+48);
   fs.writeFileSync(file,data);
   assert.throws(()=>createManifest(root),/bundle_elf_16k_alignment/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
