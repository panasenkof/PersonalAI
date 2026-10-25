# PersAI UI change quality gates — risk-based, evidence-based

This guide **supplements**, not replaces, [UI_GUIDELINES](../../../docs/UI_GUIDELINES.md), [U5 acceptance](../../../Plans/UI_U5_ACCEPTANCE.md) and the repository's current CI. The required Android emulator job stays **minimal** by owner decision. Additional exploratory testing is targeted, not a new always-on bottleneck.

## 1. Scope by affected behavior

| Change type | Minimum local/CI evidence | Android/manual follow-up |
| --- | --- | --- |
| Docs/wording only, no shipped UI | Markdown/link/path sanity; no fake test PASS | N/A with reason |
| Component layout/colors/copy | Typecheck + relevant component/Jest tests + browser screenshot/layout regression, **if applicable** | Android image/insets/TalkBack only for changed rendering and U5 before acceptance |
| Navigation, forms, lists, selection, streaming | Typecheck + affected Jest state/behavior tests + browser interaction flow; existing **minimal** native smoke for relevant routes | Gesture/3-button Back, keyboard, lifecycle and screen reader on APK when changed behavior is device dependent |
| Input permissions, camera/mic, protected UI, Android Share | Targeted state/race tests + app behavior checks + current required CI | Native release APK on device; verify permission windows, lock/background and actual plugin behavior before claiming fix |
| Orb, scene, adaptive icon or GPU animation | Reference SHA/visual comparison, deterministic scene/unit tests, SDK compatibility and compile check | Actual release APK + native graphics/Reduce Motion/background/thermal/FPS evidence; do not substitute browser canvas |
| Only test harness/CI change | Reproduce the original failure; run affected tests; prove gating doesn't silently skip key behavior | Do not increase required emulator scope without separate approval |

**Project truth:** CI runs prove the exact commit SHA they executed. A different merge/rebase SHA, artifact from an earlier PR, or browser success is not proof that a later APK was accepted.

## 2. Scenario-first test design

For a behavior change, implement at least:
1. **Happy path:** user reaches a real end state, not just the presence of a button.
2. **One failure/cancel path:** denied permission, Back/Cancel, missing capabilities, timeout, empty selection or invalid input — choose the relevant one.
3. **State regression:** if the fix is about jumping UI, race, navigation, or persistence, reproduce the old failure with two interleaved events (e.g., streaming + scrolling, picker + background, permission dialog + lock, edit + Back).
4. **Invariants:** unrelated draft/history/selection/config/permission behavior remains intact. Where there are two entry points, both must share the same state/handler or have an explained distinction.

Prefer deterministic test fixtures/clock and stable `testID` + `accessibilityRole`/`accessibilityState` to localized visible text or absolute tap coordinates. Do not replace a behavioral assertion with a source-string, screenshot-only or mock-only assertion. Avoid fixed sleeps when waiting for a specific observable state is possible.

## 3. UX acceptance checkpoints

- **Navigation:** Back/dismiss consistent from modal → selection → detail; no unexpected tab changes; draft loss requires explicit handling. For list routes retain search/filter/scroll and stable IDs.
- **Chat:** send, stream, cancel/retry, auto-follow only near bottom, manual scroll anchoring, “scroll down” affordance, keyboard/voice switch and tab navigation do not jump content.
- **Memory:** 0/1/many items, no selection trap, single versus bulk actions distinguished, menu stays on-screen at 320dp, selected count accurate, Undo/recovery.
- **Input/import:** keyboard and Save visible, partial errors, permission denial, URL/file types, local save versus external transfer clearly differentiated.
- **Accessibility:** 48dp Android hit targets, 1.0/1.3/1.5 scaling, TalkBack focus/order/labels/states/actions, reduced motion, color contrast and non-color status. No essential action depends exclusively on a gesture.
- **Screen/system:** 320/360/390/430dp + one short viewport, status/nav insets, gesture/three-button, Android 15/16 edge-to-edge/back behavior where relevant. Larger/adaptive widths when the route is expected to run there.
- **Privacy:** no notes or tokens in public screenshots/logs; protected screen data really hides in background, not merely a web mock; new remote transfers require explicit feature authorization.
- **Visual:** screenshot diffs use stable states and approved references. Animated orb frames may vary; test the scene's **state contract** separately instead of brittle pixel-perfect dynamic screenshots.

## 4. Diagnostics when a regression test fails

1. Identify the affected **final SHA**, failing command, route and assertion.
2. Reproduce under the same mocked/native conditions. Gather sanitized screenshot, view hierarchy/semantic tree, keyboard/inset state, logs and event order when possible.
3. Decide whether the **app behavior** is wrong or the test selector/setup is stale. Fix selectors using stable IDs and accessibility semantics; **never weaken assertions solely to get green CI**.
4. Run the smallest affected subset, then the existing required gate. Log any flaky/non-deterministic case and its owner; don't silently mark it PASS.

## 5. Review template (attach to PR summary)

| Field | Required answer |
| --- | --- |
| Goal / before → after | One user-visible scenario; screenshots only if visual |
| Exact changes / out of scope | Screens, components, stores and handlers touched; unaffected invariants |
| Source of truth | Owner decision + current approved feature contract and Nebula restrictions |
| Comparable products / UX benchmark | For substantial redesigns: 2–4 relevant examples, observed behavior, dated links, adopt/adapt/reject; otherwise N/A with a reason |
| Reused vs new | Shared tokens/components, why custom controls were necessary |
| Test evidence | Command, SHA and PASS / FAIL / NOT RUN / N/A with justification |
| Native evidence | Device/emulator, Android version, input method, navigation mode, release APK SHA **or NOT RUN** |
| UX follow-up | P0/P1 blockers, specific P2 backlog, owner acceptance state |

Never equate `NOT RUN` with `PASS`. Tests are allowed to be N/A where their feature was not touched. A real Android defect remains open until validated on a matching build; do not repeatedly block unrelated functionality on an old historical spike.

Useful test references: [React Native Accessibility](https://reactnative.dev/docs/accessibility), [Android touch-target accessibility](https://developer.android.com/guide/topics/ui/accessibility/apps), [Android screenshot test principles](https://developer.android.com/training/testing/ui-tests/screenshot). Android's Compose test implementation APIs are **not** instructions to migrate PersAI away from React Native.
