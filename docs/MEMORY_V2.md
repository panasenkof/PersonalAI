# Personal memory v2 — additive schema, phase 1

This change extends the existing `Collection → Entity → Observation` schema without replacing
record identifiers, JSON payloads, domains, API responses, RAG chunks or conversation history.
It is a **storage foundation**, not a new agent or privacy-enforcement engine.

## Added columns

| Table | Fields | Purpose |
|---|---|---|
| `collections` | `description`, `sensitivity` | Optional description and collection-level classification |
| `entities` | `title`, `record_status`, `sensitivity`, `valid_from`, `valid_until`, `source_kind`, `source_ref`, `updated_at` | Human-friendly title, record lifecycle, time scope, provenance |
| `observations` | `sensitivity`, `valid_from`, `valid_until`, `source_kind`, `source_ref`, `confidence` | Time scope, provenance and optional confidence |

The existing `occurred_at` remains the date **an event happened**, while
`valid_from/valid_until` describe when a stated fact is considered applicable.
Neither is inferred for imported legacy records. Dates are UTC-aware in application code;
SQLite may store timestamps without retaining timezone information.

`source_kind` is an optional future provenance type (e.g. `user`, `document`,
`tool`, `import`, `derived`); `source_ref` is a reference to the actual source.
It is **not** a URL that may be fetched without authorization. Existing records have
`NULL` source and confidence; we do not invent evidence.

`record_status` describes the entity **record** (`active`, `archived`,
`superseded` planned), not whether the real-world object is current or owned.
A true validity history still requires a subsequent revision/event model.

## Sensitivity

Suggested labels: `unclassified`, `standard`, `sensitive`, `secret`;
entities and observations may also use `inherit` to refer to the parent.
Old collections become `unclassified`; old entities and observations become
`inherit`. New Garage and Health collections are labelled `standard` and
`sensitive` respectively.

**These are labels only. No new access control is implemented by this migration.**
A future policy engine MUST treat `unclassified` conservatively, apply the stricter
of parent and child policies, and check all outgoing model, embedding, search, export
and tool calls. In particular do not treat `standard` as permission to upload data.

## Compatibility and rollout

- Migration: `m2c7e4f6a008`, after the merged `k1a6d2e4f005` Alembic head.
- No existing column is renamed or dropped; existing insert handlers continue to work.
- New non-null labels have server defaults, including for legacy SQL-only writers.
- Old `payload`, `domain`, `schema_version`, `Collection.slug`, record IDs and
  conversation/RAG APIs are unchanged; legacy storage semantics remain the source of truth.
- The `updated_at` entity field is `NULL` for historical rows until a future ORM
  update. It must not be interpreted as the last known historical modification time.
- Run `alembic upgrade head` **before** rolling out backend code using these ORM fields.
  SQLite developers using `create_all` must also migrate existing databases; it
  cannot add columns to an existing table.
- `alembic downgrade k1a6d2e4f005` discards **new metadata**; take a backup first.
- This phase does not auto-extract provenance, build cross-collection entity relations,
  deduplicate memories, increment revisions, do bidirectional sync, or change user API
  schemas. Those are follow-on phases with separate testable contracts.

## Regression checks

- Server-created legacy entities and observations remain writable and searchable.
- New metadata persists through SQLAlchemy.
- Populated SQLite/Postgres at `k1a6d2e4f005` upgrade to `head` without rewriting
  the old vehicle/event JSON or inventing timestamps, confidence or source.
- Both historical Alembic branches for MAX and daily quotas converge to the new head.
