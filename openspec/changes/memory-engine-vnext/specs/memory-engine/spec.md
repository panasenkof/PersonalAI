# Memory Engine vNext — requirements (targets for M1–M4)

## Requirement: Stable identities and evidence
The system SHALL give people/objects stable IDs separate from names, shall preserve aliases and SHALL NOT auto-merge two distinct people due solely to matching names.
Every accepted extracted claim SHALL link to one or more durable exact source segments or explicitly record its user-entered origin. A mention SHALL NOT be promoted to a participant relation without evidence/confirmation.

### Scenario: Find a conversation with a sister
- **GIVEN** person Лиза is connected to the user by a confirmed sister relationship
- **AND** an audio conversation or transcript mentions Лиза
- **WHEN** the user asks for the conversation with their sister
- **THEN** the system resolves the relationship, searches source participants and mentions, returns the original/segment if relevant, and distinguishes mere mention from confirmed participation.

## Requirement: Bitemporal facts
The system SHALL distinguish effective time (valid interval) from time when a claim was known, including precision/uncertainty of dates.
It SHALL retain separate repeated events and SHALL NOT mark older events superseded by newer occurrences of the same event type.
The system SHALL apply predicate-specific cardinality rules before suggesting a previous state be closed.

### Scenario: Previous employer
- **GIVEN** company A was an employer until an indicated date and B after that
- **WHEN** the user asks where they worked before the change
- **THEN** A is retrieved with dates and evidence, not silently replaced by B.

### Scenario: Repeated maintenance
- **GIVEN** spark plugs were replaced in 2023 and again in 2025
- **THEN** both events remain independently retrievable.

## Requirement: Aligned claim semantics and versioned evidence
The system SHALL represent event/observation/state/enduring knowledge independently from asserted/planned/hypothetical modality and negation. A null end date SHALL NOT be treated as proof that a state is currently ongoing. Relative dates SHALL preserve their original phrase, source-time anchor/timezone, precision and uncertainty. An event spanning multiple days SHALL remain an interval.
The system SHALL link claim evidence to immutable source/extraction revisions and mark stale/withdrawn evidence separately from accepted/disputed/retracted claims. A proposed relation SHALL carry exact source and target identities, expected record versions and evidence refs; rejection/deferment SHALL survive reindexing without repeated prompts.

### Scenario: Planned move is not a completed move
- **GIVEN** a user says they plan to move in December
- **WHEN** December arrives without a confirming source
- **THEN** the system SHALL NOT mark their old residence ended or the planned residence current.

### Scenario: Existing fact loses a derived source
- **GIVEN** a fact is independently confirmed by two sources
- **WHEN** one extraction is corrected or withdrawn
- **THEN** only its dependent evidence becomes stale and the remaining valid evidence is preserved.

### Scenario: No parallel relations architecture
- **GIVEN** the old temporary v5/v6 plan describes memory_relation_candidates and memory_relation_decisions
- **WHEN** the new canonical schema is implemented
- **THEN** these behaviors SHALL be provided by shared claims/evidence/proposals/operations rather than a second competing graph.

## Requirement: Controlled updates and conflicts
The system SHALL validate typed proposals in deterministic code before committing, SHALL present consequential conflicting identity/relationship/state changes for confirmation, and SHALL make rejection durable to prevent repeated identical prompts.
Contradictory claims SHALL retain both evidence trails until resolved. Reject and cancel SHALL NOT modify accepted knowledge.

## Requirement: Source- and path-scoped access
The system SHALL enforce the same effective privacy policy over facts, relations, original segments, derived summaries and search hits. Cloud models SHALL NOT see closed information by traversing to it through public objects. Indexing private data locally is not authorization to transmit it.

## Requirement: Independent originals and recoverable search
The system SHALL keep original messages/files when extraction/OCR/STT/embedding fails, and shall allow reprocessing.
Search SHALL support lexical fallback without embedding model, scoped graph traversal and temporal constraints, and SHALL distinguish no-results from unavailable indexes. Cached embeddings SHALL be invalidated when content or model fingerprint changes.

## Requirement: Correct deletion and encrypted restore
The system SHALL distinguish undoable archive from physical purge; physical purge SHALL remove affected references and derived index content and handle audit snapshots according to an explicit erase policy.
Encrypted backup and isolated restore SHALL verify schema, relations and file checksums; already exported backups require a warning because they cannot be retroactively modified.
Replacing the prior test schema SHALL NOT silently delete any installed profile's content.

## Requirement: Explainable bulk memory review and user-controlled exceptions
The system SHALL support a read-only group-level memory cleanup dry-run with stable candidate IDs/source versions, human-readable reason codes, candidate-level exclusion, keep/never-suggest, defer and action override. A model's similarity or obsolescence ranking SHALL NOT autonomously remove user sources, claims, original media, clinical records or historical episodes. A candidate being old, unopened or a URL fetch failure SHALL NOT alone prove that deletion is safe.

Bulk proposals SHALL distinguish hide/archive, undoable trash, rebuildable cache disposal and separately confirmed irreversible purge. The system SHALL calculate graph impact before applying any action, including evidence on accepted claims, shared blobs, source versions, citations, linked notes, collection membership, index effects and backups. It SHALL estimate immediate versus delayed bytes reclaimed without counting shared files more than once.

The system SHALL revalidate all affected identities/versions, profile lock status, privacy, pin/keep/skip decisions and references **after confirmation** and before each atomic apply. Any stale or unsafe element SHALL be skipped with explanation, not deleted. A batch SHALL be idempotent across crash/restart, and undo SHALL restore reversible operations; hard purge SHALL not claim to erase already exported independent backups.

### Scenario: Exclude five items from proposed bulk archive
- **GIVEN** 20 old watch-later videos are grouped for review and three are pinned
- **AND** the user explicitly excludes five further items
- **WHEN** the user confirms archiving the remaining eligible items
- **THEN** the exclusions and pinned materials SHALL remain unchanged, and the result SHALL enumerate changed/skipped items with explanations and undo.

### Scenario: One source supports accepted claims and multiple notes
- **GIVEN** a document is linked by multiple notes and provides unique evidence for an accepted claim
- **WHEN** it appears in a suspected-duplicate or obsolete-content group
- **THEN** the dry-run SHALL show affected links and evidence and SHALL NOT silently purge the original or leave a seemingly supported claim with destroyed sole evidence.

### Scenario: Medical history and completed events are not obsolete trash
- **GIVEN** old laboratory results, an expired past prescription, and previous car repairs are retained as history
- **WHEN** cleanup candidates are generated solely by age
- **THEN** the system SHALL NOT propose physical removal of these records as expired current-state facts.

### Scenario: Cancel, stale review and no external leaks
- **GIVEN** a group review with candidates from an unlocked profile
- **WHEN** the user cancels, or a candidate becomes pinned/changed before apply, or profile locks
- **THEN** cancel SHALL make no changes; changed or blocked candidates SHALL be skipped; closed metadata SHALL NOT be transmitted to an external model.

## Requirement: Memory user interface after the engine
The system SHALL preserve current approved visual style and Home/Nebula while providing navigable object cards, history/time context, source-open-to-fragment, proposal queue, contradiction view, and privacy/forget controls.
New UI code SHALL follow the UX specification and stable engine API, with Android accessibility, IME/Back and device QA.
