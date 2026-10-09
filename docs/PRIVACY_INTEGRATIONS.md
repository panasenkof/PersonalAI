# Integration privacy completion — phase 4.2

Introduced by migration `q5f0b7c9d011` (after `p4e9a6b8c010`).
All existing users/collections default to deny for new permissions.

## Owner controls (web, Expo mobile and REST)

- Collection: `allow_cloud_llm`, `allow_remote_embeddings`,
  `allow_remote_extraction` (external OCR/vision/structured text processing
  and third-party vehicle lookup), `allow_messenger_reminders`
  (scheduled messages containing memory). Unclassified/secret collections
  cannot opt in to these egress paths.
- Global: `cloud_history_access`, `allow_remote_stt` (remote audio
  transcription), `allow_mcp_access` (authenticated MCP tool execution).
- Endpoints: `GET/PUT /v1/privacy/collections[/<slug>]`,
  `GET/PUT /v1/privacy/conversation`, `GET/PUT /v1/privacy/integrations`.
  Owner JWT required for every mutation.

## Enforced boundaries

- Remote STT is *never* called for a user's audio without their explicit
  global consent. Loopback Whisper-compatible STT remains available.
- Before sending full service-receipt images or lab reports to a remote
  vision/structured extraction provider, both the owner and collection must
  permit external processing. Record-specific overrides of `sensitive` or
  `secret` block transmission when the target entity is known.
- External automotive lookups disclose vehicle characteristics to a search
  engine, so the vehicle's collection must explicitly grant extraction/lookup.
- MCP tool calls require an authenticated user **and** global MCP permission;
  the same JWT without permission is rejected. Once enabled, MCP clients
  have broad access to that user's tools; enable only for trusted clients.
- Scheduled vehicle maintenance reminders are sent to Telegram/MAX only
  when the relevant collection explicitly allows it.
- On disabling remote embeddings, the database clears local stored vector
  columns (including vectors produced locally) for that collection while
  retaining searchable text. The external embedding provider may already
  have received and retained prior inputs; this action **cannot** remotely
  delete third-party data.
- Revoked cloud LLM collection grants are rechecked for each read/tool
  execution, not merely once at agent startup. Previously emitted model
  context cannot be recovered from a remote provider.

## Known limits and further work

- Telegram/MAX and other messaging *inbound/outbound chat* is the user's
  selected communication medium. The platform necessarily sees messages the
  user sends and assistant replies. The per-collection reminder permission
  controls only **proactive scheduled memory disclosures**, not chat messages.
  Future message-channel-scoped policies may redact tool results or withhold
  sensitive references from a messenger conversation.
- Direct user-provided chat text can reach the chosen cloud LLM even if all
  memory collection flags are off. This version does not implement general
  outbound DLP or cryptographic attestation of a supposedly local endpoint.
- PDF extraction on the server uses local pypdf; no external OCR is called
  unless a guarded image/vision handler is used. No arbitrary third-party
  plugins are automatically covered; new handlers need their own policy tests.
- Account exports already require password (and OTP when enabled) and
  contain sensitive plaintext data for the account owner. They must never
  be uploaded to third-party services without separate consent.
- Revocation does not cancel an in-flight LLM request or force remote
  deletion. It governs the next checked operation.
- The interface requires an explicit **Save** for collection permissions.
  Global permission changes are saved through the dedicated controls.

## Verification

`pytest tests/test_privacy_integrations.py tests/test_memory_privacy.py tests/test_mcp.py tests/test_reminders.py tests/test_upgrade.py -q`

Also run all SQLite and PostgreSQL regression suites, web browser acceptance,
mobile Jest/typecheck, production recovery and final CI gate.
