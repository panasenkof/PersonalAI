'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyEmulatorFailure } = require('./classify-emulator-failure.cjs');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persai-emulator-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('retries a blocking system Launcher ANR, even with failed JUnit', (t) => {
  const dir = fixture({
    'window.xml': '<node text="Pixel Launcher isn&#39;t responding" />',
    'junit.xml': '<failure>PIN not visible</failure>',
    'logcat.txt': 'ANR in com.google.android.apps.nexuslauncher',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});

test('retries the actual CI hierarchy, preserving diagnostics', (t) => {
  const dir = fixture({
    'window.xml': '<node text="Pixel Launcher isn\'t responding" resource-id="android:id/alertTitle"/>',
    'junit.xml': '<failure>PIN selector not visible</failure>',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});

test('does not retry normal Maestro assertion failures or app crashes', (t) => {
  const dir = fixture({
    'window.xml': '<node text="Сообщение ассистенту" />',
    'junit.xml': '<failure>Expected note is visible</failure>',
    'logcat.txt': 'ANR in com.paigent.app',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, false);
});

test('does not mistake earlier Launcher ANR for a product test failure', (t) => {
  const dir = fixture({
    'window.xml': '<node text="PersAI home" />',
    'junit.xml': '<failure>Notes are missing</failure>',
    'logcat.txt': 'ANR in com.android.launcher3',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, false);
});

test('one retry allowed when the emulator never produced a JUnit report', (t) => {
  const dir = fixture({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});
