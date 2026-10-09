# MemoryRepository — phase 2

The PersonalAI backend now contains a persistence-independent Python memory contract.

## Layers and files

- app/memory/contracts.py: detached CollectionRecord, EntityRecord, ObservationRecord,
  NewCollection, NewEntity, NewObservation and MemoryPage. Standard library only.
- app/memory/repository.py: MemoryRepository Protocol, with no SQLAlchemy dependency.
- app/memory/sqlalchemy.py: session-bound SQLAlchemy implementation.
- app/agent/universal_tools.py, app/api/v1/collections.py and
  app/services/facts.py: first production consumers of the new repository.
- app/rag/indexing.py: indexing accepts repository records as well as old ORM models.

## Core invariants

1. The repository is instantiated for a single authenticated user ID. No public
   query can read another user's collections, entities or observations. Creating a
   child record validates that its parent is owned by the same user.
2. No repository method calls commit. Writes flush in the caller's transaction.
   The agent's nested savepoints, rejection of facts and failure rollback remain
   effective; search indexing is invoked by the caller after successful writes.
3. ORM objects never cross the repository boundary. JSON payloads are deep-copied;
   a caller changing a returned record's nested JSON cannot mutate the DB session.
4. The existing API JSON response shapes, tool names, payloads, IDs and RAG chunks
   are unchanged. No Alembic migration is needed in this phase.
5. Legacy memory records with absent v2 metadata are returned with their recorded
   NULL/default values. There is no inferred evidence, date or confidence.
6. Limit is 1..100; offset >= 0. Sorted paging is stable by timestamps and ID.
7. Collection slug uniqueness is currently checked in application code only; no
   cross-session uniqueness index was added. Do not rely on this for concurrent
   independent collection creation without a future database constraint.

## Non-goals and next steps

The Python protocol is not itself a mobile-compatible executable library or a
wire format. The next phases will define a language-neutral JSON schema, link and
revision records, synchronization semantics, and privacy enforcement. The adapter
does not automatically block a cloud model or encrypt Entity/Observation payloads;
the existing security model still applies. Do not enable cloud access to private
memory based only on the sensitivity label.

Domain-specific handlers still using AsyncSession will be migrated gradually,
once repositories for their specialized records are introduced. This keeps the
existing Automotive and Medical Labs tools usable throughout the refactor.

## Verification

Run pytest tests/test_memory_repository.py tests/test_memory_v2.py
and the full CI matrix for SQLite, PostgreSQL, RAG, agent, web/mobile, Windows,
migration and backup regression checks.
