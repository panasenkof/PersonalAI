# Memory temporal claims — T1a deterministic contract

**Status:** implementation slice of №72.1 / PLAN §2 step 6. Not shipped as a
user-facing feature; no claim data written until T1b. Related:
[temporal model](../../../Plans/TEMPORAL_MEMORY.md),
[relational model](../../../Plans/RELATIONAL_MEMORY.md),
[reliability](../../../Plans/MEMORY_RELIABILITY.md).

## Problem and boundary

Current SQLCipher v10 stores notes, observations, revisions, relations, and
source extractions, but does **not** store multiple time-typed statements and
their independent evidence/decision history. Updating the note's status or
adding a flat is_current flag would erase distinctions between actual
events, current states, corrections, and unknown dates.

T1a adds a pure TypeScript candidate/validation/comparison contract, not a
second storage or search pipeline. It explicitly separates:

- event, state, observation, enduring; asserted, planned,
  hypothetical; negation, cardinality and context/role
- known day/month/year from approximate or unknown dates, preserving
  original text, anchor and time zone; unknown normalized date = null
- direct versioned source evidence from derived LLM interpretations
- potential change, reconfirmation, unresolved identity, independent facts

The compareTemporalCandidates function is a **pure proposal classifier**. It
cannot modify the previous claim, close a period, index a record, or accept
an LLM interpretation as user confirmation. A possible_change requires
resolved identity, equal property and role, explicitly single-valued context,
positive direct asserted statements, and an unfinished old state. Parallel
jobs and addresses are legal. New timestamp/order-of-import cannot end older
events.

## C1 — synthetic executable cases in T1a

Jest tests include two service events and backdated receipt; primary versus
secondary job; registration versus actual residence; plans, hypothetical
claims, negation, derived evidence; two same-name persons; unknown end,
invalid calendar date/precision, origin/version assertions; measurements and
enduring attributes. Native Android/SQLCipher migration/backup/restore are
**NOT TESTED by T1a**. CI on exact SHA required after PR creation.

## T1b durable staging (separate PR, C1/Android pending)

T1b introduces v11 SQLCipher tables for claim/evidence/proposal/decision and versions, a source-version-checked staging API, and strict backup v2 manifest counts for each new user-owned table. Earlier manifests and v1–v10 archives remain supported. The current source and quote are committed together; proposals are only staged and do not apply transitions. Full ACL-scoped T3 reads and UI are not implemented. T1b must verify fault rollback, old schema restore and source freshness on its exact commit SHA. Jest tests and native run are pending. Do not add a schema version number
before the migration is implemented and tested. Atomic apply/undo CAS,
deduplicated proposals, source invalidation, privacy-scoped lookup and
approval UI belong in T2; current/history/list/count with provenance in T3.
Do not label any of these complete by merging T1a alone.

## C2 — deviations from plan

- MATCH: contract preserves the knowledge-kind and dual-time distinctions,
  unknown dates, direct-vs-derived source, bounded property/context logic.
- PARTIAL: T1b durable schema/staging, migration and backup code proposed; exact-SHA C1 and native proof pending. OPEN: approval actions/CAS/undo, UI, history, ACL-scoped retrieval and device proof.
- No automatic closure/deletion, external upload or evidence fabrication.

## C3 — architecture consolidation

NO CHANGE NEEDED: one standalone pure contract plus Jest tests, no database,
FTS, adapter, background worker, transport, native dependency or UI tree added.
Global architectural consolidation stays deferred until base Memory Engine
M1–M4 and C1/C2 acceptance per PLAN §2 checkpoint 6.5.
