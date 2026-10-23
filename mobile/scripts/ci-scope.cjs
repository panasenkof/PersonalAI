'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
// Only known documentation is cheap. Unknown paths run the full suite.
function needsMobile(files) {
  return files.some(file => !(/^(Plans\/|plans\/|openspec\/|skills\/).*\.md$/.test(file) || /^docs\/.*\.md$/.test(file) || /^(README\.md|PLAN\.md|AGENTS\.md|LICENSE)$/.test(file)));
}
if (require.main === module) {
  let needed = true;
  const base = process.env.BASE_SHA;
  if (/^[a-f0-9]{40}$/.test(base || '') && !/^0+$/.test(base)) {
    try {
      const files = execFileSync('git', ['diff', '--name-only', '-z', base, 'HEAD'], { encoding: 'utf8' }).split('\0').filter(Boolean);
      needed = needsMobile(files);
    } catch { /* missing baseline must never silently skip tests */ }
  }
  const output = `mobile=${needed}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
module.exports = { needsMobile };
