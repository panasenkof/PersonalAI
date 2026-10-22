# Android release CI verification
## RG-01 Event-origin verification
WHEN an authenticated GitHub workflow_run event reports completed, successful CI on push to main for TARGET_SHA from the same repository, THEN the CI verification gate passes without depending on GitHub's runs-list index.

## RG-02 Unsafe trigger rejection
WHEN any SHA, branch, event type, workflow name, repository, CI conclusion, or completion status differs, THEN the gate rejects the release.

## RG-03 Manual verification
WHEN workflow_dispatch is used, THEN a successful completed push CI record on main matching TARGET_SHA is required from GitHub runs API. A PR run or unrelated run is insufficient.

## RG-04 Retain existing release invariants
WHEN CI gate succeeds, THEN head checkout/main SHA verification, cumulative release diff, signature verification, artifact validation and stale-main rejection remain mandatory.
