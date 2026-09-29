# Platform specification (core)

## Goals

Universal personal knowledge base and AI agent: multimodal input (text, image, audio) via Telegram and mobile app; routing to local or cloud OpenAI-compatible LLM per user settings; persist to user-isolated KB or answer in chat; explicit user feedback (saved vs answer).

Automotive is the first product domain plugin; medical labs is a stub for future extension.

## Channels

| Channel | Auth | Notes |
|---------|------|--------|
| Mobile | JWT bearer (`Authorization: Bearer`) | Same `/v1/messages` API |
| Telegram | Webhook secret + linked `telegram_user_id` | Link code pairs chat to user; photos, documents/PDF, voice, inline confirm buttons |
| Slack | HMAC signature + linked `slack_user_id` | Files, threads (conversation per thread), Block Kit confirm buttons |
| WhatsApp | Cloud API webhook, `X-Hub-Signature-256` | Media, reply buttons |
| Discord | Interactions endpoint, Ed25519 | Slash commands `/ask` `/link` `/stop` `/new`, buttons |

See [CHANNELS.md](CHANNELS.md). Scaling/queue/search: [SCALING.md](SCALING.md). Security: [SECURITY.md](SECURITY.md).

All channels normalize to `IngestionEnvelope` (text, attachments with MIME and storage ref, `channel`, `correlation_id`, optional `locale`).

## Message types and ingestion lifecycle

1. **Accepted** — API returns `job_id`.
2. **Processing** — STT for audio, optional vision/OCR for images, then agent.
3. **Awaiting_confirm** — facts extracted from photos/PDF wait for the user's confirm/reject (`CONFIRM_EXTRACTED_FACTS`); buttons in every channel, `POST /v1/facts/{id}/confirm|reject`.
4. **Completed** — final assistant message + side effects (KB commit) recorded.
5. **Failed** — error code and safe message (after `JOB_MAX_ATTEMPTS`; jobs interrupted by a restart are re-queued, not failed).
6. **Cancelled** — user pressed Stop (`POST /v1/jobs/{id}/cancel`, `/stop` in messengers); the partial answer is kept.

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
- **Chunk** — text chunk + embedding for RAG; `embedding_vec vector(N)` with an HNSW index on Postgres (pgvector), JSON embedding on SQLite.

RAG retrieval uses only **committed** facts and entity payloads unless tool explicitly queries drafts.

## Privacy

- Row-level isolation by `user_id`.
- Minimize PII in logs; never log raw API keys.
- Disclaimers: informational only; not a substitute for mechanics or clinicians.

## API surface (HTTP)

- `POST /v1/auth/register` — create user + returns token
- `POST /v1/auth/token` — login
- `GET/PATCH /v1/settings/llm` — LLM configuration
- `POST /v1/messages` — submit envelope (`MESSAGE_MODE=queue`: returns `job_id`; `sync`: answer inline)
- `GET /v1/jobs/{job_id}` · `GET /v1/jobs/{job_id}/events` (SSE) · `POST /v1/jobs/{job_id}/cancel`
- `GET /v1/facts`, `POST /v1/facts/{id}/confirm|reject`
- `POST /v1/channels/{telegram|slack|whatsapp|discord}/link-code` — issue link code for pairing
- `POST /v1/channels/telegram/webhook` — Telegram webhook (configure `TELEGRAM_WEBHOOK_SECRET`)
- CRUD under `/v1/collections`, `/v1/entities`, `/v1/observations` for clients

## Automotive domain (MVP scope)

- Vehicles as entities (`domain=automotive`, type in payload).
- Service events as observations + optional blob attachments.
- Maintenance schedule candidates from web fetch (httpx) with `source_url`, `status=draft|approved`.
- `compute_next_due` tool: deterministic from approved schedule + last observations.
