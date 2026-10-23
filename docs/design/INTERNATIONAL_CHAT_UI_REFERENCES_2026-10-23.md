# International chat UI benchmark — PersAI Nebula (23 Oct 2026)

## Scope and evidence
The user's Android recording shows (a) conversation drifting out of the visible area after Send, (b) animated Nebula no longer visible in a populated chat except during requests, (c) moving layout and keyboard/content reflows. This research distinguishes **observable product patterns**, **published usability tests**, **platform APIs**, and **our proposed solution**. It is not a claim to have tested competitors' source code or physical devices.

## Comparators

| Reference | Verified pattern | Implication for PersAI |
|---|---|---|
| ChatGPT Voice, OpenAI official documentation (2026) | Voice appears inside the chat with streamed text and visuals, or can be accessed in a separate focused experience | Keep the text timeline as a stable workspace; a vivid large orb belongs to the empty or immersive voice state, a smaller visual status may live in a fixed chrome |
| Gemini Live, 9to5Google (Apr 19 2026) | Google is testing compact waveform and in-app overlay instead of a separate full-screen voice panel (beta status must be preserved) | Voice/animation layer must not steal the reading area when a chat is populated; compact waveform/orb can preserve brand |
| Pi by Inflection | Gentle wave listening feedback in a focused voice surface and low-clutter text chat | Prefer calm, responsive status feedback rather than full-height moving artwork inside a scrolling list |
| Nielsen Norman Group user study (Apr 24 2026), recommendation #7 | Long streaming answers that auto-scroll continuously cause people to lose reading position | After Send scroll to latest question and **beginning** of answer; follow short responses; when streamed reply reaches ~70% viewport height, freeze at visible first lines until user deliberately returns to the bottom |
| Android Developers, IME | Recommended adjustResize; WindowInsetsAnimationCompat can synchronize layout with keyboard | Single owner of Android IME geometry; don't combine native resize and a second full-height keyboard adjustment; verify on Gboard and other IMEs |
| React Native ScrollView docs | maintainVisibleContentPosition supports preserving first visible child in chat lists; warning about reordering causing jank | Prefer content anchoring, careful stable keys, explicit control over auto-follow. Existing FlatList can first use gesture-only follow + anchor and be evaluated before applying native maintainVisibleContentPosition |
| Apple Human Interface Guidelines, Motion | Motion should communicate and not distract; make it optional | B+C Skia motion is retained but pinned away from text measurement; honor Reduced Motion |
| Val Head, Designing Interface Animation (Rosenfeld Media, 2016) | Motion should aid orientation/feedback, support visual style, not be mere decoration | Use continuous core/filament for state signaling; no moving layout containers, avoid resetting animation on every token |
| Tidwell, Brewer, Valencia, Designing Interfaces (3rd ed., O'Reilly, 2019/2020) | Patterns for visual hierarchy, layout, mobile, streams/feeds and navigation | Keep stable shell with fixed composer/header and scrollable content; input and bottom navigation should not obscure reading |

## Concrete UI state policy
1. **Empty/new chat:** large center Nebula B+C in scroll body's empty state, hide when IME is open. Composer remains anchored and accessible.
2. **Populated text chat:** persistent 48dp B+C status orb in a **72dp fixed-height header**, with reserved width even when not shown; preserves artistically approved shader but does not grow the list. This is a **technical stabilization**, not the final artistic size. An optional immersive voice presentation can be separately designed and user-approved.
3. **Busy:** preserve header height by always reserving a 13dp progress text line. Never append a dynamic orb/status footer into FlatList.
4. **Send + keyboard:** place latest user message and beginning of assistant output into view once keyboard settles. Android native resize should own IME geometry; no second `KeyboardAvoidingView height` calculation.
5. **Streaming short answer:** follow end only while content naturally fits. **Long answer:** when streamed bubble reaches 70% of chat viewport, disable programmatic follow. Do not suppress the user's natural scrolling.
6. **Reader override:** physical drag or fling means reading position takes precedence; manual return to the bottom opts back into follow. New Send resets the decision. A floating '↓ newest' affordance is a candidate for a later UI specification, not yet shipped.
7. **Failure/regression:** no disconnected empty screen, offscreen Send actions, oscillating position, midstream focus hijack, dropped LLM request on navigation, shader restart on each token, or unrecoverable position when navigating away/back.

## Acceptance
- Compare captured initial/final frames and the keyboard transition against the original user recording.
- Jest source + policy tests are **guards**, not proof of visual performance.
- Android emulator CI: real PIN/unlock, Gboard, send, message history, navigation, screenshots. A deterministic fake streaming long message fixture is a future addition.
- Manual Android physical-device acceptance: long streamed reply, short reply, keyboard open/closed, dragging backwards, device accessibility and Reduced Motion.
- Profile dropped frames and layout passes separately in performance plan; do not assert FPS from successful unit tests.

## Direct sources
- OpenAI ChatGPT Voice: https://help.openai.com/en/articles/20001274-chatgpt-voice
- Gemini Live Android redesign (beta, Apr 2026): https://9to5google.com/2026/04/19/gemini-live-app-redesign/
- Pi official: https://pi.ai/
- Nielsen Norman Group, *10 Guidelines for Designing Your Site's AI Chatbots* (Apr 2026): https://www.nngroup.com/articles/ai-chatbots-design-guidelines/
- Android IME geometry: https://developer.android.com/develop/ui/views/touch-and-input/keyboard-input/visibility
- Android keyboard animation: https://developer.android.com/develop/ui/views/layout/sw-keyboard
- React Native ScrollView: https://reactnative.dev/docs/scrollview
- Apple HIG Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Val Head book: https://rosenfeldmedia.com/books/designing-interface-animation/
- Tidwell et al.: https://www.oreilly.com/library/view/designing-interfaces-3rd/9781492051954/

## Decision caveat
Reference designs provide *principles*, not identical requirements. PersAI intentionally has a larger, more artistic and stateful B+C sphere than minimalist chat apps. Its approved orb shape, SkSL shader and speed remain unchanged; size, placement and responsive states can be reconsidered after a visual preview against realistic transcripts.
