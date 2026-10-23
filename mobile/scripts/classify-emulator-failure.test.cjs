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
    'smoke-started': '',
    'junit.xml': '<failure>PIN not visible</failure>',
    'logcat.txt': 'ANR in com.google.android.apps.nexuslauncher',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});

test('retries the actual CI hierarchy, preserving diagnostics', (t) => {
  const dir = fixture({
    'window.xml': '<node text="Pixel Launcher isn\'t responding" resource-id="android:id/alertTitle"/>',
    'smoke-started': '',
    'junit.xml': '<failure>PIN selector not visible</failure>',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});

test('does not retry normal Maestro assertion failures or app crashes', (t) => {
  const dir = fixture({
    'window.xml': '<node text="Сообщение ассистенту" />',
    'smoke-started': '',
    'junit.xml': '<failure>Expected note is visible</failure>',
    'logcat.txt': 'ANR in com.paigent.app',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, false);
});

test('does not mistake earlier Launcher ANR for a product test failure', (t) => {
  const dir = fixture({
    'window.xml': '<node text="PersAI home" />',
    'smoke-started': '',
    'junit.xml': '<failure>Notes are missing</failure>',
    'logcat.txt': 'ANR in com.android.launcher3',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, false);
});

test('one retry allowed when the emulator runner never invoked smoke', (t) => {
  const dir = fixture({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, true);
});

test('does not retry a script failure after smoke started without system ANR', (t) => {
  const dir = fixture({ 'smoke-started': '', 'logcat.txt': 'FATAL EXCEPTION in com.paigent.app' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(classifyEmulatorFailure(dir).retry, false);
});


test('native PIN flow matches Android 35 credential hierarchy captured in CI #384', () => {
  const unlock = fs.readFileSync(path.join(__dirname, '..', '.maestro', 'unlock.yaml'), 'utf8');
  // Exact resource-id observed in a real Android 35 default-system-image UI dump.
  const androidSystemCredential = 'com.android.systemui:id/lockPassword';
  const selectors = [...unlock.matchAll(/^\s*id:\s*"([^"]+)"/gm)].map(match => match[1]);
  assert.equal(selectors.length, 2, 'both wait and tap must target the Android credential input');
  for (const selector of selectors) {
    assert.match(androidSystemCredential, new RegExp(selector));
  }
  assert.match(unlock, /inputText:\s*"2468"/);
  assert.match(unlock, /pressKey:\s*Enter/);
  assert.match(unlock, /visible:\s*"Сообщение ассистенту"/);
  assert.doesNotMatch(unlock, /skipAuth|bypass|mockAuthentication/i);
});


test('native note smoke navigates past the keyboard before targeting the body', () => {
  const flow = fs.readFileSync(path.join(__dirname, '..', '.maestro', 'flows', 'smoke.yaml'), 'utf8');
  const noteStart = flow.indexOf('# 4. Create/edit a real SQLCipher note');
  const noteEnd = flow.indexOf('# 5. Settings', noteStart);
  assert.ok(noteStart >= 0 && noteEnd > noteStart, 'note flow exists');
  const note = flow.slice(noteStart, noteEnd);
  const title = note.indexOf('inputText: "Native smoke note"');
  const dismiss = note.indexOf('- hideKeyboard', title);
  const scroll = note.indexOf('element: "Что нужно запомнить?"', dismiss);
  const tap = note.indexOf('- tapOn: "Что нужно запомнить?"', scroll);
  const input = note.indexOf('inputText: "Persisted offline content"', tap);
  assert.ok(title >= 0 && dismiss > title && scroll > dismiss && tap > scroll && input > tap,
    'after entering title, dismiss IME, scroll to the visible body placeholder, focus and type');
  assert.ok(note.includes('element: "Persisted offline content"'),
    'editing previously stored text scrolls to the body before editing');
  assert.match(note, /tapOn: "Persisted offline content"/,
    "use visible text when editing an existing note");
});


test('note edit waits for editor, not matching preview in the list (CI #410)', () => {
  const flow = fs.readFileSync(path.join(__dirname, '..', '.maestro', 'flows', 'smoke.yaml'), 'utf8');
  const open = flow.indexOf('- tapOn: "Открыть заметку Native smoke note"');
  const wait = flow.indexOf('visible: "Сохранить запись"', open);
  const body = flow.indexOf('- assertVisible: "Persisted offline content"', open);
  const edit = flow.indexOf('element: "Persisted offline content"', body);
  assert.ok(open >= 0 && wait > open && body > wait && edit > body,
    'editor save control must be visible before checking body or editing');
  assert.match(flow.slice(open, body), /timeout: 15000/,
    'wait for asynchronous navigation rather than checking list preview immediately');
});
