# Fix: Nebula smoothness on real Android recording

After validating PR #92, the owner supplied a ~54s screen recording and reported a strange, jittery feel. The recording shows chat layout movement when IME and streaming statuses change; the shader's own GPU jank is NOT proven by a screen recording.

Source of truth: [NEBULA_MOTION_STABILITY_2026-10-22.md](../../../docs/design/NEBULA_MOTION_STABILITY_2026-10-22.md). **Scope:** the chat scrolling/inline status layout and hidden Skia JS metering, not biometric/authentication, memory, chat engine, artistic B+C or semantic phases.
