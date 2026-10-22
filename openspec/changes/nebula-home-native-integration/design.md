# Технический дизайн

1. **Platform split:** `NebulaHomeArtwork.native.tsx` содержит native Skia и `useIsFocused()`, чтобы clock размонтировался вне Home; `NebulaHomeArtwork.tsx` остаётся web/browser QA fallback с проверенным REF-ORB-B. На Android Metro должен выбрать `.native.tsx`; проверить на release APK, не верить только Jest/browser.
2. **Источник фаз:** чистая `homePhase.ts` из `VoiceInput.onPhaseChange` (реальный listening/finishing) и `active.busy/streamText`. Не выдумывать микрофонную амплитуду, progress % или статус сети без события.
3. **Поверхности:** `NebulaHomeThemeProvider` переключает только Home/его вложенные UI на тёмные semantic colors; tabBar for Home override в `navigation.tsx` сохраняет insets. Остальные вкладки берут системную тему. StatusBar light пока Home focused.
4. **Композиция SkSL:** шейдер поддерживает `uHomeCanvas` для matching deep-space edges, без круговой обрезки canvas; лаборатория по умолчанию не меняется (`uHomeCanvas=0`). Базовая динамика B+C/контур и отдельные 5× и 1× сохранены.
5. **Список и composer:** большой orb только на пустом диалоге, в непустом/активном — небольшой status orb в ListFooter; текст ответа и кнопки сохраняются.
6. **Контроль качества:** JSX guard tests, реальные .native resolution/Metro bundle в Android release workflow, SkSL CanvasKit, TS/Jest, Playwright и ручной Android GPU FPS / accessibility.
