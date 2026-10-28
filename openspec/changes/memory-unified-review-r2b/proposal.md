# PersAI №66.4 / №72 · R2b architecture contract: ONE user review inbox for facts and relationships

**28 October 2026 · DESIGN ONLY, not an implemented inbox.** Applies after [F1 consistent read](../memory-consistent-proof-read-f1/proposal.md). Decision basis: `PLAN.md §2`, `Plans/RELATIONAL_MEMORY.md`, `Plans/TEMPORAL_MEMORY.md`, `Plans/MEMORY_ENGINE_UI.md`, the [PR #166–185 retrospective](../../../docs/architecture/MEMORY_PR_RETROSPECTIVE_2026-10-28.md), and current SQLCipher v13 code. One permanent owner task **№66.4**; temporal №72 is a dependency, not a new priority order.

## C0-A: verified existing architecture

| Operation | Authoritative store | Present writer/reader | Mandatory constraint |
| --- | --- | --- | --- |
| Confirmed directed relationship | `memory_relations`, proved by `memory_relation_evidence` | `confirmUserRelationEvidence`, `CURRENT_PROOF_SQL` | No LLM/hypothesis promotion; stable source IDs, quote, endpoint versions, ACL |
| Retract/undo proof | `memory_relation_evidence.state/decision_version` | `retractUserRelationEvidence`, `undoUserRelationRetraction` | CAS + same SQLCipher transaction + `memory_review_actions` user audit |
| Temporal conflict pending/choice | `memory_temporal_proposals`, `memory_temporal_decisions` | `stageTemporalCandidateWithReview`, `temporalReviewInbox`, `decideTemporalReview` | Existing user data, don't double-write or delete before C3 migration |
| Read conversation | Original note + current proof | `searchMemory({verifiedRelative})`, source retrieval | No mere-name match or implied participation; F1 consistency before R2b |
| Restore and migration | SQLCipher source data, relation witness + action journals | Encrypted manifest v4, FK-ordered import | Any new user-owned review state requires verifiable manifest and old archive compatibility |

**Rejected alternatives:**
- Put a guessed relationship into `memory_relations` as `model:auto` and treat it as confirmed: violates explicit approval, legacy readers can misinterpret it.
- Model rejection as `memory_cleanup_preferences`, alias, FTS text, prompt cache or log-only event: wrong domain and not source-versioned.
- Add `memory_relation_decisions` with its own UI/approval workflow: becomes a THIRD independent review journal.
- Mirror each temporal decision automatically into `memory_review_actions` while retaining `memory_temporal_decisions` as a separate authority: creates competing truths.
- Replace all temporal tables or rewrite repository in one migration: risks user data, previous native C2 and conflicts with ongoing M1–M4.

## R2b design choice — EXTEND one workflow, not two competing queues

1. **One user-facing and repository-facing `MemoryReviewInbox`** returning a typed union of `temporal` and `relation` review items; supports bounded keyset paging, stable IDs, source summary/citation/versions, originating collection, status `pending/deferred`, and explicit `partial` for skipped/limited candidates. UI U-M5 is one shared screen, not an extra tab.
2. The existing `memory_temporal_proposals` remains authoritative for **old temporal proposals and decisions** through the transition. Any new relation staging row lives in one SQLCipher **shared review staging contract** (e.g. `memory_review_proposals` with relation-specific typed FK fields); no relation candidate row is written into `memory_relations` until the user expressly accepts.
3. The shared review action service reuses `memory_review_actions` for new relation user decisions; `memory_temporal_decisions` continues to be the authority for old temporal decisions until a separately tested lossless C3 migration. New review reader aggregates sources, but never duplicates a single temporal proposal or writes two statuses for the same decision.
4. Stage candidate: require active standard collection, current source/target/evidence versions, literal exact citation from saved text or verified extraction segment, declared directed role, and **unambiguous stable identity**. Name/ASR embedding match alone is a candidate to clarify, never the target of automatic confirmation. Idempotency key covers canonical IDs, role, evidence source ID+version+content hash, context; no model confidence percentage falsely presented as probability.
5. **Accept** calls the single existing relation confirmation writer **inside the same SQLCipher transaction** as CAS status+journal (refactor writer into transaction-safe inner helper; never nest `BEGIN IMMEDIATE` and never copy its SQL). **Reject** and **Defer** only update the proposal and append one shared user audit record; no edge creation. **Undo** restores previous status only if no newer action, source revision or privacy change invalidates it.
6. Repeated import/re-index with unchanged source/evidence/key **never reopens rejected or deferred cards**. Material new evidence can create a new, clearly distinguishable suggestion; metadata-only `updated_at`, model/version switch or duplicate article is not enough. Source privacy change invalidates/removes candidate from the visible inbox; its original journal remains protected in ciphertext.
7. One review panel groups candidates by source, allows individual exclusion and batch confirm (atomically per selected set only after rechecking all current revisions). Ordinary note Save and Share continue without stopping for pending review. No automatic prompts on every import.
8. Source-read/ACL and privacy **before candidate selection and before LIMIT**; all hops in a consistent SQLCipher transaction. No names of secret evidence in standard cards or cloud tool. Non-indexed/deferred/limited is shown as incomplete, not as proof of absence.

## Implementation slices in the existing PLAN queue (no new roadmap)

- **R2b1:** schema/backup-compatible source-backed *pending relation review item* in a general review staging contract, shared repository read shape; old temporal status is not duplicated. C1 migration from v13, v12 backup restore, FK/CHECK, duplicate suppression, private/stale denied; Android C2 explicit.
- **R2b2:** shared explicit `accept/reject/defer/undo` dispatch with reuse of the current canonical witness writer; immutable action journal + stale/ABA prevention. C1 accept, two independent sources, two same-name people, reindex/rescan, stale/private, restart/backup, concurrent decisions and rollback.
- **R2c/M4:** one combined visible inbox and details screen for temporal and relationship review, both showing source/provenance; source notes clickable only when authorized. Check Back/IME/TalkBack/Nebula, 320/390/430dp and device AppLock.
- **R3b:** connect free-text request to known `person:user` and exact role then open source audio from existing source-reader; do not bypass user decisions or claim nonexistent media.

## Acceptance and forbidden outcomes

- REL: two `Лизы` can be candidates but not silently merged; user choice to reject stays rejected across reindex; «Позже» survives app restart; confirmed relationship remains one canonical edge with multiple witnesses.
- SEARCH: a mere mention in an audio transcript is not a confirmed conversation participant; removed/private evidence cannot make an authorized answer; query text restrictions require honest handling in later R3b.
- TIME: temporal `defer/dismiss/accept` continues to work and existing historical decisions/backup survive; reviewing a relation never closes historical work or car-repair events.
- SEC/BKP: secret or unclassified records never enter standard inbox, cloud results or metadata; v13 old archives restore without fabricating new candidate rows; all user-owned pending/rejected/deferred states backed up and restored count-verified.
- CLEAN: delete/merge/ACL change invalidates candidates atomically; rejected state does not keep revealing a deleted original; nothing is silently physically purged.

**C3-B design-stage review:** new physical staging is only justified if it is scoped to nonconfirmed source-versioned proposals and exposed through the **same** review user workflow. No second graph, parallel acceptance service, temporal decision mirror, search index or competing state. Detailed schema/rollback design must be checked again against real main immediately before R2b1, and the post-diff audit recorded before merge. Physical tests NOT RUN; this is specification, not completion.
