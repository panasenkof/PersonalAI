# Device A/B integration

1. `visualMode.ts` pure decode mode, defaults live.
2. `visualPreference.native.ts` native `expo-sqlite/kv-store` provides device-local *non-sensitive* graphics switch; `.ts` web QA mirror avoids native storage in browser.
3. `DiagnosticLogsScreen` shows labeled Switch under «Для разработчика», persists it, reloads on focus.
4. `NebulaHomeArtwork.native.tsx` reloads persisted mode on focus after user returns from Diagnostics, without changing stream/voice/events; read failure restores live.
5. `NebulaSkiaExperiment pauseAnimation` removes live shader-clock subtree and renders the same original-backed statically shaded B+C core with phase filament. Diagnostic reason `manual-static`.
6. Test compatibility from Android build, CanvasKit SkSL, TypeScript/Jest/browser QA. Native load/persistence still require device QA.
