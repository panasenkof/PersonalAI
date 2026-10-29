'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MODULES, hasLauncher, audit } = require('./verify-native-ccache.cjs');

const valid = (binary) =>
  `CMAKE_C_COMPILER_LAUNCHER:UNINITIALIZED=${binary}\nCMAKE_CXX_COMPILER_LAUNCHER:STRING=${binary}\n`;

test('CMake launchers must both match an absolute executable path', () => {
  assert.equal(hasLauncher(valid('/usr/bin/ccache'), '/usr/bin/ccache'), true);
  assert.equal(hasLauncher(valid('/usr/bin/ccache'), '/usr/local/bin/ccache'), false);
  assert.equal(hasLauncher('CMAKE_CXX_COMPILER_LAUNCHER:STRING=/usr/bin/ccache\n', '/usr/bin/ccache'), false);
  assert.equal(hasLauncher('#CMAKE_C_COMPILER_LAUNCHER:STRING=/usr/bin/ccache\n', '/usr/bin/ccache'), false);
});

test('native ccache audit checks all modules and only the requested ABI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persai-ccache-'));
  try {
    for (const name of MODULES) {
      for (const abi of ['x86_64', 'arm64-v8a']) {
        const dir = path.join(root, name, 'android', '.cxx', 'RelWithDebInfo', 'id', abi);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'CMakeCache.txt'), valid('/usr/bin/ccache'));
      }
    }
    const results = audit(root, 'x86_64', '/usr/bin/ccache');
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.caches === 1 && r.matched === 1));
    const wrongAbi = path.join(root, MODULES[0], 'android', '.cxx', 'RelWithDebInfo', 'id', 'x86_64', 'CMakeCache.txt');
    fs.writeFileSync(wrongAbi, valid('/other/ccache'));
    assert.equal(audit(root, 'x86_64', '/usr/bin/ccache')[0].matched, 0);
    assert.equal(audit(root, 'arm64-v8a', '/usr/bin/ccache')[0].matched, 1);
    fs.rmSync(path.join(root, MODULES[1]), { recursive: true });
    assert.equal(audit(root, 'x86_64', '/usr/bin/ccache')[1].caches, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
