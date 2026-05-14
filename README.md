# PIA Agent — персональный ИИ и база знаний

Платформа из [docs/PLATFORM_SPEC.md](docs/PLATFORM_SPEC.md): мультимодальный ввод (текст, изображения, аудио-заглушка STT), каналы **HTTP API** (мобильное приложение) и **Telegram**, выбор **облачной или локальной** OpenAI-compatible LLM в настройках, доменные плагины (**automotive** MVP, **medical_labs** заготовка).

## Backend (FastAPI)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set JWT_SECRET=your-long-random-secret
set DATABASE_URL=sqlite+aiosqlite:///./pia.db
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Опционально Postgres/Redis: `docker compose up -d` в корне репозитория, затем `DATABASE_URL=postgresql+asyncpg://pia:pia@localhost:5432/pia`.

Переменные окружения: `PIA_AGENT_SECRET` (Fernet-ключ для шифрования API-ключей LLM), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `BLOB_STORAGE_DIR`.

### API (кратко)

- `POST /v1/auth/register`, `POST /v1/auth/token`
- `GET/PATCH /v1/settings/llm` — облако или локальный `base_url` (Ollama/LM Studio)
- `POST /v1/blobs` — загрузка файла → `storage_key`
- `POST /v1/messages` — текст + вложения (`attachments[]`)
- `GET /v1/jobs/{id}`
- `GET /v1/collections`, `GET /v1/collections/{slug}/entities`
- `POST /v1/channels/telegram/link-code`, `POST /v1/channels/telegram/webhook`

### Тесты

```bash
cd backend
pytest tests/ -v
```

## Mobile (Expo)

```bash
cd mobile
npm install
set EXPO_PUBLIC_API_BASE=http://YOUR_LAN_IP:8000
npx expo start
```

## Автор

Panasenkof
