# Fix: Android release CI gate false negative
## Why
PR #93 was merged, CI for the exact main SHA succeeded, but release run #258 rejected it as missing. This prevents delivery of the Nebula stability fix.

## Scope
Replace brittle re-query + `gh api --jq env.TARGET_SHA` check with authenticated triggering-event verification for automated main release and explicit exact-SHA successful main CI verification for manual dispatch. Preserve all signing/main/ancestry safety gates.

See [normative specification](../../../docs/design/ANDROID_RELEASE_CI_GATE_2026_10_22.md).
