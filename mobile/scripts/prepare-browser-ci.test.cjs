const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
for (const [name, error, code, fallback] of [
  ['ready host skips apt', '', 0, false],
  ['missing shared libraries install dependencies', 'error while loading shared libraries: libnss3.so', 0, true],
  ['unrelated launch errors fail without an apt retry', 'browser process crashed', 1, false],
]) test(name, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persai-browser-'));
  const log = path.join(dir, 'commands');
  try {
    fs.writeFileSync(path.join(dir, 'npx'), '#!/bin/sh\necho "$*" >> "$COMMAND_LOG"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\nif [ -n "$PROBE_ERROR" ]; then echo "$PROBE_ERROR" >&2; exit 1; fi\n', { mode: 0o755 });
    const result = spawnSync('bash', [path.join(__dirname, 'prepare-browser-ci.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: dir + ':' + process.env.PATH, COMMAND_LOG: log, PROBE_ERROR: error },
    });
    assert.equal(result.status, code, result.stderr);
    const commands = fs.readFileSync(log, 'utf8');
    assert.match(commands, /playwright install --only-shell chromium/);
    assert.equal(commands.includes('install-deps'), fallback);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
