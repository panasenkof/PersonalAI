'use strict';
/** Source-bundle integrity. Provenance additionally requires a trusted CI run. */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const TD_SHA='c8828d50f5eac2fc7089ce1089d7ce9095c61b5e';
const SSL_TAG='openssl-3.5.9';
const ARCH={'arm64-v8a':183,x86_64:62};
const EXPECTED=['libs/arm64-v8a/libtdjsonjava.so','libs/x86_64/libtdjsonjava.so',
  'java/org/drinkless/tdlib/JsonClient.java'];
function invalid(reason){throw new Error('tdlib_bundle_'+reason);}
function ownFile(root,relative){
  if(!EXPECTED.includes(relative))invalid('path');
  const filename=path.resolve(root,relative);
  const realRoot=fs.realpathSync(root)+path.sep;
  if(!filename.startsWith(realRoot)||!fs.lstatSync(filename).isFile()||
     fs.lstatSync(filename).isSymbolicLink()||
     !fs.realpathSync(filename).startsWith(realRoot))invalid('unsafe_file');
  return filename;
}
const sha=(filename)=>crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function validateFile(root,relative){
  const filename=ownFile(root,relative);
  if(relative.endsWith('.so')){
    const size=fs.statSync(filename).size;
    if(size<100000||size>120*1024*1024)invalid('native_size');
    const h=Buffer.alloc(64),fd=fs.openSync(filename,'r');
    try{if(fs.readSync(fd,h,0,64,0)!==64)invalid('elf_short');}finally{fs.closeSync(fd);}
    if(h[0]!==127||h.toString('ascii',1,4)!=='ELF'||h[4]!==2||h[5]!==1||
       h.readUInt16LE(18)!==ARCH[relative.split('/')[1]])invalid('elf_arch');
  }else{
    const java=fs.readFileSync(filename,'utf8');
    if(!java.includes('package org.drinkless.tdlib;')||
       !java.includes('class JsonClient')||!java.includes('native int createClientId()'))invalid('java_abi');
  }
  return sha(filename);
}
function verifyBundle(root){
  const manifestPath=path.join(root,'manifest.json');
  if(!fs.existsSync(manifestPath)||fs.lstatSync(manifestPath).isSymbolicLink())invalid('manifest_missing');
  const raw=fs.readFileSync(manifestPath,'utf8');
  if(raw.length>8192)invalid('manifest_large');
  let m;try{m=JSON.parse(raw);}catch{invalid('manifest_json');}
  if(m.version!==1||m.tdlibCommit!==TD_SHA||m.opensslTag!==SSL_TAG||
     m.interface!=='JSONJava'||m.minSdk!==26||!Array.isArray(m.abis)||
     m.abis.join(',')!=='arm64-v8a,x86_64'||!m.files||typeof m.files!=='object'||
     Object.keys(m.files).sort().join('|')!==EXPECTED.slice().sort().join('|'))invalid('manifest');
  for(const relative of EXPECTED){
    if(typeof m.files[relative]!=='string'||!/^[a-f0-9]{64}$/.test(m.files[relative])||
       validateFile(root,relative)!==m.files[relative])invalid('checksum');
  }
  return m;
}
function createManifest(root){
  if(fs.existsSync(path.join(root,'manifest.json')))invalid('manifest_already_exists');
  const files={};
  for(const relative of EXPECTED)files[relative]=validateFile(root,relative);
  const m={version:1,tdlibCommit:TD_SHA,opensslTag:SSL_TAG,interface:'JSONJava',
    minSdk:26,abis:['arm64-v8a','x86_64'],files};
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(m,null,2)+'\n',{flag:'wx',mode:0o600});
  verifyBundle(root);
  return m;
}
function stageBundle(root,dest){
  const m=verifyBundle(root);
  const copies=m.abis.map(abi=>[
    ownFile(root,'libs/'+abi+'/libtdjsonjava.so'),
    path.join(dest,'android/src/main/jniLibs',abi,'libtdjsonjava.so'),
  ]);
  copies.push([ownFile(root,'java/org/drinkless/tdlib/JsonClient.java'),
    path.join(dest,'android/src/main/java/org/drinkless/tdlib/JsonClient.java')]);
  for(const [from,to] of copies){
    fs.mkdirSync(path.dirname(to),{recursive:true});
    fs.copyFileSync(from,to+'.new');
    fs.renameSync(to+'.new',to);
  }
  return copies.length;
}
if(require.main===module){
  const [mode,root,dest]=process.argv.slice(2);
  if(!root||!['verify','manifest','stage'].includes(mode))invalid('usage');
  if(mode==='verify')verifyBundle(root);
  else if(mode==='manifest')createManifest(root);
  else{if(!dest)invalid('destination');stageBundle(root,dest);}
  process.stdout.write('Official-source TDLib bundle verified: '+TD_SHA.slice(0,12)+'\n');
}
module.exports={TD_SHA,SSL_TAG,EXPECTED,verifyBundle,createManifest,stageBundle};
