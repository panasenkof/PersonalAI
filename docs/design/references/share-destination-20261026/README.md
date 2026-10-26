# External Share destination — 2026-10-26

Synthetic browser captures of the production navigator and screen with QA adapters, at 320 and 390 CSS px. Approved #127 pattern; no new visual direction. Other verified widths: 360 and 430 px. These captures are not native Android evidence.

Validation: TypeScript passed; Jest 88 suites / 624 tests passed; browser flow passed at 320/360/390/430 px; roadmap integrity passed. Jest reports an existing worker teardown warning. Real-device Share providers, URI grants and TalkBack were not run locally. CI results belong to the PR checks, not these captures.

Covered: mixed URL + text attachment, append to existing draft without sending, unsupported chat type, cancellation preserving draft, memory preview without automatic save. Unit tests additionally cover locking, unmount, failed/late copy cleanup, limits and atomic mutation.
