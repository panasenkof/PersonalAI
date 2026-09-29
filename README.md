# PIA Agent — персональный ИИ и база знаний

Мультимодальный персональный ассистент с собственной базой знаний: чат в **вебе**, через **Telegram**, **Slack** и **мобильное приложение**; облачная или локальная OpenAI-совместимая LLM; доменные плагины (**automotive**, **medical_labs**); память диалогов, RAG-поиск, фоновая обработка с SSE-стримингом, MCP-сервер и проактивные напоминания.

Спецификация: [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md). Лицензия: MIT.

## Возможности

| Область | Что реализовано |
|---|---|
| **Диалоги** | История разговоров (Conversation/ChatTurn), окно последних ротов + компакт-сжатие старых, все каналы в одной ленте |
| **RAG** | Эмбеддинги через `/embeddings`, чанкинг при записи сущностей/наблюдений, **гибридный поиск** (косинус + подстрока), деградация до текста при недоступности эмбеддингов |
| **Обработка** | `MESSAGE_MODE=queue`: быстрый приём запроса → фоновый воркер (asyncio, ограниченная конкурентность) → ответ в канал; `sync` для разработки/тестов |
| **Стриминг** | `GET /v1/jobs/{id}/events` (SSE): статус → токены → вызовы инструментов → финал; токены идут из `stream_chat` (SSE-дельты OpenAI-совместимого API) |
| **Web-чат** | Статический SPA на `/app`: логин, список чатов, живой стриминг, настройки LLM |
| **Telegram** | Link-code привязка, фото, webhook-секрет, ответ воркером после фоновой обработки |
| **Slack** | Events API с проверкой HMAC-подписи (replay-окно), link-code привязка, `chat.postMessage` ответы |
| **MCP** | `POST /mcp` — Streamable HTTP подмножество: `initialize`, `tools/list`, `tools/call` (инструменты агента под JWT-пользователем) |
| **Automotive** | Техпаспорт авто, сервисные события, парсинг чека vision-моделью, регламент ТО (web+LLM), детерминированный `compute_next_due` |
| **Medical labs** | `labs_record_report` (текст/PDF/изображение → наблюдение), `labs_get_trends` (динамика показателя), только извлечение — без диагнозов |
| **Напоминания** | Планировщик: ТО «через N км» → в Telegram, одна запись на пункт/день (уникальный констрейнт) |
| **Надёжность** | 47+ тестов, ruff + mypy, GitHub Actions CI, Alembic-миграции, Docker, structured logs + correlation-id, `/v1/stats` (джобы, токены, размер KB) |
| **Безопасность** | Fernet-шифрование ключей LLM, владение blob'ами, защита от path traversal, лимит загрузки, refresh-токены, опциональный rate limit auth, CORS без wildcard+credentials |
| **Evals** | Золотой набор сценариев: `python -m evals.runner` (офлайн, scripted LLM) или `PIA_EVAL_LIVE=1` (реальная LLM) |

## Быстрый старт

### Docker (продакшн-режим: Postgres + Redis + фоновая очередь)

```bash
cp .env.example .env        # заполните JWT_SECRET, ключи и токены
docker compose up -d --build
open http://localhost:8000/app/    # web-чат
```

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
pytest tests/ -q          # 47+ тестов, включая golden-set evals
ruff check . && mypy app
python -m evals.runner    # детерминированная проверка агента (офлайн)
```

### Mobile (Expo)

```bash
cd mobile
npm install
export EXPO_PUBLIC_API_BASE=http://YOUR_LAN_IP:8000
npx expo start
```

## API (кратко)

- `POST /v1/auth/register|token` → access + **refresh**; `POST /v1/auth/refresh`
- `GET/PATCH /v1/settings/llm` — облачный/локальный `base_url`, модель, эмбеддинги, API-ключ
- `POST /v1/messages` — текст + вложения (+`conversation_id`); в `queue`-режиме сразу возвращает `job_id`
- `GET /v1/jobs/{id}` · **`GET /v1/jobs/{id}/events`** — SSE (`?access_token=` для EventSource)
- `GET /v1/conversations` · `GET /v1/conversations/{id}/messages`
- `GET /v1/collections` · `GET /v1/collections/{slug}/entities` · `GET /v1/stats`
- `POST /v1/blobs` — загрузка файла (лимит `MAX_UPLOAD_BYTES`, владение по пользователю)
- `POST /v1/channels/telegram/link-code|webhook` · `POST /v1/channels/slack/link-code|events`
- **`POST /mcp`** — Model Context Protocol (`initialize`, `tools/list`, `tools/call`)

## Архитектура

```
mobile / web / Telegram / Slack / MCP-клиент
        │
        ▼
FastAPI ──► IngestionEnvelope ──► process_envelope
   │                                  │
   │ (MESSAGE_MODE=queue)             ▼
   └──► InProcessRunner ──► run_agent (tool loop, история, streaming)
                                 │        │
                                 ▼        ▼
                          доменные плагины   hybrid RAG (chunks + эмбеддинги)
                                 │
                                 ▼
              KB: Collection / Entity / Observation / Blob / ChatTurn / …
```

Ключевые модули: `app/agent` (оркестратор, история), `app/rag` (чанкинг, гибридный поиск), `app/queue` (очередь, EventBus), `app/channels` (telegram, slack), `app/domains` (automotive, medical_labs), `app/mcp`, `app/scheduler` (напоминания), `evals` (golden set).

## Переменные окружения

Смотрите [.env.example](.env.example): `JWT_SECRET`, `DATABASE_URL`, `PIA_AGENT_SECRET` (Fernet-ключ), `MESSAGE_MODE`, `TELEGRAM_*`, `SLACK_*`, `REMINDERS_*`, `LLM_ALLOW_LOCAL_FALLBACK` + `FALLBACK_*`, `RATE_LIMIT_AUTH_PER_MINUTE`, `LOG_FORMAT=json`.

## Статус и roadmap

- ✅ Фаза 0 — зелёные тесты, CI, Docker, Alembic, security hardening
- ✅ Фаза 1 — память диалогов + гибридный RAG
- ✅ Фаза 2 — фоновая очередь, SSE, web-чат, проактивные напоминания
- ✅ Фаза 3 — MCP, Slack, medical_labs, evals, наблюдаемость
- 🔜 Далее: pgvector для масштабирования поиска, ARQ/Redis-runner для multi-instance, WhatsApp/Discord-каналы, кросс-рольные ACL, vision для любых фото в чате, STT (Whisper) для голосовых

## Автор

Panasenkof
