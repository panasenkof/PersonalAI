# Instructions for agents working in PersAI

## Mandatory checkpoint for EVERY implementation step (owner decision 26 October 2026)

Read and follow **[docs/DEVELOPMENT_GATES.md](docs/DEVELOPMENT_GATES.md)** for **every** task and PR, not only mobile UI. This is an actionable project rule; Cursor also has an always-applied rule in `.cursor/rules`.

- **Before coding:** refresh actual `main`/PR status; check `PLAN.md` §2, `Plans/ROADMAP_STATUS.md` and **all relevant feature subplans/OpenSpec** for current requirements and contradictions; examine existing code and tests. Check approved references and relevant best practices. For substantial UI or architecture work compare **current verifiable** sources/analogues and adapt them to Android, local-only storage and Nebula; preserve user decisions. Update stale plans before/alongside code. Avoid redundant research for trivial changes; state N/A with a reason.
- **At the end of EACH partial implementation:** review **only the implemented slice and its genuinely affected regressions**, not future features. Run relevant success/error/lock/rollback/backup/UI tests as applicable; mark actual PASS/FAIL/NOT RUN/NOT IMPLEMENTED with exact SHA.
- **Mandatory second final review: PLAN CONFORMANCE.** Compare the **actual diff and verified behavior** against the applicable current-step requirements in `PLAN.md` **and feature subplans/OpenSpec**. Report MATCH / PARTIAL / DEVIATION / NOT IMPLEMENTED (future) / NOT VERIFIED. Fix unjustified departures before declaring completion, or explicitly justify and synchronize PLAN, status register and subplans/specs if an approved change is needed; do not quietly redefine requirements after coding. An unresolved required deviation means PARTIAL/BLOCKED.
- Each PR summary must report plan version/step, subplans, references (or N/A), scope/exclusions, tests and status, affected regressions, **end-of-step conformance matrix**, remaining work and next step. Keep `PLAN.md` the only task order; do not let subplans silently create a second queue.

For **mobile UI, UX, navigation, motion, launcher icons, voice controls, previews and attachment pickers**:

1. Read [skills/mobile-ui-ux/SKILL.md](skills/mobile-ui-ux/SKILL.md), [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md), and the **approved** [Nebula visual contract](docs/design/NEBULA_VISUAL_CONTRACT.md) **before modifying mobile UI**.
2. Preserve the owner's REF-ICON-A and REF-ORB-B artwork. Original SHA-256 are in [docs/design/references/README.md](docs/design/references/README.md). **Do not replace them with a simplistic gradient circle, letter or flat logo**, and do not silently substitute a screenshot for interactive UI.
3. Keep current behavior and protected local data intact. `Attach to chat`, `Send to model` and `Save to memory` are separate operations requiring separate functional contracts.
4. UX work is ordered under [PLAN.md](PLAN.md): approved visual → preliminary/full UX audit → design-system foundation → migration of screens → visual/native regression QA. The updated source audit is **not** an Android acceptance test.
5. Report exact tests run and missing APK/Android checks. Do not mark an unrun test passing or assume a green TypeScript build proves pixel quality.
6. Do not modify unrelated application architecture, SQLCipher, LLM transport, microphone permissions or releases in a purely UI-spec PR.

These rules complement, rather than replace, applicable repository instructions. Consult the rest of the repo for build, security and test guidance.

## Delivery checkpoint (22 October 2026)

Read [Plans/UI_DELIVERY.md](Plans/UI_DELIVERY.md) for U0–U5 acceptance and current delivery rules. Preserve roadmap IDs 1–91. A green run applies only to its exact SHA; implementation, published APK and Android acceptance are separate states. Add behavioral regression tests for lifecycle/race fixes, not only source-string checks. Finish one user scenario per PR and update the active status before appending history. Independent Memory/Import/Settings work does not wait for orb battery measurements or Figma quota; native results must be reported honestly. Per the owner’s 26 October decision, manual U5 sign-off does not block functional development or PR publication; collect device feedback during normal use. Keep approved B+C and avoid unrelated data or security changes.
