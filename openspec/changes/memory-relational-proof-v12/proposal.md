# №66.4 / M1 R1a — canonical relation provenance in SQLCipher v12

## Goal
Persist proof witnesses for the **existing** `memory_relations` rows. Never introduce an independent second relation graph, new inference queue, or magic auto-approval. A link from legacy `linkEntities` or model:auto enrichment is **not** itself a confirmed proof. Subsequent R1b will provide a version-checked user-confirmation API and feed the pure `relational-proof.ts` evaluator without guessing person identities.

## Schema v12
New `memory_relation_evidence` carries `relation_id` FK to canonical `memory_relations`, `evidence_entity_id` FK to the original entity, witness/source version, **both endpoint versions**, exact quote, origin, `actor_kind='user'`, confirmation/retraction status, timestamp, unique source/version/quote per logical relation. Multiple distinct witnesses are allowed per one logical relation. SQL CHECK and FK prevent blank quotes, invalid statuses, model-confirmed evidence or orphan rows.

**Important:** no new relation candidate or decision table in this PR; the user decision workflow must reuse the same profile-leased repository/SQLCipher transaction and consistent review controls that exist for temporal review. UI/agent must not begin treating a link as proven merely because the table now exists.

## Backups and migrations
- Upgrade v11→v12 is additive, rollback-safe, and leaves all old relations and original IDs intact. Existing links have zero proof rows; no retroactive permission/status promotion.
- Encrypted `sqlcipher_export` manifest format v3 carries **both** counts (canonical relation links and witness rows). Integrity/FK checks still apply. Restore v12 witnesses after entity/relation FK parents and before transaction commit. Validate counts before any destination writes and again after import.
- v11 encrypted archives with manifest v2 remain readable; v1–v10 archives remain backward-compatible under existing migration rules. No plaintext sidecar, source copy, parallel index or external service.
- Physical Android native SQLCipher+backup C2 remains separate; the JS `node:sqlite` migration fixture is C1, not a substitute.

## Domain scenarios
REL-01/03/06/08, RE01–RE28, SEC-01/07, BKP-01/02/03/08, CLEAN-05, CAR-03 and MED-07. Particularly: two independent witnesses can exist for "mother", "sister", "doctor" or "colleague"; an old link to a namesake is **not confirmed** until its actual cited source/versions and person identity are reviewed. A conversation merely mentioning a person is **not** participant evidence. Deleting or editing a witness later invalidates proof even if relation row survives.

## Next functional step / explicit limitations
R1b: only a real user confirmation on a valid, active, standard source and pair of active, standard endpoints can create a confirmed witness; compare-and-swap or refusal on source/identity changes; a source may support many relations, a relation many witnesses. R2: relation candidate inbox/reject/defer/undo, typed historical validity, local graph traversal and attachment/source citation. R3: integrate one bounded graph expansion into the existing searchMemory→source-reader path, not a second competing retrieval subsystem. These remain NOT IMPLEMENTED here.

## C3
`PLAN.md` §2 step 6.5 continues to require a single authoritative facts store, canonical graph, searchable projections only, one decision path and one agent read interface after M1–M4 acceptance. Avoid refactor now.
