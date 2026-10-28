# №66.4 / M3 R3a — confirmed family conversation via the EXISTING memory search

Extends #181 graph proof traversal; no new search service, SQL table, FTS, vector or separate copy of relation truth.

The existing `MemoryRepository.searchMemory(query, options)` accepts optional `verifiedRelative: { ownerPersonId, relationKind }`, both stable user-selected ID and exact typed role. This invokes the same SQLCipher current ACL/source-version proof traversal implemented in #181. With this option the query is **strict**: only conversation-note IDs with confirmed `has_mother/has_sister/... → participant_of` witnesses are considered, never a name match, mere `about`, embedding hit, ASR guess or loosely matched note. Results use the same `MemoryHit` return type with an optional evidence field holding the person ID, both witness IDs and honest `truncated`.

For each verified path, rechecks the actual note's active record status, standard collection, standard/inherit record sensitivity and optional caller collection/sensitivity filters; reads the ordinary `memory_chunks` record text. Empty collection scope returns no records. The existing normal lexical/vector search is unchanged if the typed filter is absent.

**Important limitations:** This does not automatically parse "мой брат" to a stable owner ID, resolve the relative role from plain text, create candidate participation evidence, read attachment bytes, claim an audio file or timecode, or prove a time-dependent status. If no proof exists, returns none rather than making a speculative inference. Agent intent resolution and source original open are follow-up R3b using the same APIs. The `proof` field is explanation data, not a substitute for the source read.

C1: real SQLCipher-model SQLite fixture with two identically named people, an actual confirmed phone conversation and a note merely mentioning the mother; verified query returns only true conversation and two evidence IDs, respects collection scope, rejects protected private note, source edit invalidates path. Normal "Ирина" FTS remains available but never acquires a false proof. Android C2 physical pending.

**C3:** no parallel storage/search/approval route; on consolidation prove the graph path and text entry share exactly this one `searchMemory` surface and current source reader.