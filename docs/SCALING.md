# Масштабирование, очередь, поиск, надёжность

## Топология production

```
клиенты ──► app (N реплик, uvicorn) ──enqueue──► Redis ◄──consume── worker (M процессов)
               │  ▲ SSE / Stop                      │ pub/sub: события джоб, отмена
               ▼  └───────── Redis pub/sub ◄───────┘
        Postgres + pgvector  (джобы, история, KB, эмбеддинги)
```

`docker compose up -d --build --scale app=2 --scale worker=4` — API и воркеры масштабируются независимо.

| Режим | Настройки | Когда |
|---|---|---|
| dev / один инстанс | `MESSAGE_MODE=sync` или `queue` + `QUEUE_BACKEND=inprocess` | ноутбук, тесты |
| production | `MESSAGE_MODE=queue`, `QUEUE_BACKEND=redis`, `REDIS_URL=…`, `EMBEDDED_WORKER=false` на API, отдельные `python -m app.worker` | несколько реплик |

### Персистентная очередь
* Каждая джоба — строка `ingestion_jobs` (Postgres) **и** запись в Redis-очереди. Источник истины — БД.
* Воркер забирает джобу атомарно (`BLMOVE` в список «processing» + heartbeat). Если процесс умер, «застрявшие» джобы
  (нет heartbeat дольше `JOB_STALE_SECONDS`) возвращаются в очередь другим воркером; повторная постановка защищена compare-and-set
в БД, поэтому несколько reaper'ов и долгий backlog не размножают сообщения в очереди. При graceful-остановке воркер сам возвращает
джобу (`processing → accepted`) без траты попытки, а при недоступности Redis на приёме джоба остаётся в БД и подхватывается позже — **при рестарте джоба не уходит в `failed`**.
* Повторы: до `JOB_MAX_ATTEMPTS`; после — `failed` с понятным текстом. Идемпотентность по `correlation_id`
  (повторная доставка вебхука платформы не создаёт дубль).
* При старте `InProcessRunner` тоже подбирает незавершённые джобы из БД (`accepted`/`processing`).
* Готовность: `GET /ready` (БД + Redis); `Dockerfile` содержит `HEALTHCHECK`.

### События и отмена между процессами
* Прогресс (`status`, `token`, `tool_call`, `tool_start`, `tool`, `done`, `cancelled`, `error`) публикуется в Redis pub/sub
  (`EventBus`), SSE-эндпоинт любой реплики отдаёт поток; если джоба уже завершена, эндпоинт отдаёт финальное состояние из БД.
* «Стоп»: `POST /v1/jobs/{id}/cancel` (веб/мобайл) или `/stop` (Telegram/Slack/Discord/WhatsApp) → флаг + Redis-сигнал; воркер,
  держащий джобу, отменяет asyncio-задачу. Частичный ответ сохраняется в историю с пометкой `…[остановлено]`.

### Поиск (pgvector)
* На Postgres вектор пишется в `chunks.embedding_vec` (`vector(PGVECTOR_DIMENSIONS)`, HNSW-индекс, cosine); JSON-эмбеддинг
  не хранится. Размерность модели ≠ `PGVECTOR_DIMENSIONS` → чанк остаётся в JSON-колонке (SQLite/dev-путь), поиск не ломается.
* Запрос гибридный: векторный top-K (`<=>`) + текстовый (`ILIKE` по тексту чанка) → слияние **RRF**. Ответ помечает, чем найдено
  (`source: vector|text`).
* Перенос существующих данных: миграция `c3a1f0d2b7e4` переносит JSON-эмбеддинги в `embedding_vec`; `python -m app.rag.reindex`
  повторяет перенос для оставшихся/импортированных строк (идемпотентно), индексирует сущности без чанков, а `--force` пере-эмбеддит всё
  (после смены модели эмбеддингов).
* SQLite (dev) — косинус в Python, как раньше.

### Запуск нескольких реплик
* `init_db()` выполняется под `pg_advisory_xact_lock`, поэтому одновременный первый старт нескольких API/воркеров не гоняется за DDL.
* Планировщик напоминаний работает в каждой реплике API, но строка `ReminderNotification` «занимается» (unique) **до** отправки —
  сообщение уходит ровно один раз. Для тяжёлых установок можно оставить `REMINDERS_ENABLED=true` только на одной реплике.
* Подтверждение факта берёт блокировку строки (`SELECT … FOR UPDATE`): двойное нажатие (веб + Telegram) создаёт одну запись.

### Надёжность внешних вызовов
* Все исходящие HTTP (LLM, эмбеддинги, STT, Telegram/Slack/WhatsApp/Discord) идут через `app.net.request_json`: retry с
  exponential backoff + jitter (`HTTP_RETRY_*`), уважает `Retry-After`, ретраит 429/5xx/сетевые ошибки, не ретраит 4xx.
* LLM: семафор `LLM_MAX_CONCURRENCY` на процесс + квота на пользователя `RATE_LIMIT_LLM_PER_MINUTE` (429 `rate_limited` + `Retry-After`
  для веба, вежливое сообщение в каналах). При `REDIS_URL` лимитеры общие для всех реплик (fixed-window в Redis), иначе in-process.
* Фолбэк на облачный endpoint — только с `LLM_ALLOW_LOCAL_FALLBACK=true`.

## Обновление существующей установки

```bash
cd backend
# БД создана раньше через create_all (без alembic_version)? Один раз:
alembic stamp ba2c8c4f76cd
alembic upgrade head            # роли/2FA (+защита от replay TOTP), token_version, факты, pgvector, статусы джоб …
python -m app.rag.reindex       # (Postgres) перенос эмбеддингов в pgvector
python -m app.security.rekey    # после включения/ротации PIA_AGENT_SECRET
```

Postgres должен быть с расширением `vector` (образ `pgvector/pgvector:pg16`; миграция делает `CREATE EXTENSION IF NOT EXISTS vector`,
для этого нужны права суперпользователя или предустановленное расширение).

## CI и evals

* `ci.yml`: `backend` (ruff, mypy, pytest на SQLite, scripted evals, alembic smoke), `backend-postgres` (pgvector + Redis
  сервисы, весь набор тестов на Postgres, `tests/redis_smoke.py` на настоящем Redis), `mobile` (tsc + jest).
* `evals-live.yml`: **live-evals с настоящей LLM** — ночью (cron), при изменениях `agent/domains/llm/rag/evals`, вручную
  (`workflow_dispatch`: `runs`, `model`). Нужен секрет `EVAL_LLM_API_KEY`, опционально переменные репозитория
  `EVAL_LLM_BASE_URL`, `EVAL_LLM_MODEL`, `EVAL_EMBEDDING_MODEL`. Без секрета шаг честно пропускается (в отчёте — SKIPPED).
  Каждый кейс прогоняется `--runs N` раз; порог `--min-pass-rate` (по умолчанию 0.8 для live, 1.0 для scripted). Оценка live —
  по траектории инструментов (ожидаемые ⊆ вызванных, `forbid_tools`), по post-condition проверкам БД и по ключевым словам
  ответа; markdown-отчёт пишется в Job Summary, JSON — артефактом `evals-live-report.json`.
* Локально: `python -m evals.runner --live --runs 3 --min-pass-rate 0.8`.
