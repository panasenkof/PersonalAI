# Каналы

Все каналы нормализуются в `IngestionEnvelope` и идут одним путём: `submit_envelope` → очередь → `process_envelope` →
агент → ответ в канал. Привязка аккаунта: `POST /v1/channels/{telegram|slack|whatsapp|discord}/link-code` (JWT) → в чате
`/start КОД` (Discord: `/link code:КОД`). Команды во всех каналах: `/new` (новый диалог), `/stop` (прервать генерацию).

| Канал | Endpoint | Текст | Фото | Документы / PDF | Голос | Кнопки подтверждения фактов | Треды |
|---|---|---|---|---|---|---|---|
| Web | `/app`, SSE | ✅ | ✅ | ✅ | — | ✅ карточки | — |
| Mobile | REST + SSE | ✅ | ✅ | ✅ | — | ✅ карточки | — |
| Telegram | `/v1/channels/telegram/webhook` | ✅ | ✅ | ✅ (`document`) | ✅ (STT) | ✅ inline `fact:c/r:<id>` | — |
| Slack | `/v1/channels/slack/events`, `/interactive` | ✅ | ✅ | ✅ (`files`, скачивание с bot-token) | ✅ (аудио-файл → STT) | ✅ Block Kit | ✅ ответ в `thread_ts` |
| WhatsApp (Cloud API) | `/v1/channels/whatsapp/webhook` | ✅ | ✅ | ✅ | ✅ (STT) | ✅ reply-кнопки | — |
| Discord | `/v1/channels/discord/interactions` | `/ask` | вложение `/ask file:` | ✅ | вложение → STT | ✅ кнопки-компоненты | — |

Нюансы
* Ответы длиннее лимита платформы режутся на части (Telegram/WhatsApp 4000, Slack 3900, Discord 1900).
* Голос → текст: OpenAI-совместимый `/audio/transcriptions` (`STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`); без настройки
  пользователь получает понятное сообщение.
* Повторные доставки вебхука (retry платформы) не создают дублей: dedupe по `correlation_id`; обработчики не отдают 5xx.
* **Telegram**: `setWebhook` с `secret_token=TELEGRAM_WEBHOOK_SECRET`.
* **Slack**: включите Events API (сообщения в DM/тредах, в т.ч. с файлами) и Interactivity → `/v1/channels/slack/interactive`.
* **WhatsApp**: Meta App → Webhook URL `/v1/channels/whatsapp/webhook`, `WHATSAPP_VERIFY_TOKEN`, подпись `WHATSAPP_APP_SECRET`.
* **Discord**: Interactions Endpoint URL → `/v1/channels/discord/interactions`; slash-команды регистрируются
  `python -m app.channels.discord_register [guild_id]` (нужны `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`).
  Первый ответ отдаётся за 3 с (deferred), результат приходит follow-up сообщением.

## MAX

MAX использует ту же очередь, память диалогов, обработку вложений и подтверждение
фактов, что и Telegram. Поддерживаются личные диалоги с ботом: текст, изображения,
документы и аудио (для расшифровки настройте STT). Групповые сообщения и посты
игнорируются, чтобы данные личного помощника и коды привязки не попадали в общий чат.

1. Создайте бота на платформе MAX для бизнеса и получите токен согласно
   [официальной инструкции](https://dev.max.ru/docs/chatbots/bots-coding/prepare).
2. Запишите в `.env` `MAX_BOT_TOKEN` и случайный `MAX_WEBHOOK_SECRET`
   (например, `python -c "import secrets; print(secrets.token_hex(32))"`).
   Токен передаётся только в заголовке Authorization.
3. Обновите БД: `cd backend && python -m alembic upgrade head`.
   Docker Compose выполняет миграцию через сервис `migrate`.
4. Перезапустите API и worker. В production оставьте `MESSAGE_MODE=queue`,
   чтобы webhook быстро отвечал, а модель выполнялась в worker.
5. Зарегистрируйте webhook из каталога `backend`:

   ```bash
   python -m app.channels.max_register --url https://YOUR_DOMAIN/v1/channels/max/webhook
   ```

   Для Docker Compose:

   ```bash
   docker compose exec api python -m app.channels.max_register --url https://YOUR_DOMAIN/v1/channels/max/webhook
   ```

   Нужен публичный HTTPS на порту 443 с доверенным сертификатом. При локальном
   развёртывании можно использовать HTTPS-адрес ngrok; после его изменения повторите
   регистрацию. Бот подписывается на `message_created`, `message_callback`, `bot_started`.
   Секрет проверяется в заголовке `X-Max-Bot-Api-Secret`.
6. В веб-приложении или мобильных настройках выберите MAX и получите код привязки.
   Отправьте боту `/start КОД`. Код одноразовый, действует 15 минут.
7. Отправьте сообщение, фото, документ или аудио. Кнопки «Подтвердить»/«Отклонить»
   сохраняют или отклоняют распознанные данные только для их владельца.
   `/new` начинает новый диалог; `/stop` останавливает последнюю активную задачу.

Напоминания доставляются в MAX, если настроен токен и привязан MAX-аккаунт,
а настроенный Telegram недоступен для этого пользователя. Если подключены оба
канала, используется Telegram; уведомления не дублируются. Ошибка отправки в Telegram
повторяется в следующем цикле и не переключает канал автоматически.

`MAX_API_BASE_URL` по умолчанию `https://platform-api2.max.ru`, согласно
[актуальной документации API](https://dev.max.ru/docs-api).
Если окружению нужен дополнительный доверенный сертификат, установите его в
системный trust store / `SSL_CERT_FILE`; не отключайте TLS-проверку.
Отправка сообщений ограничена одним сообщением в секунду на диалог (через Redis
при наличии `REDIS_URL`, иначе внутри процесса); HTTP-запросы используют общую
политику повторов, включая `Retry-After`.
Медиа скачиваются без bot-токена, без переходов по redirect и с ограничением
`MAX_UPLOAD_BYTES`. `MAX_MEDIA_ALLOWED_HOSTS` содержит разрешённые домены CDN
(`max.ru,ok.ru,userapi.com` по умолчанию, включая их поддомены). Если MAX выдаёт
ссылку на другой CDN, проверьте домен по реальному событию и добавьте его в этот
список; не разрешайте произвольные пользовательские URL.

Проверка после установки: привязка → текстовый ответ → загрузка документа →
подтверждение факта → `/new` → повторная доставка того же события (одна задача).
Автотесты используют подмену HTTP API; проверка с реальным ботом требует вашего
токена и публичного webhook. Видео и другие типы вложений пока не обрабатываются.
