'use strict';
/** Accept only a successful manual pinned-source build from this repo's main.
 * Caller additionally proves the run's head_sha is an ancestor of its checkout.
 */
const fs = require('node:fs');
const WORKFLOW = '.github/workflows/telegram-tdlib-source.yml';
const WORKFLOW_NAME = 'Build official TDLib JSONJava bundle (manual)';
function validateSourceRun(run, repository, expectedId) {
  if (!run || typeof run !== 'object' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('tdlib_source_run_invalid');
  }
  const valid = Number.isSafeInteger(expectedId) && expectedId > 0 &&
    run.id === expectedId &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository &&
    run.name === WORKFLOW_NAME &&
    run.path === WORKFLOW &&
    run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    typeof run.head_sha === 'string' &&
    /^[a-f0-9]{40}$/.test(run.head_sha);
  if (!valid) throw new Error('tdlib_source_run_untrusted');
  return run.head_sha;
}
if (require.main === module) {
  const [file, repo, id] = process.argv.slice(2);
  if (!file || !repo || !/^[1-9][0-9]{0,14}$/.test(id || '')) {
    throw new Error('tdlib_source_run_arguments');
  }
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.stdout.write(validateSourceRun(metadata, repo, Number(id)) + '\n');
}
module.exports = { validateSourceRun, WORKFLOW, WORKFLOW_NAME };
