# №66.4 R1c — read source-verified relative→participant conversation paths from canonical SQLCipher graph

Depends on #179 (v12 witness schema / backup) and #180 (explicit user source-backed confirmations).

`MemoryRepository.confirmedRelativeConversationPaths({ownerPersonId,relationKind})` traverses only confirmed current user-owned witnesses through the **same** `memory_relations` graph. It first finds the exact directed role from the stable owner ID to the confirmed person, then only actual `participant_of` conversation-note→person edges. Matching names, similar photos, `about` and `mentioned_in` never establish participation. No model, remote request or re-extraction.

One shared ACL SQL projection verifies every endpoint, witness record, source version, standard collection, active status and sensitivity; both the direct proof list and traversal use this same projection. Participant query restricts targets by the exact confirmed person IDs **before** applying bounded limit, avoiding starvation by unrelated conversations. Result is only IDs of note, person and two evidence witnesses with `truncated` when capped. The pure `resolveDirectRelationConversationPaths` R0 function is reused, not copied/reimplemented.

**Do not claim an audio file or timecode:** this is a typed proof path only. Opening an audio original requires the existing `source-retrieval` API and a present real attachment; the path result contains neither attachment metadata nor valid-time state. Questions about *current* colleagues still need valid-time filtering; historical/current eligibility is not asserted.

C1 cases: mother with exact quote and participant, two same-name persons, other discussion merely mentioning mother, no sister edge, source correction invalidates result, private intermediate evidence makes path disappear without leaking names. Performance/scalability and native Android physical QA are separate C2. R2 confirmed decision UX, R3 integration with existing agent `searchMemory` and source-reader still open.
