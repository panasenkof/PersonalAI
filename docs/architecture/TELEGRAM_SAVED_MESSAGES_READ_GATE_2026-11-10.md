# Telegram PR2.B4 — безопасное чтение «Избранного» (read-only)

Дата 10.11.2026. Предпосылка: PR #461 TDLib native gateway, #463 auth UI независимо.

## Preflight C0-A / C3-B
- Существующие память/импорт: только `saveMediaNote` + SQLCipher + штатный индекс и LLM tools.
- Native TDLib gateway существует, но официальные бинарники ещё не подключены к обычному APK; новая функция должна оставаться недоступной без реальной авторизации.
- Текущий резервный Telegram Bot API независим, ограничен только разрешённым личным чатом.

## Состав и границы B4
- Узкий `getSavedMessagesPage(cursor, limit)` только через `getMe → createPrivateChat(selfId) → getChatHistory(selfChat)`.
- Запрет произвольного `chat_id` из JS; source identity подтверждается нативным `getMe`, ограничение 1–20, обратный порядок, курсор int53.
- Нативный мост отдаёт только ограниченный JSON с id/date/content kind/text/caption/media flag. Исходные объекты TDLib, номера телефонов, сведения об отправителях и бинарные медиа не передаются в JS.
- Чтение допускается только после AppLock и `authorizationStateReady`, повторная проверка после await.
- При чтении **не создаются заметки**, не вызывается модель, не передаётся текст наружу, не продвигается durable import cursor.
- У медиа только признак и подпись, оригинал не скачивается; этот read-only PR не должен выдаваться за завершённый импорт.
- `from_message_id` может вернуть включённый anchor; JS-обёртка удаляет его и завершает работу при отсутствии прогресса.

## Что ещё необходимо
1. Официально собрать и проверить TDLib под arm64-v8a и x86_64; enable binary gate только после проверки происхождения/SSL/licenses/16KiB и реального smoke.
2. Подключить независимый UI предпросмотра, показывать количество и типы без сохранения.
3. Реализовать topic list через `loadSavedMessagesTopics` / нативные updateSavedMessagesTopic, затем `getSavedMessagesTopicHistory` с отдельной проверкой topic IDs; не принимать произвольный topic_id из JS.
4. Добавить канонический `saveMediaNote` с dedup/receipt, batch transactional import, обработку медиа, выбор раздела/LLM только после согласия и cursor после durable commit.
5. Реальное Android Vivo и Telegram acceptance: `NOT_RUN_PHYSICAL`.

## Postflight C0-A/C3-B
Нет второй БД, FTS, инструмента поиска, фона, новой Android permission или второго writer; строго read-only транспортный адаптер. TypeScript/Jest + native CI на exact head; отдельный real-device C2 gate.
