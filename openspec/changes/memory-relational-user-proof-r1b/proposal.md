# №66.4 R1b — explicit user proof on the canonical relational graph

Builds on R1a SQLCipher v12. One `memory_relations` row is the canonical edge; `memory_relation_evidence` supports several distinct user-confirmed, source-versioned witnesses to that edge. No competing graph, model auto-confirmation or separate search index.

## User-initiated write
`MemoryRepository.confirmUserRelationProof` must be called only after user confirmation. A request names two stable entity IDs+versions, an exact relation role, one evidence entity ID+version and a literal quote **present in the saved original note**. It rejects names as identity, untrusted arbitrary kinds, invalid role directions, hidden/secret/unclassified/archived entities and stale versions. `participant_of` requires conversation note→person, kinship/social roles require person→person. The confirmation uses the existing profile-leased SQLCipher connection and one transaction; no note, edge or witness survives a failed check.

If the exact canonical relation already exists from legacy code, it is reused. If it came from model:auto, user-confirmation takes ownership of that same edge, preventing future enrichment from silently deleting a user decision. A second distinct source adds another witness without duplicating the edge. Exact duplicate confirmation is idempotent. A retracted witness is not silently revived.

## Read
`MemoryRepository.currentConfirmedRelationProofs` joins the canonical edge to user-owned witnesses, both endpoint records, the evidence source, versions/status and each collection's standard scope; returns only accessible, current confirmed proofs. It labels actual evidence as `identityState=resolved` only for the explicitly selected stable IDs, not names extracted by a model. `partial` on page limit prevents falsely claiming complete coverage. It intentionally cannot open audio, extract speakers or silently create evidence.

## C1
Mother from two independent notes; idempotence, relation count=1, altering one witness leaves the other, archiving the last source removes proof; secret doctor, wrong source revision and invented citation rejected without phantom edges; explicit note→person participant proof does **not** imply that every person mentioned in the conversation participated; wrong role direction and userConfirmed=false refused.

## Remaining work
R2 user review UI for relation candidates, rejection/defer/undo with immutable decisions, relative time validity and source-witness revocation; R3 bounded relation→conversation search and source attachment open. No export or agent mutation API. Android physical C2 remains NOT VERIFIED. Do not duplicate memory search; integrate with the existing `searchMemory` and `source-retrieval`.
