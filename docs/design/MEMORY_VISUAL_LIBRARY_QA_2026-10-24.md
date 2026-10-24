# Memory library QA — 24 October 2026

Visual targets: `references/memory-20261024/library-target.png` and
`note-ai-target.png`. Actual browser screenshots are in the `browser/` child directory.
The images named `target` are design concepts, never claimed to be APK screenshots.

## Evidence

- PASS: TypeScript (`npm run typecheck`).
- PASS: final Jest (`--ci --maxWorkers=2`): 80 suites, 550 tests. Targeted checks:
  5 suites, 36 tests. Jest reports a worker teardown/open-timer warning after all
  tests pass; this is not claimed as a clean teardown result.
- PASS: `verify-mobile-ui.cjs`, all 320/360/390/430/768 px. Production navigator and
  screens, mock native services and local fixture persistence. Reading/editing,
  LLM preview/compare/apply/undo (mock provider), dirty discard, metadata persistence,
  archives, backup navigation, import, keyboard-sized viewport, 0/24/48 px insets.
- PASS: roadmap integrity (all 91 IDs) and all canonical Nebula artwork SHA256.
- PASS: visual inspection of 390px text-card grid and note AI preview. Fixed title
  wrapping caused by placing icon, title and chevron in one narrow row.
- NOT RUN locally: Android APK, real SQLCipher thumbnail decode, microphone/Whisper,
  TalkBack, real IME, system font scaling and performance. CI and device acceptance
  must be reported independently, not inferred from browser green.

## Comparison and limits

Layout hierarchy follows the selected collection/recent grid and note AI sheet.
The synthetic browser library contains text/file records; it deliberately does not
fabricate photographic content for notes without images. Photo thumbnail lifetime
and cancellation are exercised by component tests, but actual Android decode and
photo-rich visual comparison remain OPEN. PDF page thumbnails/video keyframes are
not implemented. Collection cards use their first image among the 12 recent notes;
collections without a suitable image show a folder. Real photos >12 MB require
explicit attachment viewing. No persistent plaintext thumbnail cache.

No decorative starfield was added to memory: existing Nebula semantic surfaces are
used, with source imagery supplying visual detail. Home and its B+C artwork are intact.

## Short device acceptance

1. Open a collection with photos plus text notes; check grid/list, scroll and return.
2. Open a note: read text and originals, then edit; dictate additional text and save.
3. “Изменить с ИИ” → dictate “Оформи списком” → request → compare → apply → save/reopen.
4. Cancel a running edit and background/lock during a preview; no late overwrite/image.
5. Check private note cannot invoke LLM, and unsaved movement does not grant access.
6. Check keyboard and increased text, archive/restore, selection/merge/undo.

Publication: explicitly authorized by the user for panasenkof/PersonalAI on
24 October 2026. Published through the GitHub connector; local Git has no credentials.
Remote CI and Android acceptance are reported separately in the pull request.
