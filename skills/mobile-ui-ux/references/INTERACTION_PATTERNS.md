# PersAI interaction patterns — decisions before pixels

**Status:** UX defaults for new/reworked scenarios; latest explicit owner decision and approved feature-specific contracts take precedence. Not permission to retrofit existing screens without a scoped task. Applies to React Native / Expo Android, not native Compose implementation.

## Universal interaction decision table

| Situation | Preferred user-visible behavior | Avoid |
| --- | --- | --- |
| Simple item open | Tap opens details; Back returns to the same list/filter/scroll | Tap doing destructive action or resetting list |
| Item-specific actions | Clearly discoverable overflow; optional touch-and-hold context menu anchored to item | Long press as the **only** way to reach actions |
| Multiple items | Explicit “Выбрать” action, selected count, visible Cancel/Back; allow toggle/deselect | Uncancelable mode, invisible selection, mandatory “Select all” |
| Destructive operations | Precise label, confirmation for irreversible action; Undo for reversible delete/move | Silent data loss, generic “OK” |
| Busy action | Disable duplicate submissions for **that operation**, keep Cancel if safe, show real status | Blocking all app navigation or fictitious percentage |
| Bottom sheet/dialog | Accessible title/focus, clear dismiss/back, content scroll and safe-area clearance | Covered Save button, trapped focus, modal behind keyboard |
| Settings and forms | One canonical value, show active value, consistent save model, explicit unsaved-change handling | Double Save, stale values after switching tabs |
| Import/attachment | Preview → choose destination/processing → explicit Send/Save and clear outcome | Upload on preview, conflating model transfer and local save |

## 1. Memory and collections

- **Two different jobs:** opening one note versus manipulating several notes. Keep their entry points distinct.
- **Recommended target for item actions:** tap opens note; visible `⋮` (accessible “Действия с заметкой”) or long press opens **single-item** context actions (edit, move, add attachment when implemented, trash). Include “Выбрать” as an entry to batch selection. If an approved in-flight feature contract still maps long press directly to selection, first reconcile that contract before changing code; do not implement both incompatible actions at once.
- In **batch selection**, tap toggles items, count is visible, and a prominent Cancel/Back always exits. At 0 selected, bulk actions are disabled or mode exits according to the current approved contract. Destructive multi-item actions say how many notes they affect and show the result. Avoid adding “Выбрать всё”: owner requested removal, and it adds risk for limited benefit.
- A cancelled contextual menu must not lose selections. Define exit on successful action; do not accidentally keep a stale selection when navigating away. Use stable note IDs as keys, not indices. Preserve filtered view and scroll when returning.
- Merging notes demands clear order and preview, visibility of source/target, explicit confirmation, and defined treatment of attachments and private sections. This is **data functionality**, not just menu styling; request/verify its actual contract.
- Accessibility: expose `selected` state and meaningful actions to TalkBack, not merely checkbox color. A gesture-only long press is insufficient.

## 2. Chat and active agent work

- Default chat behavior is familiar to ChatGPT/Claude-style apps: messages scroll within their own viewport, composer stays attached to the safe-area/keyboard, and header/orb do **not** change height when status changes.
- New outgoing message is immediately visible and stays in history, including if the request fails. Incoming streamed content appends without resetting list or teleporting reader to center.
- **Autoscroll only when near the bottom** (threshold configurable and covered by tests). If user reads earlier messages, preserve anchor and show a “Вниз / Новые сообщения” action. Manual scroll wins over background token updates.
- Status labels (“Слушаю”, “Распознаю”, “Думаю”, “Отвечаю”, “Ошибка”) map to **real** operation state; no `1/5` unless five genuine measurable stages are known. Timeouts, cancellation, retries and off-line handling belong to the same state machine.
- Keyboard opening, Android back, tab switch, text-size change, voice session start/end and streaming must not move history unexpectedly, restart requests, discard the composer draft or cause double submission.
- Keep Save to memory, attach to message and send to LLM distinct, and show whether the selected model/provider supports a media type **before** promising successful processing.

## 3. Capture, import and Android Share

- One primary path: choose capture/source → preview/metadata → destination and access → explicit save. Advanced OCR/transcription/processing controls are collapsible, not mandatory clutter.
- Preserve input and draft if picker/permissions are cancelled, the keyboard appears or user backgrounds the app. Never upload files merely because a preview was opened; show transfer/processing stages and partial failures.
- An incoming Share intent should be explicit about whether it creates a new note, appends to an existing one, or opens chat. Show source and destination; “Входящие” is a safe default when no collection/tag is selected.
- Differentiate permission denied, unsupported MIME, HTTP error, model not capable, disk/storage error and network timeout. No generic “memory error” for every media failure.
- For microphone and camera, request permissions in context and only for an actual user action; avoid permission/lock transition flicker while still guarding real background data.

## 4. Settings, navigation and errors

- One source of truth for every LLM account/token/model/voice/search option; quick entry points may link to the canonical editor, never implement competing persistence.
- Group infrequently changed settings by goal. Put frequent **contextual** controls near their feature if helpful; do not add top-level categories or duplicate forms for convenience.
- Save must have one clear interpretation per flow: immediate apply, or explicit Save (with unsaved-change prompt). On success, reflect the persisted value and navigation outcome; on failure keep inputs and explain recovery. No misleading success banner.
- Back priority: close picker/dialog/sheet → exit selection/edit safely → pop detail → current tab/root. Predictive back/edge-to-edge implementation must use supported React Navigation/Expo APIs for the installed versions; do **not** paste native Compose snippets into React Native.
- An empty, offline, denied or error screen should explain what happened and offer the **next viable action**. Avoid generic dead ends and unrelated personal-memory suggestions.

## 5. Baseline inclusion and motion

- Check touch targets ≥48dp, font sizes 1.0/1.3/1.5, 320/360/390/430dp, real keyboard/insets, TalkBack focus and role/state, readable Russian copy, contrast and non-color status.
- Respect Reduce Motion, avoid auto-running star-flight during reading, and pause graphics in background. The approved Nebula visual contract is retained; these constraints apply **around** the orb, not as a mandate to simplify it.
- Prefer semantic accessibility/test IDs, deterministic list keys and explicit state transitions. No screenshots/logs with user's notes or secrets in public PRs.

## References used as guidelines, not a competing design system

- Android UI patterns: [Menus and contextual action mode](https://developer.android.com/develop/ui/views/components/menus), [Android settings](https://developer.android.com/design/ui/mobile/guides/patterns/settings), [layouts/navigation](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-and-nav-patterns).
- Android platform: [Accessibility principles](https://developer.android.com/guide/topics/ui/accessibility/principles), [Android 16 system UI/back/edge-to-edge](https://developer.android.com/about/versions/16/behavior-changes-16), [adaptive layout](https://developer.android.com/develop/adaptive-apps/guides/use-window-size-classes).
- React Native: [Accessibility](https://reactnative.dev/docs/accessibility), [KeyboardAvoidingView](https://reactnative.dev/docs/keyboardavoidingview).
- Cross-platform heuristics: [Nielsen Norman Group: 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/), [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/), [WCAG2Mobile](https://www.w3.org/TR/wcag2mobile-22/).

**Note:** Android platform guidance establishes expected *behavior*; code implementation must fit the repository's current React Native/Expo/navigation versions.
