'use strict';

// Verify that the AGP/CMake integration actually used the CI ccache launcher.
// A populated actions/cache directory alone says nothing about compiler usage.
const fs = require('node:fs');
const path = require('node:path');

const MODULES = ['react-native-executorch', 'expo-modules-core', 'react-native-audio-api'];

function findCaches(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const scan = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (item.isFile() && item.name === 'CMakeCache.txt') result.push(file);
    }
  };
  scan(root);
  return result;
}

function hasLauncher(content, binary) {
  return ['CMAKE_C_COMPILER_LAUNCHER', 'CMAKE_CXX_COMPILER_LAUNCHER'].every((key) =>
    content.split(/\r?\n/).some((line) =>
      new RegExp('^' + key + ':[^=]+=').test(line) && line.slice(line.indexOf('=') + 1) === binary
    )
  );
}

function audit(moduleRoot, abi, binary) {
  return MODULES.map((name) => {
    const directory = path.join(moduleRoot, name, 'android', '.cxx');
    const caches = findCaches(directory).filter((file) =>
      file.split(path.sep).includes(abi)
    );
    const matched = caches.filter((file) => hasLauncher(fs.readFileSync(file, 'utf8'), binary));
    return { name, caches: caches.length, matched: matched.length };
  });
}

if (require.main === module) {
  const binary = process.env.PERSAI_CCACHE_BIN;
  const abi = process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures;
  if (!binary || !path.isAbsolute(binary) || !['arm64-v8a', 'x86_64'].includes(abi)) {
    process.stderr.write('Invalid ccache launcher path or native ABI\n');
    process.exitCode = 1;
  } else {
    const modules = audit(path.join(__dirname, '..', 'node_modules'), abi, binary);
    for (const module of modules) {
      process.stdout.write(`${module.name} (${abi}): ${module.matched}/${module.caches} CMake configurations use ${binary}\n`);
      if (module.caches === 0 || module.matched !== module.caches) {
        process.stderr.write(`::error::Native CMake compiler cache disabled or incomplete in ${module.name}\n`);
        process.exitCode = 1;
      }
    }
  }
}

module.exports = { MODULES, findCaches, hasLauncher, audit };
