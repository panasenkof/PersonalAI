# №72.3 T3b1 — valid-time state candidates with explicit uncertainty

## Purpose
A user may ask "Where did I live in July 2022?" or "Which employer was current in 2025?". T3a lists recorded-time history but cannot filter a single typed predicate+context and evaluate declared valid-time boundaries. This stage delivers a safe **read-only candidate** API, not an asserted answer or a historical knowledge-snapshot engine.

## Data and API
- `listTemporalStateCandidatesAtDate(db,{subjectId,collectionId,predicate,context,validDate,limit,before})` uses the existing SQLCipher v11 temporal claim/evidence and current source revision, with active source, standard collection and standard/inherit record sensitivity.
- The predicate, context and stable subject ID are SQL filters before keyset limit, avoiding top-N starvation by unrelated records.
- Only `state/asserted/non-negated` entries appear. Events (repairs, laboratory measurements), plans, hypothesis and negation have separate semantics, and cannot silently become state assertions.
- Each row includes a direct quoted source/version, original valid bound and knowledge recorded time. Return `verification=candidate_unconfirmed` **even if a user has confirmed an end**; approving an old endpoint is not a global truth assertion about the incoming claim.
- `timeFit=outside_date` if known bounds exclude the date; `boundary_uncertain` if approximate/unknown dates or coarse month/year boundaries might cross it; `potentially_applicable` when declared temporal bounds allow it. The third does NOT mean proved true, "currently valid", or approved. Explicit inclusive day handling is provisional until a typed interval/endpoint contract is adopted.
- Keep at most 50 records per page, stable `recordedAt/id` cursor, `partial` and `nextCursor`. Do not expose counts, titles or evidence of private/secret/unclassified records.
- AppLock / profile scope enforced by existing `MemoryRepository.temporalCandidatesAtDate` proxy lease. No additional tables, migrations, background LLM or cloud call.

## Specific examples / C1
TIME-01/02/05/06 and SEARCH-03/04 from `Plans/MEMORY_SCENARIO_MATRIX_2026-10-27.md`: employer A since 2022 ended 31 Aug 2024 and employer B since 1 Sep 2024; 2023 query A potentially applies, 2025 B potentially applies, old A outside; no false current status. A 2024-only start queried in Feb 2024 is uncertain, not 1 Jan. Confirmed end with unknown date is uncertain at late dates. Documents with planned jobs, negation and events are excluded from state result. Protected and revised sources are filtered before cursor; 5 visible records remain paginated even alongside secret/private sources. Invalid dates (30 Feb), page limits and cursor are rejected.

## Important NOT IMPLEMENTED
- This is **not** the complete current-as-of answer engine, not current truth, and **does not** reconstruct "what PersAI knew in August": historical decision and source-revision snapshots need their own as-of-knowledge API. A closed old claim may still have conflicting unresolved evidence. Model-generated identity and dates cannot be trusted by this reader.
- Not yet connecting typed claim extraction during note/chat saving, not GUI presentation of candidate uncertainty, not unified agent FTS+graph+time+vector retrieval, not relation persistence, nor physical phone QA.
- Do not run the C3 global architecture consolidation before M1–M4 and the applicable migration/restore/Android acceptance gates.
