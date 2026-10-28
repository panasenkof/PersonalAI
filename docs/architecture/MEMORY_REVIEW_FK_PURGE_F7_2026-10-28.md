# Retrospective follow-up F7 · SQLCipher v13 undo foreign key vs permanent deletion

**Verified on 28.10.2026** by executing a minimal real SQLite FK scenario with `PRAGMA foreign_keys=ON`: a parent's `ON DELETE CASCADE` to actions plus the audit history's `undoes_id REFERENCES memory_review_actions(id) ON DELETE RESTRICT` prevents deleting parent if `undo` references `retract`. `mobile/src/local-memory/storage.ts` implements that exact FK shape and `mobile/src/local-memory/note-actions.ts:purgeNotes` physically deletes `memory_entities`, cascading to relation witnesses and their action history. This issue was **not captured in the first static [#166–185 retrospective](MEMORY_PR_RETROSPECTIVE_2026-10-28.md)**; finding it on follow-up is evidence that the mandatory pre/post gate is useful. CI of #184/#185 was green but did not exercise this hard-delete case.

## C0-A existing architecture
- One canonical relation edge `memory_relations` and witness `memory_relation_evidence`, one encrypted `memory_review_actions` journal, one existing `purgeNotes` second-confirmation irreversible path, transaction `withUnlockedTransaction`.
- Affected relationships: `source_entity_id`, `target_entity_id`, **or** the witness's `evidence_entity_id`; purge can cascade any of them. Note trash/restore should NOT delete journal; permanent purge intentionally may.
- Alternative A: table rebuild migration to switch FK to NO ACTION/CASCADE would require new schema version/backup compatibility. Appropriate at a later controlled migration, NOT an incidental v13 fix.
- Alternative B: remove all journal history on normal trash or after reading proof: incorrect and destructive, rejected.
- Selected minimal safe fix (REUSE): before physically deleting a trashed entity, in the same existing SQLCipher transaction remove `undo` action rows for its **affected witnesses first**, then referenced previous action rows, then perform the existing FTS/entity delete. No new table, search or writer; all related source data remains untouched until explicit irreversible purge. Rollback on stale selection or FK error.

## C1 evidence and acceptance
- Real `node:sqlite` with actual project `SCHEMA_SQL` and `foreign_keys=ON`; create two persons, proof quote note, retract+undo; direct physical delete MUST fail with FK error; `purgeNotes` succeeds, preserves persons, removes target note and dependent witness/journal, `foreign_key_check` empty.
- Verify one invalid record in a multi-selection prevents any prior purge/delete in transaction, action rows still present. Retain ordinary note edit/trash history. Android native CI exact SHA pending, physical device C2 NOT RUN.
- Use the same accepted note action, not a new API. This is P1 data-lifecycle correctness; no claim that physical deletion/graph-merge is fully accepted across 96 scenarios.

## C3-B post-diff assessment
The single authoritative stores, ACL, encrypted backup format v4, canonical search and review journal are unchanged. A narrow FK order bug is fixed, no broad storage migration while M1–M4 active. Remaining deferred: when schema v14 is introduced for R2b1, choose a self-action FK `ON DELETE NO ACTION/CASCADE` with real SQLite migration / backup tests, and retire the v13-only ordering workaround after proving safe for all callers; in particular do not add unknown action types without extending this test. This addendum does not rewrite historical PR claims or create a second project roadmap.
