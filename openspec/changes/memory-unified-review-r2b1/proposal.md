# PersAI R2b1 / №66.4 — durable, nonconfirmed review proposals in SQLCipher v14

## C0-A architecture BEFORE
PLAN.md §2 step 6, [R2b unified review contract](../memory-unified-review-r2b/proposal.md), [retrospective](../../../docs/architecture/MEMORY_PR_RETROSPECTIVE_2026-10-28.md), and existing SQLCipher v13 readers/writers were reviewed first (2026-10-28). **EXTEND** the one user review workflow, do not add a second relation graph or action journal.

- Confirmed relationships: `memory_relations`; source-versioned proofs: `memory_relation_evidence`; sole user confirmation writer: `confirmUserRelationEvidence`; proof traversal: `CURRENT_PROOF_SQL`; one search route: `searchMemory`; existing temporal authority: `memory_temporal_proposals/decisions`; common future relation action history: `memory_review_actions`.
- R2b1 is the **nonconfirmed candidate representation**, not another truth source: one `memory_review_proposals` table constrained to target_kind=relation for this slice, with FK to the three already saved `memory_entities`, exact role, current record versions, quote, status and CAS version. The one planned unified inbox will combine this with existing temporal read; until R2c, it is typed `targetKind:"relation"` via the same profile-leased MemoryRepository. Do not copy temporal rows.
- One shared source/endpoint/ACL/quote gate for staging and direct user confirmation; reusing the existing `withUnlockedTransaction` for both stage and read, rather than a parallel lock or independent ACL policy. Query excludes a candidate after a current identical user-confirmed witness.
- An unchanged exact source/role/identity tuple is unique across model-version reindex and repeated imports. `rejected` and `deferred` rows cannot be reopened by staging. Changed content must use a changed evidence version. No implicit promotion from name/ASR similarity or LLM guesses; these are only candidates and never authoritative answers.

## C1/C2 acceptance
- New installed v13→v14 migration only creates the shared staging table; versioned SQLCipher data, previous v13 review journal, keys, direct conversations and original attachments remain untouched.
- Encrypted backup version 14 / manifest format 5 counts `review_proposals`, validates the exact count **before destination writes and before commit**, restores after FK source parents. Historical v13/v12/v11 and older archives restore through their previous format branches without fabricating candidate rows.
- C1: two namesakes, true quoted source vs invented quote, idempotent reindex, no canonical edge creation, current standard ACL for all three endpoints, no private candidate, stale source invalidation, no pending card after explicit confirmation, rejected candidate stays suppressed, FK and backup restore. Note that manual rejection/defer/undo writer is **not** present in this slice; raw SQL in test models a pre-existing rejected state only.
- Native CI proves APK build and emulator smoke when available; physical device encrypted backup/restore and full AppLock scope **NOT VERIFIED**, remain C2.

## C3-B architecture AFTER
- One canonical relationship graph, one evidence table, one user confirmation writer, one SQLCipher transaction helper, one memory repository, one existing temporal review queue. New table contains **only hypotheses**, not decisions/accepted truth, and does not independently mutate `memory_relations`.
- Single inbox UX, typed aggregate reader, accept/reject/defer/undo and durable user audit are R2b2/R2c; R3b remains free-text identity→source original. R2b1 must remain marked PARTIAL for the larger feature. Do not remove legacy temporal journals before C3 post-M1–M4.
- References: project’s current R2b contract/retrospective; no new external framework/SDK/UI feature, so new web research N/A. Any detected failure of the backup/ACL/CAS regressions blocks merge.
