#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function classifyEmulatorFailure(resultsDir) {
  const hierarchy = readIfPresent(path.join(resultsDir, 'window.xml'));
  const logcat = readIfPresent(path.join(resultsDir, 'logcat.txt'));
  const junitExists = fs.existsSync(path.join(resultsDir, 'junit.xml'));

  // Only the Android *system* launcher ANR, never the tested app's ANR.
  // The hierarchy captures the blocking dialog at the instant of failure.
  const launcherDialog = /(?:Pixel Launcher|Launcher3|Quickstep|System UI)[^<"]{0,90}(?:isn.t responding|is not responding)/i.test(hierarchy);
  const launcherAnr = /ANR in (?:com\.google\.android\.apps\.nexuslauncher|com\.android\.launcher3|com\.android\.systemui)\b/i.test(logcat);
  const retry = launcherDialog || (!junitExists && launcherAnr) || !junitExists;
  const reason = launcherDialog
    ? 'blocking Android launcher/system UI ANR dialog'
    : !junitExists && launcherAnr
      ? 'system launcher ANR before JUnit result'
      : !junitExists
        ? 'emulator / test runner did not produce a JUnit result'
        : 'Maestro reported a product/test failure; retry forbidden';
  return { retry, reason };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write('usage: classify-emulator-failure.cjs <attempt-evidence-dir>\n');
    process.exit(2);
  }
  const result = classifyEmulatorFailure(dir);
  process.stdout.write('Android smoke retry decision: ' + result.reason + '\n');
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'retry=' + result.retry + '\n');
  }
}

module.exports = { classifyEmulatorFailure };
