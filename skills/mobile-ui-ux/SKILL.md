---
name: mobile-ui-ux
description: Plan, implement and review PersAI Android/React Native UI, UX, navigation, chat, memory, import, settings, accessibility and motion. Trigger for any screen, component, gesture, keyboard, sheet, or visual regression change.
---

# PersAI mobile-ui-ux — working skill (2026-10-25)

The skill is a **product/engineering contract**, not an image prompt, a blanket redesign request or a license to change security/data architecture. Target stack: **React Native / Expo, Android-first**. Android/Material guidance informs interaction patterns; Jetpack Compose examples are **not** drop-in implementation code.

## 1. Decisions and references: read only what the change needs

Priority in a conflict: latest **explicit owner decision** → approved [Nebula visual contract](../../docs/design/NEBULA_VISUAL_CONTRACT.md) → feature-specific approved contract → [UI guidelines](../../docs/UI_GUIDELINES.md) → this skill/pattern defaults → library convenience. **Accessibility, data safety and OS operability must not be sacrificed for artwork**; document a conflict and seek an explicit product decision rather than silently overriding either.

- **Every UI change:** [AGENTS.md](../../AGENTS.md), [UI guidelines](../../docs/UI_GUIDELINES.md), active queue/U5 from [PLAN.md](../../PLAN.md#2-что-делаем-дальше--единственная-рабочая-очередь) and [UI delivery](../../Plans/UI_DELIVERY.md), plus its **current** feature specification. Do not use historical checkpoint sections as current work orders.
- **Screen behavior or flow change:** [interaction patterns](references/INTERACTION_PATTERNS.md) and, when applicable, [U5 acceptance](../../Plans/UI_U5_ACCEPTANCE.md). Read the relevant screen's code and test before proposing new components.
- **Artwork, icon or orb change only:** [original assets/sha](../../docs/design/references/README.md), [Nebula contract](../../docs/design/NEBULA_VISUAL_CONTRACT.md), and [motion feasibility](../../docs/design/NEBULA_MOTION_SPIKE.md). Preserve approved REF-ICON-A / REF-ORB-B and B+C; a flat circle/stretched bitmap is not a final replacement.
- **Every UI PR:** use [risk-based quality gates](references/QUALITY_GATES.md) and the [existing acceptance template](../../docs/UI_GUIDELINES.md#приёмочный-шаблон-для-ui-pr). Clearly distinguish PASS, FAIL, NOT RUN, and NOT APPLICABLE.

Do **not** re-run orb asset verification, GPU profiling or Figma comparison on a text-only/behavior-only change that cannot affect them; say N/A and why. Conversely, do not waive these checks for an actual artwork/motion edit.

## 2. Mandatory benchmark before a substantial redesign

**Before redesigning a screen, navigation flow, collection, chat interaction, complex form or major component**, compare solutions to the **same user task** in current, widely used applications. Do this **before** choosing a new layout or gesture—not after implementation as a style justification. Follow [Android navigation conventions](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns), [Nielsen Norman Group's competitive usability evaluation method](https://www.nngroup.com/articles/competitive-usability-evaluations/) and the [Apple HIG design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles/) for cross-platform inspiration. Android conventions take priority when iOS and Android differ.

**Research scope (proportionate to impact):**
1. Name the specific task and failure in PersAI (e.g., multi-select notes, streaming chat, importing media, choosing a model), not an abstract objective like "make it modern".
2. Compare **2–4 relevant products** performing that task, ideally including both direct competitors and a mature adjacent product. Examples by **category only**: chat assistants (ChatGPT, Claude, Gemini); collections/notes (Google Keep, Obsidian, Notion); capture/share/settings (Android first-party apps and Material conventions). Selection depends on the flow; these are *not* mandatory brands or approval of their current UI.
3. Use **current, verifiable evidence**: official design guidance, actual app/tested build, authoritative help material or dated screenshots/videos. Note source URLs and observation dates. Explicitly distinguish firsthand observation from documentation and assumptions. If browsing/screenshots are unavailable, report the evidence gap and rely on accessible Android patterns—not invented competitor behavior.
4. Record a **brief decision matrix**, focused on user behavior rather than appearance: entry/discovery, primary/secondary actions, selection and cancellation, Back, keyboard/scroll, loading/errors, accessibility, strengths/weaknesses and suitability for PersAI.
5. Make a deliberate choice: **adopt / adapt / reject**, explaining which familiar patterns will be reused, which bad patterns will not be copied, and how Nebula B+C, privacy, offline/local memory and the actual React Native stack are preserved. The most popular app is not automatically correct; accessibility and usability trump novelty.
6. Include the resulting 3–6-line **benchmark summary with links** in the UX proposal or PR before/after notes. Link to a separate short comparison document only when the redesign is large or spans multiple screens.

**Exceptions:** a copy fix, isolated bug, accessibility correction mandated by the platform, minor spacing change or implementation of an already **approved exact pattern** does not require fresh competitor research. Mark `Benchmark: N/A (reason)` rather than creating research overhead. Reuse an existing still-relevant documented comparison instead of repeating it in every follow-up PR. No brand imitation, unlicensed asset copying, exposure of private screenshots or unapproved redesign.

## 3. Workflow: user journey before component

1. **Study relevant precedents for a substantial redesign** (section 2), then write the scenario: who, entry point, user intent, primary action, success, error, cancel/back, recovery, and where the user returns. List existing and future entry points. Identify the canonical owner of each setting/action and duplicates.
2. **Map state transitions:** idle, busy, permission, empty, partial result, error, cancel, retry, background/foreground and process/navigation return as applicable. Name the **single source of truth**, including LLM/voice/lock/selection ownership. Check asynchronous races and stale callbacks.
3. **Choose established interaction first:** Android conventions, progressive disclosure, visible affordance and reversible actions. Prefer one obvious primary action; secondary actions in contextual overflow. A long-press/swipe shortcut always needs a discoverable tap/TalkBack alternative. No gratuitous new tabs or forms.
4. **Fit the approved visual language:** reuse `mobile/src/design/nebula/tokens.ts`, shared components and native surfaces; keep the B+C orb and scene independently controlled by actual operation state (`resolveNebulaScene`). Do not duplicate spacing, colors, component state machines or handlers to finish one screen.
5. **Implement a complete thin vertical slice:** UI + actual handler + persistence/error/undo behavior + focused tests. Never present a visual-only placeholder as working file upload, memory save, model invocation or transcription.
6. **Review the journey end to end:** compare before/after, assess accessibility, then run scope-appropriate automated and Android checks. Log missing evidence and remaining risks without reopening an entire finished design phase.

A PR should finish **one coherent user scenario**, not scatter one flow across many decorative PRs; equally, avoid unrelated architectural refactors inside UX work.

## 4. Non-negotiable interaction invariants

- **User control and recognition:** every selection mode, edit flow, sheet and long-running operation has an obvious exit/back path; Back is predictable (dismiss transient UI → leave selection/detail → navigate back) and never silently discards a draft. Destructive actions are clearly named; use confirmation when recovery is impossible and Undo when feasible.
- **Stability:** keyboard/system bars, streaming tokens, inline status, bottom navigation and orb must not move the reader's anchor unexpectedly. Preserve chat scroll position if the user scrolled up; show a return-to-latest affordance. Preserve search/filter/selection/draft across safe navigation and lifecycle changes.
- **Honest feedback:** statuses reflect actual microphone/LLM/tool state. Do not invent progress fractions, fake uploads or success toasts. Offer understandable errors, next steps and retry; distinguish loading, no data, no permission, offline and unsupported.
- **Accessibility:** minimum **48×48 dp touch target** on Android (visual glyph may be smaller); meaningful React Native `accessibilityRole`, `accessibilityLabel`, `accessibilityState`/actions; sensible focus/announcement on sheets, selections and errors. Test TalkBack, dynamic font (1.0×/1.3×/1.5×), contrast, non-color cues and reduced motion.
- **Insets/adaptive:** validate 320/360/390/430 dp and constrained height, Gboard, gesture/3-button navigation, edge-to-edge, landscape/resizing where the changed screen is affected. Use actual window/insets behavior, not magic fixed keyboard offsets.
- **Privacy and consent:** `Attach to chat`, `Send to model` and `Save to memory` are distinct operations. Files are not uploaded by preview; avoid collecting/recording secrets in debug evidence. Preserve protected local memory, biometrics, permission behavior, SQLCipher, user drafts and stored model connections.
- **Motion is subordinate to work:** real state drives phases; respect Reduce Motion, low-power and background pause. No orbit/background animation may obscure text, steal touch or trigger relayout; measure native performance only when changing related behavior.
- **Platform-native interaction:** prefer familiar list, menu, contextual selection, form, picker and back behavior over novel gestures. Use brand expression in surfaces/artwork, not by changing what Back, Save, Cancel or selection means.

## 5. Quality and delivery

- Follow [QUALITY_GATES](references/QUALITY_GATES.md): at least a changed-path positive scenario and a failure/cancellation/regression scenario when behavior changes, with deterministic state and test IDs/semantic labels instead of brittle text/coordinates alone.
- Keep required emulator CI **minimal** as agreed for PersAI; focus Jest/browser/native smoke on the touched path. More exhaustive, device-dependent tests belong in U5/native acceptance, not an unrelated required gate. Do not mistake browser screenshots, green TypeScript, or emulator smoke for release APK/TalkBack acceptance.
- Every report: changed scenario and files, what was **kept unchanged**, before/after evidence if visually affected, exact commands/tests and commit SHA, PASS/FAIL/NOT RUN/N/A, Android gaps, P0/P1 blockers and deferred P2. Do not claim a release or owner acceptance without a matching APK and confirmation.

**Out of scope unless separately authorized:** replacing Nebula branding, forcing a new renderer, broad navigation redesign, changing AppLock/SQLCipher/LLM transport/microphone security, adding new remote data transfers or modifying release pipelines as a side effect of a UI task.
