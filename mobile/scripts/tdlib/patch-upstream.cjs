'use strict';
/** Reviewable, fail-closed adjustments to the pinned upstream Android build scripts.
 * The official tdlib/td repository and commit are still verified before use.
 * No precompiled native artifacts, vendored source, or third-party AAR.
 */
const fs=require('node:fs');
const path=require('node:path');

const SSL_ABIS='for ABI in arm64-v8a armeabi-v7a x86_64 x86 ; do';
const LIMITED_ABIS='for ABI in arm64-v8a x86_64 ; do';
const NDK_LINKER='-DANDROID_PLATFORM="android-$ANDROID_API_LEVEL"';
const PAGE_FLAGS='-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON -DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384';

function patchOnce(source,from,to,reason){
  const matches=source.split(from).length-1;
  if(matches!==1||source.includes(to))throw new Error('tdlib_upstream_contract_'+reason);
  return source.replace(from,to);
}
function patchUpstream(androidDirectory){
  const root=fs.realpathSync(androidDirectory);
  const openssl=path.join(root,'build-openssl.sh');
  const tdlib=path.join(root,'build-tdlib.sh');
  const sslOriginal=fs.readFileSync(openssl,'utf8');
  const tdOriginal=fs.readFileSync(tdlib,'utf8');
  // Validate BOTH files before writing either, so an upstream change does not
  // leave a half-modified source tree.
  const sslPatched=patchOnce(sslOriginal,SSL_ABIS,LIMITED_ABIS,'openssl_abis');
  const tdPatched=patchOnce(tdOriginal,NDK_LINKER,
    NDK_LINKER+' '+PAGE_FLAGS,'tdlib_android_16k');
  fs.writeFileSync(openssl,sslPatched);
  fs.writeFileSync(tdlib,tdPatched);
  return {openssl:openssl,tdlib:tdlib,abis:['arm64-v8a','x86_64']};
}
if(require.main===module){
  if(process.argv.length!==3)throw new Error('usage: patch-upstream.cjs <pinned-tdlib-example-android-directory>');
  patchUpstream(process.argv[2]);
  process.stdout.write('Pinned official Android source build: 2 ABIs and explicit 16 KiB linker gate\n');
}
module.exports={patchUpstream,patchOnce,SSL_ABIS,LIMITED_ABIS,NDK_LINKER,PAGE_FLAGS};
