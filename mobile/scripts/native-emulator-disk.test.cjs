'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('native CI frees disk after uploading APK, before installing Maestro and AVD', () => {
  const yaml = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/mobile-native-sqlcipher.yml'), 'utf8');
  const saved = yaml.indexOf('- name: Save standalone emulator APK');
  const reclaim = yaml.indexOf('- name: Reclaim native build disk space before Android emulator');
  const maestro = yaml.indexOf('- name: Install pinned Maestro CLI');
  const smoke = yaml.indexOf('- name: Run real Android UI smoke');
  assert(saved >= 0 && saved < reclaim && reclaim < maestro && maestro < smoke);
  const step = yaml.slice(reclaim, maestro);
  assert.match(step, /test -s "\$apk"/);
  assert.match(step, /ndk\/27\.0\.12077973/);
  assert.match(step, /android\/app\/build\/intermediates/);
  assert.match(step, /df -Pk/);
  assert.match(step, /Insufficient runner disk/);
  assert.doesNotMatch(step, /rm -rf .*outputs/);
  assert.doesNotMatch(step, /rm -rf .*ccache/);
  // A low-space preflight must fail CI, never silently skip emulator QA.
  assert.match(yaml.slice(smoke), /Require successful Android smoke/);
});
