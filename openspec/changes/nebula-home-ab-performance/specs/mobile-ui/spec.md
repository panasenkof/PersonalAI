# Nebula native Home A/B switch

## NA-01 Default live
WHEN a new profile first enters Home, THEN live high-quality native Skia B+C uses approved phase state and default motion, absent override.

## NA-02 Reversible static
WHEN a user selects OFF in developer diagnostics and returns Home, THEN `StaticSkiaOrb` renders the same image-backed quality with semantic phase filament, no animated clock, without modifying conversation data.

## NA-03 Automatic safety
WHEN Android Reduce Motion, background, or low power applies, THEN automatic static overrides manual ON; screen-reader phase and real chat status remain available.

## NA-04 Persistence
WHEN app restarts or user switches tabs, THEN last selected graphics mode persists locally and only changes graphics. On storage read error Home falls back to live with system motion safety.

## NA-05 Tests and future measured results
WHEN CI runs, THEN TypeScript/Jest/SkSL/Android bundle/browser QA succeed on the same commit. **Native GPU FPS, thermal and battery A/B results are NOT RUN until real-device protocol is executed.**
