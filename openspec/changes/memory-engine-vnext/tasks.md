# Implementation checklist — Memory Engine vNext

Statuses: [x] documentation delivered; [ ] implementation/testing not started. PLAN.md is authoritative for order. None of the unchecked items should be described as running or finished.

## M0 — Architecture/design, current PR
- [x] Compare schema v5 vs desired durable agent memory, choose SQLCipher temporal graph without new server/DB.
- [x] Specify objects/claims/evidence/mentions, state vs event, valid vs known time, proposals and provenance.
- [x] Define originals/messages/media and reconstructible lexical/multimodal search, privacy invariants.
- [x] Add explicit post-engine UX/UI design and migration stages; preserve Nebula design and existing Share/notes workflows.
- [x] Review AIRequest narrowly and document reject/accept decisions without code transfer.
- [x] Synchronize main PLAN and ROADMAP_STATUS; link architecture and UX as long-lived files.
- [ ] Independent review of M0 physical constraints (SQLCipher SQLite FTS5, backup, model fingerprint) before M1 code.

## M1 — New local repository and schema (first implementation PRs)
- [ ] Define physically executable SQL DDL, CHECK, FK, UNIQUE and indexes; decide source/message/blob deletion and privacy intersection semantics.
- [ ] Reconcile with existing TEMPORAL_MEMORY/RELATIONAL_MEMORY: observation vs event, plan/negation, ongoing/ended/unknown, time precision/anchor/timezone, exact evidence revisions and lifecycle; avoid duplicate relation/proposal tables.
- [ ] Compare current technical №66.1/schema v6 CAS/source-version change with vNext repository and keep a single owner for invariant implementation.
- [ ] Build TS typed repository with transactions, version/conflict checks and deterministic safe predicate catalog.
- [ ] Split old conversation JSON into normalised conversations/messages; preserve running chat and draft/attachment behavior.
- [ ] Implement streaming hash/dedup for originals with multiple references; copy verified bytes; ensure SQLCipher locked-state rejects all.
- [ ] Handle legacy v5 explicitly via a safe test-data reset gate (user confirmation) or unsupported-upgrade warning; no silent wipe.
- [ ] New backup/restore, integrity check, interrupted write and index rebuild tests; native Android SQLCipher smoke.

## M2 — Ingestion and graph facts
- [ ] Store source and exact locators even when extraction unavailable.
- [ ] Resolve people/aliases conservatively, never by name only; handle conflicting candidate identities and rejected proposals.
- [ ] Extract candidate typed statements and evidence with independent deterministic checks, limits and privacy.
- [ ] Support functional state transitions, repetitive events, valid/known dates and approximate date precision.
- [ ] Dedup idempotent Share/import; atomically approve/reject/update/merge/supersede/close with operations journal.
- [ ] Build synthetic fixtures for sister/recordings, same-name people, employer change, car service, conflicting specs.
- [ ] Prove no silent save of unapproved LLM result, no automatic promotion of mentions to participation.

## M3 — Retrieval and context
- [ ] Common search result contract across source, claim, object and media segment with source locators.
- [ ] FTS5, alias/morphology, directed/undirected relation rules, temporal retrieval, vector hybrid when available.
- [ ] Rebuildable model-fingerprinted vectors, race/invalidation, no-model fallback and signed-off benchmark.
- [ ] Privacy tests including graph traversal, derived evidence, sensitive source summary, negative/not-indexed.
- [ ] Evaluate on fixed corpus with recall@5/10, accuracy of time/identity, source attribution, latency and device resources.

## M4-UX — UI rebuild after M1–M3 APIs; design can start early
- [ ] UX0: research comparable products + Apple HIG adapted to Android; information architecture, flows, accessible screens/realistic references and design system.
- [ ] UX1: library/search/object cards + concrete source links, keep visual library as starting point.
- [ ] UX2: timelines/proposals/conflicts with preview/confirm/undo and accessible controls.
- [ ] UX3: source viewers, privacy/forget, backup, Share/import integration; Android physical QA at 320–430dp and TalkBack.
- [ ] Preserve Home, Nebula sphere, icon, keyboard layout, chat attachment flow; regression tests.

## M5–M6 — subsequent measured extensions
- [ ] M5: multimodal index per Plans/LOCAL_MULTIMODAL_AI.md and number 83, including audio timestamps and OCR.
- [ ] M6: consented consolidation/optional procedural memory and geo reminders (#81), not executable instructions from untrusted sources.

## Exit gates
- [ ] Every synthetic scenario in Plans/MEMORY_ENGINE_ARCHITECTURE.md §10 green on actual SQLite/SQLCipher and Android smoke.
- [ ] Verify local-only handling and access before any cloud helper; prove no leaks via connected objects.
- [ ] Only after gates switch current UI/runtime to the new data model. Keep partial deliverables labelled correctly.
