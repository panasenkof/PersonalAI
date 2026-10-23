const { test } = require('node:test');
const assert = require('node:assert/strict');
const { needsMobile } = require('./ci-scope.cjs');
test('docs-only skips expensive build; mixed, artwork and unknown paths do not', () => {
  assert.equal(needsMobile(['PLAN.md', 'Plans/PERFORMANCE.md', 'docs/QA.md']), false);
  for (const file of ['mobile/src/screens/HomeScreen.tsx', 'mobile/.maestro/flows/smoke.yaml', '.github/workflows/ci.yml', 'docs/design/references/original.zip', 'new-build-config']) {
    assert.equal(needsMobile(['PLAN.md', file]), true, file);
  }
});
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('missing baseline runs all jobs; real docs-only and mixed diffs produce exact outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persai-scope-'));
  const git = (...args) => cp.execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const commit = (name, content) => {
    fs.writeFileSync(path.join(dir, name), content); git('add', '.'); git('commit', '-qm', name); return git('rev-parse', 'HEAD');
  };
  const run = base => cp.execFileSync(process.execPath, [path.join(__dirname, 'ci-scope.cjs')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, BASE_SHA: base, GITHUB_OUTPUT: '' }, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    const base = commit('README.md', 'base');
    commit('PLAN.md', 'docs'); assert.equal(run(base), 'mobile=false');
    commit('unknown.config', 'runtime'); assert.equal(run(base), 'mobile=true');
    assert.equal(run(''), 'mobile=true'); assert.equal(run('0'.repeat(40)), 'mobile=true');
    assert.equal(run('a'.repeat(40)), 'mobile=true');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
