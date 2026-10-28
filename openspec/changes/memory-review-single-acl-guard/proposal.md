# №72.2 / T2b–T2c ACL + evidence/version invariant

**Motivation:** The existing typed staging and inbox excluded private, unclassified and cross-collection candidates, but low-level `stageTemporalReviewProposal` could create a proposal for arbitrary two claim IDs. The user decision/undo operations checked versions but not the *same visibility scope* at execution time. Therefore a legacy/corrupted proposal or a guessed ID could bypass the display safety barrier. This was an inconsistent policy, not a need for another review table.

## Patch
One `isStandardTemporalReviewPair` guard in `temporal-store.ts` is reused for manual candidate pairing and both apply/undo actions. It checks source collection equality, standard collection and standard/inherit per-record sensitivity for **both** sources, record status, matching current source revisions and existing matching evidence anchors. Underlying SQLCipher transaction remains the only writer and `memory_temporal_decisions` remains the single journal. Ineligible direct staging returns null; apply/undo fail with a generic unavailable error rather than disclosing whether one ID was private or stale. The normal scoped inbox remains a separate paginated projection, not an approval engine.

## C1 cases
- Same two standard sources → one pending review with versioned user decision and undo.
- Two standard sources in **different** collections → no review.
- Standard↔private, standard↔unclassified, standard↔secret → no review even with known UUID.
- After proposal, change one source record sensitivity to secret → accept/keep_both and undo both refuse without appending a journal entry, closing a claim or revealing the source.
- Revision edited/trashed or witness removed → refuse; SQLCipher FK check still passes.
- Existing v10→v11 migration, source-backed history, and screen review UI remain unchanged. Older test fixtures that deliberately used unclassified default must explicitly opt into standard for a review.

## C3 single-source-of-truth acceptance
No new tables, no alternate graph or search mechanism. `PLAN.md` step 6.5 and `docs/DEVELOPMENT_GATES.md` now explicitly require tracing writers, decision queues, readers, indexes, and backup to **one canonical source per fact and one search→read path** after M1–M4 acceptance. This PR is a small security correction now; broad consolidation waits until the memory migration, search and UX gates pass.
