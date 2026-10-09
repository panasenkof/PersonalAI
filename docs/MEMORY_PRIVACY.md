# Personal memory privacy — phase 4

## Default policy (deny cloud egress)

This phase adds explicit, owner-controlled collection permissions and enforcement
in the PersonalAI agent and RAG egress paths.

- New collection flags: `allow_cloud_llm=False`,
  `allow_remote_embeddings=False`. Historical collections do **not** opt in.
- New LLM flag: `cloud_history_access=False`: prior conversation turns
  aren't automatically sent to remote chat models without consent.
- `unclassified` and `secret` collections cannot receive cloud grants.
  The owner must classify a collection as `standard` or `sensitive`.
- The authenticated owner can view/update each collection's sensitivity
  and grants via `GET /v1/privacy/collections` and
  `PUT /v1/privacy/collections/{slug}`, and choose chat history consent via
  `GET|PUT /v1/privacy/conversation`.
- Sensitive/secret entity or observation overrides are **not** disclosed to
  cloud models even if their enclosing collection is granted.
- Cloud agent sessions only expose `kb_search` and `kb_list_entities`,
  filtered to explicitly granted collections; all domain tools, document
  ingestion and memory writes are denied in remote-tool sessions for now.
- When no collections are granted, no knowledge tools are sent to the cloud
  model. User-authored text is still passed to the **chosen cloud** model.
- Cloud query embeddings (free-text memory search terms) are always disabled.
  Cloud entity/document indexing embeddings are only allowed where the
  specific collection has `allow_remote_embeddings=True`. Local-loopback
  embeddings continue working without remote consent.
- Local→cloud fallback is disabled for tool-capable agent turns (where tool
  result/history could leave the device). This is intentional even when the
  operator's fallback flag is enabled.
- A model advertising itself as `local` but using a non-loopback endpoint
  is handled like a remote endpoint. Self-hosted LAN/remote models will need
  a separate explicit trust configuration before being treated as local.

## What this phase does NOT guarantee

This is an incremental enforcement boundary for managed memory, **not a
complete data-loss prevention system**. Text intentionally typed or supplied
to a cloud model can contain private information; attachments sent to STT,
OCR/vision tools, third-party messengers, email or direct API/MCP tools can
have separate egress paths. Local-network endpoints can also proxy requests.
Do not claim this prevents every transmission of personal information.

Cloud grant changes affect new operations, not content already uploaded to a
third party. Existing cloud embeddings are not automatically deleted or
invalidated on revoke: audit/reindexing, export redaction, direct MCP scopes,
fine-grained per-tool grants and STT/vision policies require additional work.

## Deployment

Alembic `p4e9a6b8c010` follows `n3d8f5a7b009`. Execute
`alembic upgrade head` before running the new backend in production.
The migration is additive: it does not alter existing entity/observation
payloads or IDs. No new remote permissions are inferred for legacy users.

## Tests

`pytest tests/test_memory_privacy.py tests/test_rag.py tests/test_memory_repository.py -q`
and all CI checks (SQLite, PostgreSQL, migrations, Windows, web and mobile).
