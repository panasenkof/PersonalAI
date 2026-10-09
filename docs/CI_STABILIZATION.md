# Required CI and regression-test policy

The full CI workflow runs five independent tracks: SQLite backend tests,
PostgreSQL/pgvector/Redis backend tests, Windows compatibility, web/mobile,
and Docker production/backup smoke. The `CI required` aggregation job succeeds
**only if all five tracks succeed**. It uses `always()` so that skipped or
failed prerequisite jobs cannot silently mark a PR as healthy.

## Required administrator setting

A workflow file does not itself make a check mandatory for merging. A GitHub
repository administrator must configure the protection rule for `main`:

1. Open **Settings → Rules → Rulesets** (or **Settings → Branches** if using
   legacy branch protection).
2. Add a rule targeting the default branch `main` and enable **Require a
   pull request before merging**.
3. Enable **Require status checks to pass before merging** and select
   **CI required** from the `CI` workflow; enable the rule requiring an
   up-to-date branch before merging when suitable.
4. Disable or restrict rule bypasses, including administrator bypasses, if
   merges must be blocked even for maintainers. Optionally prevent branch
   deletions and force-pushes.
5. Verify enforcement using a deliberately failing PR in a throwaway branch:
   GitHub should refuse a merge while `CI required` is red or missing.

Without this GitHub-side repository rule, the aggregate check is visible but
**does not block merges**. The GitHub connection used for code changes does
not grant repository-administration access.

## Test invariants

- The agent event regression exercises *both* no cloud-memory consent (tool
  schema absent and runtime execution denied) and explicit user consent
  (tool schema present and tool executes successfully).
- It must never disable permission checks in order to pass.
- The full test suite is run in both SQLite and PostgreSQL CI jobs.
- The `concurrency.cancel-in-progress` setting intentionally cancels older
  checks when new pushes to the same PR arrive. `cancelled` is not `failed`.
  In particular, the **latest commit** must have a completed green
  `CI required` check before merging.
- `Live evals` is separate from the required CI: success can mean the workflow
  skipped genuine third-party LLM calls when credentials are unavailable.
