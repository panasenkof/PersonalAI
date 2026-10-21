---
name: mobile-ui-ux
description: Implement, audit and review PersAI mobile screens and interactions according to the approved Nebula visual contract. Use on every UI/motion/navigation/attachment-preview change.
---

# PersAI mobile-ui-ux skill

This is a **project rule**, not a generic image-generation prompt. Read the following **in this order**:

1. [Approved artwork and anti-simplification contract](../../docs/design/NEBULA_VISUAL_CONTRACT.md).
2. [Exact original assets (ZIP) and SHA-256](../../docs/design/references/README.md).
3. [Nebula coding rules and acceptance](../../docs/UI_GUIDELINES.md).
4. [UX baseline + Android gaps](../../docs/UX_AUDIT_PRELIMINARY_2026-10-21.md).
5. [Feature roadmap](../../PLAN.md), particularly 54–85 and 86–90.
6. [Motion feasibility and device spike](../../docs/design/NEBULA_MOTION_SPIKE.md).

## Implementation routine

- First list the impacted existing features and future entry points.
- Identify whether work is **art asset**, **motion scene**, **component**, **route**, **data/API**, or **test**. Never conflate them.
- Use `mobile/src/design/nebula/tokens.ts` and `components.tsx`. Avoid duplicating visual constants.
- For motion, derive scene from `resolveNebulaScene`; real LLM/mic state owns the phase. Do not start new native renderers without a device probe.
- Preserve chat history, protected local memory, biometrics, user drafts, LLM configurations, voice normalization, backups, native share.
- Validate font growth, keyboard, clipping, contrast and TalkBack; every UI PR needs before/after and actual test results.
- Never substitute a 2D circle, stretched bitmap, fake chat API or decorative placeholder as a final deliverable. **Escalate quality-versus-performance tradeoffs.**

## Mandatory output for each UI PR

Use the [acceptance template](../../docs/UI_GUIDELINES.md#приёмочный-шаблон-для-ui-pr); list PASS / FAIL / NOT RUN. Reviewers must not accept an unchecked row as PASS.

## Scope warning

The initial design-system PR does **not** install a shader engine, claim that the illustration is production ready, or wire new screens into the application. The motion spike is proof-of-concept; all actual renderer choices require an Android release APK test.
