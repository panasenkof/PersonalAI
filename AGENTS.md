# Instructions for agents working in PersAI

For **mobile UI, UX, navigation, motion, launcher icons, voice controls, previews and attachment pickers**:

1. Read [skills/mobile-ui-ux/SKILL.md](skills/mobile-ui-ux/SKILL.md), [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md), and the **approved** [Nebula visual contract](docs/design/NEBULA_VISUAL_CONTRACT.md) **before modifying mobile UI**.
2. Preserve the owner's REF-ICON-A and REF-ORB-B artwork. Original SHA-256 are in [docs/design/references/README.md](docs/design/references/README.md). **Do not replace them with a simplistic gradient circle, letter or flat logo**, and do not silently substitute a screenshot for interactive UI.
3. Keep current behavior and protected local data intact. `Attach to chat`, `Send to model` and `Save to memory` are separate operations requiring separate functional contracts.
4. UX work is ordered under [PLAN.md](PLAN.md): approved visual → preliminary/full UX audit → design-system foundation → migration of screens → visual/native regression QA. The updated source audit is **not** an Android acceptance test.
5. Report exact tests run and missing APK/Android checks. Do not mark an unrun test passing or assume a green TypeScript build proves pixel quality.
6. Do not modify unrelated application architecture, SQLCipher, LLM transport, microphone permissions or releases in a purely UI-spec PR.

These rules complement, rather than replace, applicable repository instructions. Consult the rest of the repo for build, security and test guidance.

## Delivery checkpoint (22 October 2026)

Read [Plans/UI_DELIVERY.md](Plans/UI_DELIVERY.md) for U0–U5 acceptance and current delivery rules. Preserve roadmap IDs 1–91. A green run applies only to its exact SHA; implementation, published APK and Android acceptance are separate states. Add behavioral regression tests for lifecycle/race fixes, not only source-string checks. Finish one user scenario per PR and update the active status before appending history. Independent Memory/Import/Settings work does not wait for orb battery measurements or Figma quota; native acceptance remains required. Keep approved B+C and avoid unrelated data or security changes.
