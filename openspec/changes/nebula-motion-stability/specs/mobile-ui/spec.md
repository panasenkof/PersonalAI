# Nebula motion stability acceptance

## MS-01: User-directed conversation position
WHEN a streamed answer changes height and the reader is near the bottom, THEN the list follows without launching an overlapping animated scroll.
WHEN the reader scrolls up to older messages, THEN streaming does not yank them back down.

## MS-02: Stable status indicator
WHEN LLM is busy, THEN only a compact ≤56dp Nebula orb may appear, inside the pre-existing progress row.
WHEN busy ends OR Gboard is visible, THEN no standalone large footer orb occupies space or hides the composer.

## MS-03: No invisible cross-thread animation metering
WHEN `showDiagnostics=false` on production Home, THEN no Skia clock observer sends regular ticks across the JS bridge.
WHEN `showDiagnostics=true` in the Lab, THEN an observable counter stays functional.

## MS-04: Preserve product visual and security
WHEN updating stability, THEN B+C image-backed shader, five membranes, neon filament, agreed ×5/×1 and color phases do not change. Android Reduce Motion, tabs, chat data and locked-screen flow remain intact.

## MS-05: Android signoff
WHEN CI and Android native build are complete, THEN supply a new APK and collect real-device recordings; FPS/energy measurements must not be claimed from source tests alone.

## MS-09/10: Send ends input and anchors thinking under chat

WHEN a user sends text from focused Gboard, THEN dismiss the keyboard, keep the submitted message, position latest message and LLM thinking status near the bottom above the composer, even if the chat has many old messages. Do not wait for the next user interaction to scroll. When keyboardDidHide completes layout adjustment, settle the viewport again using its new height. Do not reset the saved conversation or delete the unsent draft before Send commits.

## MS-11/12: No conflicting scroll loops

WHEN streaming text resizes the list, THEN at most one nonanimated scroll is scheduled per animation frame while the user stays near bottom. WHEN the user starts dragging up, THEN cancel forced follow immediately and leave the history where the user placed it, until the next explicit Send. Do not hide the keyboard on a typing pause or when Stop is pressed.
