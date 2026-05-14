# Platform specification (core)

## Goals

Universal personal knowledge base and AI agent: multimodal input (text, image, audio) via Telegram and mobile app; routing to local or cloud OpenAI-compatible LLM per user settings; persist to user-isolated KB or answer in chat; explicit user feedback (saved vs answer).

Automotive is the first product domain plugin; medical labs is a stub for future extension.

## Channels

| Channel | Auth | Notes |
|---------|------|--------|
| Mobile | JWT bearer (`Authorization: Bearer`) | Same `/v1/messages` API |
| Telegram | Webhook + linked `telegram_user_id` | Deep link / link code pairs chat to user |

All channels normalize to `IngestionEnvelope` (text, attachments with MIME and storage ref, `channel`, `correlation_id`, optional `locale`).

## Message types and ingestion lifecycle

1. **Accepted** — API returns `job_id`.
2. **Processing** — STT for audio, optional vision/OCR for images, then agent.
3. **Awaiting_confirm** — extracted facts need user confirmation (optional flow).
4. **Completed** — final assistant message + side effects (KB commit) recorded.
5. **Failed** — error code and safe message.

## LLM settings (per user)

- `provider_kind`: `cloud` | `local`
- `base_url`: OpenAI-compatible base (e.g. `https://api.openai.com/v1` or `http://host:11434/v1`)
- `api_key`: optional for local; required for typical cloud providers (stored encrypted at rest when `PIA_AGENT_SECRET` set)
- `default_model`, optional `embedding_model`
- `supports_vision`: hint for UI/routing; runtime may fallback to OCR text path

Fallback cloud when local fails: **disabled by default** (`LLM_ALLOW_LOCAL_FALLBACK=false`).

## Knowledge base (domain-agnostic)

- **Collection** — user-owned container (e.g. Garage, Health).
- **Entity** — `domain`, `schema_version`, JSON `payload`, `collection_id`.
- **Observation** — time-bound event linked to entity (service visit, lab upload).
- **Blob** — object storage key, checksum, mime.
- **ExtractedFact** — LLM draft JSON, status `pending_user_confirm` | `committed`.
- **Chunk** — text chunk + embedding vector for RAG (optional; pgvector when enabled).

RAG retrieval uses only **committed** facts and entity payloads unless tool explicitly queries drafts.

## Privacy

- Row-level isolation by `user_id`.
- Minimize PII in logs; never log raw API keys.
- Disclaimers: informational only; not a substitute for mechanics or clinicians.

## API surface (HTTP)

- `POST /v1/auth/register` — create user + returns token
- `POST /v1/auth/token` — login
- `GET/PATCH /v1/settings/llm` — LLM configuration
- `POST /v1/messages` — submit envelope (sync processing in MVP for simplicity; async field reserved)
- `GET /v1/jobs/{job_id}` — job status (stub compatible with future queue)
- `POST /v1/channels/telegram/link` — issue link code for Telegram pairing
- `POST /v1/channels/telegram/webhook` — Telegram webhook (configure `TELEGRAM_WEBHOOK_SECRET`)
- CRUD under `/v1/collections`, `/v1/entities`, `/v1/observations` for clients

## Automotive domain (MVP scope)

- Vehicles as entities (`domain=automotive`, type in payload).
- Service events as observations + optional blob attachments.
- Maintenance schedule candidates from web fetch (httpx) with `source_url`, `status=draft|approved`.
- `compute_next_due` tool: deterministic from approved schedule + last observations.
