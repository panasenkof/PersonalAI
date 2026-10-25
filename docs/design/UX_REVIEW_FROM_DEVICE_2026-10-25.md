# PersAI — UX review with Apple → Android benchmark (25.10.2026)

**Status:** read-only design/UX review, not Android release acceptance and not a request to restart Nebula redesign. **Evidence:** user-uploaded videos `1000039024.mp4`, `1000038986.mp4`, `1000038920.mp4`, earlier chat video `1000038817.mp4`, and screenshot `1000039025.jpg`; reviewed against `main` source on 25 Oct 2026. Videos/screenshots contain private notes: **do not commit or publish screenshots, raw video, identifiable titles or their content.** Observations below deliberately redact personal content. Several gallery JPGs from 24 October belong to the **projector project**, not PersAI, and were excluded.

**Repository state checked:** #121 (selection/import/mic) **merged**; #122 (mobile-ui-ux skill and Apple benchmark) **merged**. The current plan/U5 text may still say #121 is open; that is stale metadata, not evidence of a native APK. Physical phone acceptance of the merged SHA remains **NOT RUN** here. Legacy videos describe *the filmed APK*, not necessarily the already-merged implementation.

**Constraints:** preserve approved REF-ICON-A/REF-ORB-B, Nebula B+C, 3 tabs, SQLCipher, AppLock, user's current notes, LLM and voice flows, roadmap IDs 1–91. Do not create another whole-app redesign or expand required Maestro. This review prioritizes UX fixes and U5.

## 1. Benchmark: similar tasks, not copied visuals

| Verified reference / task | Observe | Adapt to PersAI Android | Reject / do not assume |
| --- | --- | --- | --- |
| [Apple Notes on iPhone](https://support.apple.com/en-gb/118442): folders, selecting/moving notes | Folders have their own navigation; selection is an explicit More → Select Notes command; moving is contextual to selection | Clear collections hierarchy, explicit Select, predictable Back and contextual note operations | Blind copy of iOS toolbar, navigation swipe, SF Symbols |
| [Google Keep for Android](https://support.google.com/keep/answer/6191044?co=GENIE.Platform%3DAndroid&hl=en): multi-selection | Google documents long-press → selection, then tap more notes; strong Android mental model | Preserve explicit multi-selection, check states, selected-count and Android Back | Claim that long-press context menu is *the only* standard: both it and long-press selection have precedents |
| [Apple HIG menus](https://developer.apple.com/design/human-interface-guidelines/menus), [sheets](https://developer.apple.com/design/human-interface-guidelines/sheets) | Actions are concise, related, ordered by frequency; sheet is brief, **not navigation** | Separate note actions from library navigation, avoid nested modal stacks | Giant “everything” bottom sheet |
| [ChatGPT mobile official FAQ](https://help.openai.com/en/articles/8142208-chatgpt-ios-and-android-app-faq): chat/history | History/search is dedicated, message actions are contextual and conversation deletion asks confirmation | Keep existing 3-tab shell and conversation-history entry, expose message actions deliberately | Copy ChatGPT's brand, cloud/sync semantics or redesign header unnecessarily |
| [Apple HIG layout](https://developer.apple.com/design/human-interface-guidelines/layout) + [Android layout](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns) | Primary hierarchy and familiar adaptive navigation take precedence over decoration; primary tasks easy to scan | Use Nebula tokens, Android insets/keyboard/back/TalkBack, restrained content density | iOS-native controls/gestures or changing platform stack |

**Decision:** *adopt* clear single-job navigation and concise actions; *adapt* Apple typography/spacing/hierarchy to Android + Nebula; *reject* iOS-only gesture/asset copying. Both Keep and Apple Notes show valid selection entry points. Given the owner's earlier request, a single-note long-press menu is a **proposed decision**, requiring current feature-contract reconciliation; explicit selection must stay discoverable.

## 2. Steps observed and status

| Step / evidence | What is visible | Health / evidence limit |
| --- | --- | --- |
| 1. Home idle, message composer (`8986`, `8817`, `9024`) | High-fidelity orb and coherent Nebula theme. In earlier build, a long conversation/keyboard affected message anchoring. | **Art: preserve.** Follow policy exists in current `useChatBottomFollow`; **current APK behavior unverified**. |
| 2. Memory overview (`9024` ~5–9 s, `9025`) | Search, horizontal collection cards and note grid, then list actions. Collection covers can show an unrelated note photo. | **P2 hierarchy/density**; current code selects the first recent photo note as a collection cover. |
| 3. Single-item action and multi-select (`9024` ~11–19 s, `8986` ~25 s) | Selection toolbar appears while collection header remains under it; actions require another tap. Historic build exposed confusing selection controls. | **P1 interaction consistency**. #121 fixed obvious Cancel and pinned action entry; still review structure on Android. |
| 4. “В корзину?” confirmation (`9024` ~14 s) | Confirmation and action sheet are visible simultaneously. | **P1 reproduced on footage and supported by source**: `Alert.alert(...)` is called from an active `BottomSheet` without first closing it. |
| 5. Memory overflow (`9025`) | Tall `Память` sheet includes add, collections, All/Archive/Trash and backups. Same Add action exists as large +. | **P1 navigational clutter / duplication**, present in current `LocalMemoryScreen.tsx`. |
| 6. Import (`8986` ~32–68 s, `8920` ~30 s) | Former flow exposes technical OCR/provider details, long scroll and keyboard overlaps; source select and save aren't primary enough. | **Historically P1; #121 collapses options and pins Save**. Re-validate on new release APK before creating another redesign issue. |
| 7. Chat/voice/memory retrieval (`8986` ~70–110 s, `8817`) | Older conversations had long, irrelevant memory result and jumping scroll under keyboard/streaming. | **Historically P1**; #121 restricted trivial greeting prefetch, chat anchoring code was changed. Real-device U5 regression still required. |
| 8. Settings | No newer complete user-supplied settings walkthrough in this review. | **Code-only P2**: long model-connection editor; verify keyboard/save/connection switching on real APK, do not assert a visual defect from missing frames. |

## 3. Confirmed current code / recommended changes

### P1-A — single-note actions versus bulk selection

`LocalMemoryScreen` currently uses one `MemoryNoteCard` long-press callback `onToggleSelection`, and keeps a pinned selection toolbar **in addition to** list header. User's approved direction is **no Select all**; keep it absent. Proposed architecture:

- Normal tap → open note; long-press → **small contextual actions for this note** (Open, Edit, Move, Trash and Select), with **visible ⋮/screen-reader alternative**. Do not add one overflow button to each cell if the grid becomes overloaded: test anchoring/affordance before choosing visible UI.
- Explicit **“Выбрать”** command enters bulk mode; tap toggles; a **single** action bar replaces the header rather than creating a second competing header. Show count, Cancel/Android Back, 1–2 frequent operations and one overflow.
- Keep selection and scroll stable on menu cancel, and do not show disabled or irrelevant destructive actions for 0 selected. Press Back from modal → selection mode → list. Avoid accidental collection filter changes during selection.
- **Trade-off:** Google Keep uses long-press to initiate selection. Switching PersAI to long-press context is a deliberate owner preference, not a universal Android rule. Keep explicit access to bulk mode and accessible equivalent.

### P1-B — never stack independent native confirmation and sheet

In `LocalMemoryScreen` actions sheet, Trash opens `Alert.alert` while `actionsOpen` stays true. Use **one overlay coordinator**: close active sheet, let native modal unmount, then present confirm; preserve selected IDs until confirmed. Cancel restores the correct selection state. Verify background/AppLock during both transitions and no blank/ghost overlay. Do not solve with arbitrary sleeps or weaken privacy screen.

### P1-C — replace giant library menu with task-shaped navigation

- **Library canvas:** Search, clear *Collections* entry (dedicated screen/list when expanded), Recent/All/Archive/Trash as an understandable library filter/navigation destination; avoid duplicating Add under main +.
- **Contextual menus:** actions on a note only; filters should not be mixed with operations on note data.
- **Backup:** keep canonical entry in Settings → Data (already exists); optional contextual link from memory if needed, not inside a giant modal.
- Prefer a short action sheet only for selecting **one temporary task**, per Apple HIG; use Android Back, not iOS swipe behavior.

### P2-A — collection and note cards

- Current `covers` derives from recent photo notes; show an **explicitly assigned collection cover** or consistent generic folder imagery, not whichever recent note happened to contain a photo. Preserve note images within note cards.
- Test a true one-column list as default for mostly text/audio notes and optional 2-column grid for photos; do not permanently force a change without real-device comparison. Constrain previews by readable lines but make details easily reachable.
- Avoid multiple identical metadata fields on small cards, dark-on-dark secondary text or meaningless clipped machine-generated filenames. Current title-normalization improvements remain.

### P2-B — chat and composer

- Keep B+C orb and compact header status. Preserve fixed header height and transparent/matched orb background.
- Maintain one scroll authority (already implemented), test incoming stream, manual upward scroll, keyboard open/close, fast tab switch, voice starts/stops, Stop, and jumping to latest. No artificial `1/5` status unless backed by real progress counters.
- Review the 4–5 compact composer actions with 320dp and TalkBack: primary send/mic always clear; less-used normalization/import actions may be in a discoverable menu **only if** this does not hide an owner's high-priority operation.
- Dialog history search is functional; don't recreate the ChatGPT sidebar at the cost of PersAI's 3-tab navigation.

### P2-C — import/settings and accessibility

- Retain #121 import's compact source → preview → short caption → collection/access → save, with advanced recognition *progressively disclosed*. Show clear external-model transfer consent and genuine error states; real APK to validate keyboard/Save.
- Settings: distinct groups and one canonical persistence owner; verify API connectors, model/provider, speech, budgets and backups under keyboard/Back, plus TalkBack labels. Avoid another Settings rearchitecture without native evidence.
- Test Dynamic Type ×1.0/1.3/1.5, 320/360/390/430dp, short screens, Gboard, Android gesture/3-button, color contrast, semantic focus order, reduced motion and actual scoped APK. Do not enlarge required Maestro CI; use focused Jest/browser and existing minimal native gate.

## 4. Suggested safe implementation order

1. **P1-B first:** eliminate overlapping native Alert + BottomSheet, add deterministic tests for modal order, Cancel and protected-background behavior.
2. **P1-A:** explicitly reconcile long-press contextual vs select-first contract; use one selection toolbar and clear actions; regression test 0/1/2 note, Cancel/Back/Trash/Undo. Do not add Select all.
3. **P1-C:** streamline memory navigation; no duplicated Add, backup links to Settings; test All/Archive/Trash/Collections preserving search/drafts/back.
4. **U5 on merged APK:** confirm already-fixed import and chat/keyboard/voice vs old footage, not via new speculative rework. P1 unresolved gets focused follow-up, performance remains later P3.
5. **P2:** note-card cover/title/list vs grid, composer affordances and settings follow after P1, measured on actual screens.

## 5. Evidence and completion conditions

For each scoped UX PR record: affected user task, before/after screen (sanitized or synthetic), competing pattern source/date, adopt/adapt/reject, actual source SHA, Jest/browser PASS/FAIL, native release APK/keyboard/TalkBack PASS/FAIL/NOT RUN, and explicit user approval only where required. **No personal video frames in public GitHub**.

**No confirmed P0 from available frames; P1 items are prioritized, not a claim that every frame reproduces on current APK.** U5 remains OPEN until a signed APK for the merged SHA and phone acceptance. No automatic extension of the entire design phase.
