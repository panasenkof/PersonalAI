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
