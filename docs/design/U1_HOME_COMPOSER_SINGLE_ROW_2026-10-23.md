# U1 — compact Home composer, one row (23.10.2026)

This is the first independently deliverable U1 shell/Home slice after chat stability PR #101; U0 is still pending physical Android acceptance. It changes presentation only: transport, draft storage, navigation and voice-engine lifecycles remain unchanged.

## Requirement
- The input remains a single multiline field with the existing Clear/refocus behavior.
- Under it, five actions (File, Camera, Microphone, Improve/Restore original, Send/Stop) stay on **one row** at 320/360/390/430dp. No labels under icons, but accessible names, descriptive hints on tap/hold and 48dp touch targets remain.
- Screen reader identifies all five independently. A running dictation/normalization/LLM request retains its actual status in the existing header. A voice error offering network fallback must remain actionable.
- Same history viewport/anchor, Gboard avoidance, memory vs chat import distinction and Nebula B+C.
- No promises that File/Camera currently attach to an LLM chat: these actions still open Memory Import as before.

## Acceptance
Jest interaction test on compact IconAction: tap, visible hint, dimensions and accessible name. Browser production-screen test at 320/390/768 asserts every action within viewport and same row, plus retained Clear, mic and normalization behavior. Android CI required must pass; real 320–430dp, font 1.5, Gboard and TalkBack are NOT RUN until control APK. Any unexpected wrapping or clipped action is a blocker. Do not declare U1 or U0 complete based on this PR alone.
