# M4-UX U-M2/U-M3 — source-backed temporal candidates in existing person card

Status: implemented in PR, **C1 exact SHA CI pending; physical Android C2 NOT RUN**. Single canonical queue `PLAN.md §2`, existing `Plans/MEMORY_ENGINE_UI.md`. This document is a narrow UI contract, not a second roadmap.

## C0-A
The temporal claim/evidence/decision system already lives in SQLCipher `memory_temporal_claims`, `memory_temporal_evidence`, canonical `MemoryRepository.temporalKnowledgeHistory()`, keyed access filters, and `MemoryTemporalReviewScreen` for user decisions. `MemoryNoteScreen` exposes note revisions and observations but not a source-backed temporal timeline for a person. The reader marks every entry `candidate_unconfirmed`; do not claim “current confirmed” or silently reinterpret dates. No new reader, writer, index, relation graph, or route.

## Behaviour
An opt-in “Периоды и события” section in existing Nebula person note (only standard collection + active standard/inherit record), with All / States / Events, bounded 10-per-page keyset, separate raw valid date and date recorded, event vs state, planned label, unconfirmed state, direct evidence quote and an explicit source-open control. Before navigation revalidate source entity version, active status, same collection and standard ACL. Lock/profile changes clear visible data and invalidate pending async work. No asserted exact time if precision is unknown. Sources are scoped to the current collection; lack of results does not imply lack of data elsewhere.

## Negative scenario gates
TIME-01/02/05/08, CAR-01, SEARCH-03, SEC-04/06/08: an event in 2023 does not disappear after event in 2025, upload in 2026 does not change occurrence date, future planned does not become current, uncertain spring date never becomes 1 March, secret or stale source never opens from cached preview, AppLock cancels. Jest UI tests validate presentation and cancellation; SQL-backed temporal unit tests validate canonical reader. Full agent answer/confirmed-current and physical C2 are OPEN.

## C3-B
One screen composition of an existing source-backed reader; no additional storage or search path, user decision writer or background inference. This is a partial M4-UX UI slice, not general fact confirmation or 96-scenario full PASS. C3 consolidation remains at step 6.5 after M1–M4 and applicable acceptance.
