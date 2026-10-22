# Implementation

1. Extend pure `homeArtLayout` with `isNebulaChatNearBottom` (96dp threshold), and only permit auto-follow when the reader is near the bottom; switch from `animated:true` to `animated:false` for content-height changes.
2. Remove 116dp status art from `FlatList.ListFooterComponent` and render a **maximum 56dp** art **inside the existing busy-progress row**. Never draw status orb with keyboard focused/visible; hide compact orb caption.
3. Extract `SkiaClockMeter` as a separate component mounted only when `showDiagnostics` is true. The production Home's GPU uniforms update on the UI thread without regularly calling `runOnJS`; lab retains its diagnostic counter.
4. No SkSL changes in this PR: compare the GPU interpolation separately only after user validates a stable chat layout. Both accepted ×5 orb and ×1 line stay.
5. CI: pure layout tests, source guard against repeated animated scrolling and hidden JS observer, TS/Jest/SkSL/browser/native SQLCipher build. Real Android videos and Android GPU measurements remain a manual gate.
