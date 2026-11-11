'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const mobileRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(mobileRoot, '..');
const script = path.join(__dirname, 'stage-reviewed-run.sh');
const release = fs.readFileSync(path.join(repoRoot, '.github/workflows/android-test-apk.yml'), 'utf8');
const native = fs.readFileSync(path.join(repoRoot, '.github/workflows/mobile-native-sqlcipher.yml'), 'utf8');

function run(envPatch) {
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'panasenkof/PersonalAI',
    GITHUB_REF: 'refs/heads/main',
    GH_TOKEN: 'test-token-only',
    TDLIB_SOURCE_RUN_ID: '12345678',
    GITHUB_ENV: '/dev/null',
    RUNNER_TEMP: '/tmp',
    ...envPatch,
  };
  return cp.spawnSync('bash', [script], {
    cwd: mobileRoot, env, encoding: 'utf8', timeout: 5000,
  });
}

test('shared TDLib source staging has valid bash syntax', () => {
  const result = cp.spawnSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('rejects an untrusted branch before GitHub API or artifact download', () => {
  const result = run({ GITHUB_REF: 'refs/pull/471/merge' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /trusted main/);
});

test('rejects malformed or ambiguous source IDs before any network call', () => {
  for (const id of ['0', '-1', '123;echo', '9'.repeat(16)]) {
    const result = run({ TDLIB_SOURCE_RUN_ID: id });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Invalid TDLib source build run ID/);
  }
});

test('rejects incorrect explicit digest before downloading artifact', () => {
  for (const digest of ['bad', 'A'.repeat(64), '0'.repeat(65)]) {
    const result = run({ TDLIB_ARCHIVE_SHA256: digest });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /digest must be exactly/);
  }
});

test('native acceptance and signed release use one provenance/staging mechanism', () => {
  assert.match(native, /bash scripts\/tdlib\/stage-reviewed-run[.]sh/);
  assert.match(release, /bash scripts\/tdlib\/stage-reviewed-run[.]sh/);
  assert.equal((release.match(/name: Publish permanent GitHub prerelease/g) || []).length, 1);
  assert.equal((release.match(/name: Notify Telegram after the APK was published/g) || []).length, 1);
  assert.match(release, /github[.]event_name == 'workflow_dispatch' && inputs[.]tdlib_source_run_id != ''/);
  assert.match(release, /TDLIB_ARCHIVE_SHA256: \$\{\{ inputs[.]tdlib_archive_sha256 \}\}/);
  assert.match(release, /Unreviewed TDLib present in ordinary APK/);
  assert.match(release, /TDLib JNI Java class stripped from signed APK/);
  assert.match(release, /Telegram TDLib: NOT INCLUDED/);
  assert.match(fs.readFileSync(script,'utf8'), /sha256sum --check --status/);
});
