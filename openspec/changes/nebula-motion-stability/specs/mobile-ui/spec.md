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
