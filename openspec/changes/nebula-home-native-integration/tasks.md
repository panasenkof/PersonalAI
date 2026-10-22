# Очередность и статус

- [x] Сначала определены [спецификация и acceptance](../../../docs/design/NEBULA_HOME_NATIVE_INTEGRATION.md).
- [x] Изолирован native Skia Home module, снята круговая обрезка/добавлен согласованный тёмный фон.
- [x] Переданы реальные стадии диктовки и LLM через чистую функцию и необязательный callback.
- [x] Тематизированы Home и tab bar без изменений Memory/Settings.
- [x] Добавлены unit/contract tests.
- [ ] Все проверки PR (TypeScript, Jest, SkSL CanvasKit, Browser QA) зелёные.
- [ ] Android Native SQLCipher build на ветке зелёный.
- [ ] После merge опубликован подписанный APK из main; пользователь проверил реальные GPU кадры, плавность/ресурсы и UX.
