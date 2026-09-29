# PIA Agent — персональный ИИ и база знаний

Мультимодальный персональный ассистент с собственной базой знаний: чат в **вебе**, через **Telegram**, **Slack**, **WhatsApp**, **Discord** и **мобильное приложение**; облачная или локальная OpenAI-совместимая LLM; доменные плагины (**automotive**, **medical_labs**); память диалогов, RAG-поиск, фоновая обработка с SSE-стримингом и отменой, MCP-сервер и проактивные напоминания.

Спецификация: [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md) · [масштабирование и надёжность](docs/SCALING.md) · [безопасность](docs/SECURITY.md) · [каналы](docs/CHANNELS.md). Лицензия: MIT.

## Возможности

| Область | Что реализовано |
|---|---|
| **Диалоги** | История разговоров (Conversation/ChatTurn), окно последних ротов + компакт-сжатие старых, все каналы в одной ленте |
| **RAG** | Эмбеддинги через `/embeddings`, чанкинг при записи сущностей/наблюдений, **pgvector** (HNSW, cosine) на Postgres + текстовый поиск, слияние RRF; на SQLite — косинус в Python; деградация до текста при недоступности эмбеддингов; бэкфилл `python -m app.rag.reindex` |
| **Обработка** | `MESSAGE_MODE=queue`: приём запроса → **персистентная очередь** (Postgres + Redis, `QUEUE_BACKEND=redis`) → отдельные воркеры `python -m app.worker` (масштабируются независимо, подхват «осиротевших» джоб после рестарта, ретраи) → ответ в канал; `inprocess`/`sync` для одного инстанса и разработки |
| **Стриминг и отмена** | `GET /v1/jobs/{id}/events` (SSE через Redis pub/sub — работает между репликами): статус → токены → **аргументы tool-call'ов по мере генерации** → `tool_start`/`tool` (результат, мс) → финал; **«Стоп»** — `POST /v1/jobs/{id}/cancel` (веб/мобайл) и `/stop` в мессенджерах, частичный ответ сохраняется |
| **Web-чат** | Статический SPA на `/app`: логин (+2FA), список чатов, живой стриминг, чипы инструментов, кнопка Стоп, карточки подтверждения фактов, настройки LLM |
| **Mobile** | Expo/React Native: вход (+2FA) → список чатов → чат (стриминг, tool-чипы, Стоп, вложения, подтверждение фактов) → настройки (LLM, 2FA, выход со всех устройств, привязка каналов, адрес сервера) |
| **Telegram** | Link-code, фото, **документы/PDF**, голос (STT), **inline-кнопки подтверждения фактов** (`awaiting_confirm`), `/stop` `/new` |
| **Slack** | Events API + HMAC-подпись, **файлы**, **треды** (ответ в `thread_ts`, диалог на тред), Block Kit-кнопки фактов, `/stop` `/new` |
| **WhatsApp / Discord** | WhatsApp Cloud API (подпись, медиа, reply-кнопки) и Discord Interactions (Ed25519, `/ask` `/link` `/stop` `/new`, кнопки) — см. [docs/CHANNELS.md](docs/CHANNELS.md) |
| **MCP** | `POST /mcp` — Streamable HTTP подмножество: `initialize`, `tools/list`, `tools/call` (инструменты агента под JWT-пользователем) |
| **Automotive** | Техпаспорт авто, сервисные события, парсинг чека vision-моделью, регламент ТО (web+LLM), детерминированный `compute_next_due` |
| **Medical labs** | `labs_record_report` (текст/PDF/изображение → наблюдение), `labs_get_trends` (динамика показателя), только извлечение — без диагнозов |
| **Напоминания** | Планировщик: ТО «через N км» → в Telegram, одна запись на пункт/день (уникальный констрейнт) |
| **Надёжность** | ~100 тестов (SQLite и реальный Postgres+pgvector в CI), ruff + mypy, Alembic, Docker (app + worker + Postgres/pgvector + Redis), **retry с backoff+jitter и `Retry-After` для всех внешних API**, лимит параллельных LLM-вызовов, **rate limit LLM на пользователя** (Redis — общий для реплик), `/ready`, structured logs + correlation-id, `/v1/stats` |
| **Безопасность** | **2FA (TOTP + recovery-коды)**, **роли user/admin**, отзыв токенов (`token_version`, logout-all), **ротация JWT-секрета** (`JWT_SECRET_PREVIOUS`), шифрование at rest (ключи LLM, история, TOTP, джобы, файлы; ротация MultiFernet + `rekey`), **fail-closed в production** (слабые секреты и вебхуки без секрета → отказ), защита логина от перебора, path traversal, лимит загрузки, CORS — подробно в [docs/SECURITY.md](docs/SECURITY.md) |
| **Evals** | Золотой набор (6 сценариев): `python -m evals.runner` — scripted LLM на каждый PR; **`--live` — реальная LLM, автозапуск в CI** (`evals-live.yml`: ночью, при изменении агента/промптов, вручную; N прогонов, порог pass-rate, отчёт в Job Summary) |

## Быстрый старт

### Docker (продакшн-режим: Postgres+pgvector, Redis, API, воркеры)

```bash
cp .env.example .env        # обязательно: JWT_SECRET (>=32 симв.), PIA_AGENT_SECRET (Fernet-ключ)
docker compose up -d --build --scale worker=2
open http://localhost:8000/app/    # web-чат
```

В `APP_ENV=production` слабые секреты и вебхуки без секрета останавливают запуск — см. [docs/SECURITY.md](docs/SECURITY.md).
Обновление существующей установки — в [docs/SCALING.md](docs/SCALING.md#обновление-существующей-установки).

### Разработка (SQLite, sync-режим)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
export JWT_SECRET=dev-secret
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Миграции: `alembic upgrade head` (свежая SQLite создаётся и через `create_all` при старте).

### Тесты и качество

```bash
cd backend
pytest tests/ -q          # ~100 тестов, включая golden-set evals (fakeredis вместо Redis)
ruff check . && mypy app
python -m evals.runner    # детерминированная проверка агента (офлайн)
# live-evals с настоящей LLM:
EVAL_LLM_API_KEY=sk-... python -m evals.runner --live --runs 3 --min-pass-rate 0.8
```

### Mobile (Expo)

```bash
cd mobile
npm install
export EXPO_PUBLIC_API_BASE=http://YOUR_LAN_IP:8000   # можно сменить и в Настройках приложения
npx expo start
npm run typecheck && npm test                         # tsc + jest
```

## API (кратко)

- `POST /v1/auth/register|token` (+`otp` при 2FA) → access + **refresh**; `/refresh`, `/me`, `/password`, `/logout-all`, `/2fa/setup|enable|disable`
- `GET /v1/admin/users|stats`, `PATCH /v1/admin/users/{id}` — только роль `admin`
- `GET/PATCH /v1/settings/llm` — облачный/локальный `base_url`, модель, эмбеддинги, API-ключ
- `POST /v1/messages` — текст + вложения (+`conversation_id`); в `queue`-режиме сразу возвращает `job_id`
- `GET /v1/jobs/{id}` · **`GET /v1/jobs/{id}/events`** — SSE (`?access_token=` для EventSource) · **`POST /v1/jobs/{id}/cancel`**
- `GET /v1/facts` · `POST /v1/facts/{id}/confirm|reject` — подтверждение извлечённых из фото/PDF фактов
- `GET /ready` — готовность (БД, Redis)
- `GET /v1/conversations` · `GET /v1/conversations/{id}/messages`
- `GET /v1/collections` · `GET /v1/collections/{slug}/entities` · `GET /v1/stats`
- `POST /v1/blobs` — загрузка файла (лимит `MAX_UPLOAD_BYTES`, владение по пользователю)
- `POST /v1/channels/{telegram|slack|whatsapp|discord}/link-code`; вебхуки: `telegram/webhook`, `slack/events|interactive`, `whatsapp/webhook`, `discord/interactions`
- **`POST /mcp`** — Model Context Protocol (`initialize`, `tools/list`, `tools/call`)

## Архитектура

```
web / mobile / Telegram / Slack / WhatsApp / Discord / MCP
        │
        ▼
FastAPI (N реплик) ──► IngestionEnvelope ──► submit_envelope ──► IngestionJob (Postgres) + Redis-очередь
        ▲ SSE                                                           │
        │                                                               ▼
   Redis pub/sub  ◄── события, отмена ──  worker (M процессов): process_envelope ─► run_agent (tool loop, стриминг)
                                                                        │                    │
                                                                        ▼                    ▼
                                                              доменные плагины      hybrid RAG (pgvector + текст, RRF)
                                                                        │
                                                                        ▼
       KB: Collection / Entity / Observation / Blob / ChatTurn / ExtractedFact (подтверждение) / Chunk(vector)
```

Ключевые модули: `app/agent` (оркестратор, история), `app/rag` (чанкинг, гибридный поиск), `app/queue` (очереди inprocess/redis, EventBus, отмена), `app/worker.py`, `app/net` (retry/backoff), `app/llm` (провайдеры, лимиты), `app/security` (2FA, шифрование, rate limit), `app/channels` (telegram, slack, whatsapp, discord), `app/domains` (automotive, medical_labs), `app/mcp`, `app/scheduler` (напоминания), `evals` (golden set).

## Переменные окружения

Смотрите [.env.example](.env.example): `JWT_SECRET`, `DATABASE_URL`, `PIA_AGENT_SECRET` (Fernet-ключ), `MESSAGE_MODE`, `QUEUE_BACKEND`/`REDIS_URL`/`EMBEDDED_WORKER`, `TELEGRAM_*`, `SLACK_*`, `WHATSAPP_*`, `DISCORD_*`, `STT_*`, `REMINDERS_*`, `LLM_ALLOW_LOCAL_FALLBACK` + `FALLBACK_*`, `RATE_LIMIT_AUTH_PER_MINUTE`/`RATE_LIMIT_LLM_PER_MINUTE`, `ADMIN_EMAILS`, `JWT_SECRET_PREVIOUS`, `EVAL_LLM_*`, `LOG_FORMAT=json`.

## Статус и roadmap

- ✅ Фаза 0 — зелёные тесты, CI, Docker, Alembic, security hardening
- ✅ Фаза 1 — память диалогов + гибридный RAG
- ✅ Фаза 2 — фоновая очередь, SSE, web-чат, проактивные напоминания
- ✅ Фаза 3 — MCP, Slack, medical_labs, evals, наблюдаемость
- ✅ Фаза 4 — production-масштабирование: Redis-очередь + воркеры, pgvector, отмена и стриминг tool-call'ов, retry/rate-limit, каналы (документы, треды, кнопки, WhatsApp, Discord), 2FA/роли/ротация ключей, шифрование at rest, полноэкранное мобильное приложение, live-evals в CI
- 🔜 Далее: шифрование поискового индекса на уровне СУБД (сейчас — на уровне диска/управляемого Postgres, см. [docs/SECURITY.md](docs/SECURITY.md)), кросс-рольные ACL, общие (shared) коллекции, push-уведомления в мобильном приложении

## Известные ограничения

- **Файлы** хранятся на диске (`BLOB_STORAGE_DIR`): для нескольких узлов нужен общий том (NFS/EFS) — S3-бэкенда пока нет.
- **События SSE**: каждая реплика подписана на pub/sub всех джоб (простая схема с replay-буфером); при сотнях одновременных стримов стоит перейти на Redis Streams.
- **Семантика доставки** — at-least-once: после падения воркера агент может повторить работу (записи в БД откатываются вместе с транзакцией, но внешние побочные эффекты — например ответ в мессенджер — возможны дважды).
- **Поисковый индекс** (`chunks.text`, payload) не шифруется приложением — см. [docs/SECURITY.md](docs/SECURITY.md).
- Refresh-токены не ротируются по одному (отзыв — `logout-all`); блокировка логина по e-mail может использоваться для DoS конкретной учётки.
- Live-evals и мобильное приложение проверены только на моках/типах; нужны прогон с реальной LLM и тест на устройстве.

## Автор

Panasenkof
