# Memory graph and revision history — phase 3

Builds on MemoryRepository (phase 2). The existing `Collection / Entity /
Observation` records remain the current-value store and preserve existing
payload formats, IDs, RAG tools, and API endpoints.

## Relationships

`memory_relations` represents a directed, typed edge between two entities
belonging to the *same user*, even across different collections. It stores
`source_entity_id`, `target_entity_id`, `kind` and optional evidence
`source_kind/source_ref`. User-scoped repository methods validate both
endpoints; the database rejects self-links and duplicate identical edges.
`relations_for_entity` returns incoming and outgoing edges. Relations are
deleted on hard deletion of either endpoint.

Relation kinds are lowercase ASCII `[a-z][a-z0-9_]{0,63}`, for example
`has_receipt`, `owns`, `belongs_to` or `related_to`. Reverse edges and
inverse naming are deliberately *not* inferred automatically.

## Correcting personal memory

`entities.record_version` and `observations.record_version` default to 1.
Older rows receive version 1 when upgrading. This is a version baseline, **not
a claim that we know the earlier change history**.

`revise_entity` and `revise_observation` use an atomic compare-and-swap on
`(user_id, id, record_version)`. The caller supplies the expected version,
complete replacement payload, a nonempty reason and optional actor kind.
Edits create `memory_revisions` with before/after snapshots and increment
`record_version`. Entities can also transition among record statuses:
`active`, `archived`, `superseded`. Observation `occurred_at` is
unchanged by correcting its payload.

A stale expected version returns `MemoryConflictError("stale_memory_version")`.
An inaccessible record returns `MemoryAccessError`. All changes and revision
rows participate in the *caller's existing transaction*; the repository neither
commits nor reindexes automatically. Consumers must trigger RAG reindexing on
successful edits when the payload changed. Maintenance schedule approval is the
first migrated production consumer; repeated approval is idempotent.

`memory_revisions` retains full before/after snapshots (including source
metadata) and has FK cascades to the subject, so a hard delete removes its
history. Snapshots are held in `EncryptedJSON`; they are encrypted when
`PIA_AGENT_SECRET` is configured, as elsewhere in PersonalAI. Without the
key, the existing development fallback writes plaintext JSON; production
must configure disk/database encryption for the main memory tables too.

## Compatibility and limitations

- Migration `n3d8f5a7b009` follows `m2c7e4f6a008`. It adds two
  defaulted integer columns and two new tables. Old payloads are untouched.
- Account ZIP exports include graph edges and revisions; account deletion
  removes them through the existing owner-based deletion path.
- These *opt-in repository operations* capture corrections performed through
  the repository. Existing direct SQLAlchemy edits outside the new revision
  methods are not automatically journaled. Other domain handlers must be
  migrated deliberately before claiming comprehensive revision coverage.
- A revision is not a CRDT and does not provide multi-device synchronization.
  Relation/source labels are metadata, not permission enforcement.
- A future privacy policy must restrict who can read full historical snapshots
  and must respect the stricter sensitivity among linked entities.
- The API for user-facing browsing/editing relations and corrections is not
  added here; public mutation endpoints require authorization and input
  validation policies before exposure.

## Verification

`pytest tests/test_memory_graph.py tests/test_memory_repository.py tests/test_upgrade.py -q`

Run the full CI matrix (SQLite/PostgreSQL, mobile/web, Windows,
production backup restore and existing golden agent scenarios).
