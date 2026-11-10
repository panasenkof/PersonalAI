# Telegram B7 — чтение тематических подборок «Избранного»

10.11.2026. **READ-ONLY backend**, без включения официального TDLib бинарника в APK и без автоматического импорта.

## Preflight C0-A / C3-B
- Резервный Bot API, обычный Saved Messages reader и единственный `saveMediaNote` / SQLCipher уже реализованы; отдельную память/поиск не создавать.
- TDLib API `loadSavedMessagesTopics(limit)` возвращает `ok`, а сами темы поступают **асинхронно** через `updateSavedMessagesTopic`. Поэтому нельзя рассчитывать, что ответ `load...` содержит список.
- Идентификаторы тем могут быть **знаковыми int53**: chat-источники Telegram допускают отрицательные chat IDs. Нельзя принимать произвольный topicId как chatId.

## B7
- Нативный единственный receive-loop накапливает в памяти (максимум 256) только topic ID, type, pinned/order, полученные из `updateSavedMessagesTopic`. Профиль, закрытие и новая инициализация очищают список. Сами объекты TDLib, черновики и текст последних сообщений не передаются JS.
- `listSavedMessagesTopics(profile)` вызывает `loadSavedMessagesTopics(20)` и возвращает краткую проекцию. Повторное чтение может понадобиться, пока обновления доставляются.
- `getSavedMessagesTopicPage(profile,topicId,cursor,limit)` проходит только для тем, уже обнаруженных нативным TDLib; использует `getSavedMessagesTopicHistory` (1–20). Проекция сообщений идентична существующему `getSavedMessagesPage`; JS удостоверяется в exact topic ID и self-chat ID. Только AppLock + native Ready.
- Никакого API чтения произвольного чата, отправки сообщений, второго индекса или нового классификатора.

## Следующий PR
- UI: компактный выбор только полученных тем и продолжение чтения постранично, без ложных описаний «папки» — Telegram группирует Saved Messages по источнику пересылки.
- Канонический импорт текста тем через `saveMediaNote`, **те же source chat/message IDs и тот же дедуп**, без повторной записи содержимого при просмотре и в глобальной истории.
- Медиа и альбомы — только после отдельного скачивания оригиналов; не заменять фото текстом подписи.
- LLM-разметка: через существующий обогатитель по выбору пользователя, не скрытый сетевой вызов.
- Live Telegram на Vivo X200 Pro — NOT_RUN_PHYSICAL, только после официального подписанного APK и native TDLib binary gate.

## Postflight C0-A / C3-B
Единственный существующий TDLib native receive-loop, JS read adapter и тесты. Нет SQL миграций/настроек/Android permissions/дополнительной БД. CI on exact SHA до merge.
