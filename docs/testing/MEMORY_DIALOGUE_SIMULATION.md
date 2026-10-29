# C1 scripted dialogue simulation — PersAI memory

This is an **executable integration layer**, not a parallel memory implementation. Jest automatically discovers `mobile/src/direct-agent/__tests__/memory-dialogue-simulation.test.ts`.

- Executes production `runDirectAgent` (compatible-model routing), the real tool catalog, `saveApprovedNote`, `searchApprovedNotes`, `readApprovedNote`, `SqliteMemoryRepository`, the current `SCHEMA_SQL` and FTS5.
- Replaces only the LLM network response (deterministic scripted tool calls) and the Expo native SQLite bridge (in-memory `node:sqlite`). There is no outbound web request, user data, API key or second persistence/search engine.
- Covers multi-turn draft → no save → user-approved write → retrieve → versioned original read, concurrent source correction, private-collection isolation, denied unsupported deletion, separate repeatable vehicle events, confirmed relation+participant proof (excluding mention/namesake), stale-proof invalidation and offline unknown memory.
- Assertions inspect **real returned tool evidence**, not just mocked assistant text. The scripted final answer is intentionally not graded as model cognition.

Run from `mobile/`:

```bash
npm ci
npx jest src/direct-agent/__tests__/memory-dialogue-simulation.test.ts --runInBand
```

**Interpretation.** Passing this test demonstrates reproducible algorithmic/agent-tool integration for only these journeys. It **does not** demonstrate that a live LLM understands arbitrary natural-language relationship questions, reliably chooses correct tools, gives correct prose, processes real microphone/PDF imagery, or passes the full 96-case acceptance matrix. The relation story uses the canonical `searchMemory({verifiedRelative})` implementation directly because verified-relative routing from free-form chat is a distinct unverified ability. Physical Android/AppLock, OEM media codecs, performance and real API/ASR remain separate tests.

The 96-case matrix is authoritative; don't promote a scenario to `C1_PASS_EXACT_SHA` unless its entire stated behavior (including forbidden false output) is actually exercised and a concrete CI SHA/run is recorded. In particular, the new scripted transport is NOT a substitute for blind conversations with a live model.
