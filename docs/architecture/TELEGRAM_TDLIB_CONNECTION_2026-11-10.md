# PersAI — TDLib и резервный Bot API: контроль интеграции

Решение владельца 10.11.2026. PR2.A **только настройка**, не авторизация и не импорт Telegram.

## Preflight C0-A / C3-B
- Canonical writer: `mobile/src/media/attachments.ts::saveMediaNote`, SQLCipher local-memory, существующий FTS/vector.
- Приложение Expo SDK 57, есть собственные Expo native modules; проверенного TDLib JNI бинарника пока нет.
- Не создавать вторую систему памяти, индекс, UI-мастер импорта или обход LLM tool loop. Android Share PR1 пропущен.

## PR2.A (этот пакет)
- Настройки → Telegram с отдельным manual/on_open, default manual, не выполнять скрытый network/LLM вызов.
- API ID/hash хранить в per-profile SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, без plaintext в UI/логах/бэкапах.
- Явно обозначить, что наличие API ID/hash не равно авторизации аккаунта; не показывать фиктивное «Подключено».
- Личный бот — резервный способ; не читать историю Telegram по Bot API.

## PR2.B (следующий native PR)
1. Пиновать upstream tdlib/td SHA, воспроизводимо собирать arm64-v8a (Vivo), другие ABI по матрице Android CI, публиковать notices/SBOM, проверять JNI/SSL/ABI/размер. Официальная документация: https://github.com/tdlib/td/tree/master/example/android и https://core.telegram.org/tdlib/getting-started.
2. Native bridge с отдельной последовательной receive-loop, state machine auth (phone/QR/code/password/email), lifecycle cleanup, cancel, точными error states; нельзя сохранять коды/пароль в памяти или логах.
3. Разрешить только «Избранное» при первом подключении, `getMe` и scoped TDLib messages; не читать/индексировать произвольные чаты. Граница TDLib Telegram session cache / encrypted PersAI важна: нужна отдельная оценка хранения at-rest и удаления при revoke.
4. Auth/session не экспортировать в резервную копию памяти. Запуск on_open только после AppLock и готовности profile/DB. manual никогда не вызывает сеть. Должны быть разрыв сети, переподключение, logout и negative cases.
5. CI TypeScript/Jest, native Expo+SQLCipher emulator, signed APK; физический Vivo X200 Pro NOT_RUN_PHYSICAL до реальной проверки.

## Резервный канал Bot API
- Личный бот с отдельными токеном и подтверждённым разрешённым chat_id. Бот получает только сообщения, добровольно присланные ему; к «Избранному» доступа не имеет.
- Long/short polling `getUpdates` на устройстве, без webhook/сервера, обновления Telegram хранятся не более 24 часов; отдельная настройка sync manual/on_open применяется без таймера.
- Cursor ACK `offset` только после durable canonical write или достоверного duplicate receipt. Фото/альбомы: группировать по media_group_id, не терять caption, provenance, не дублировать. Ошибки и revoked grants не приводят к частичному сохранению.
- Не переключать webhook чужого бота. Нельзя помещать token в APK, лог или ссылку заметки; хранить в device-only SecureStore. Согласие на внешнюю LLM-обработку отдельно.

## Postflight gate PR2.A
- Новые файлы содержат только настройки/UI, не подключают Telegram, не создают второе хранилище.
- Проверка: default/manual/fail closed, per-profile creds, masking hash, отсутствие network, UI navigation. CI на SHA и Android physical отдельно.
