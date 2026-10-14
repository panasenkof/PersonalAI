-- Schema shipped before local chat history (PR #27). Keep this upgrade fixture frozen.

CREATE TABLE IF NOT EXISTS memory_collections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  description TEXT, sensitivity TEXT NOT NULL DEFAULT 'unclassified',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_entities (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  domain TEXT NOT NULL, schema_version TEXT NOT NULL DEFAULT '1',
  title TEXT, payload_json TEXT NOT NULL,
  record_status TEXT NOT NULL DEFAULT 'active', sensitivity TEXT NOT NULL DEFAULT 'inherit',
  source_kind TEXT, source_ref TEXT, valid_from TEXT, valid_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, record_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_memory_entities_collection ON memory_entities(collection_id, created_at);
CREATE TABLE IF NOT EXISTS memory_observations (
  id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'inherit',
  source_kind TEXT, source_ref TEXT, confidence REAL, valid_from TEXT, valid_until TEXT,
  record_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_memory_observations_entity ON memory_observations(entity_id, occurred_at);
CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, source_kind TEXT, source_ref TEXT, created_at TEXT NOT NULL,
  UNIQUE(source_entity_id, target_entity_id, kind),
  CHECK (source_entity_id <> target_entity_id)
);
CREATE INDEX IF NOT EXISTS ix_memory_relations_target ON memory_relations(target_entity_id);
CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY, record_type TEXT NOT NULL CHECK(record_type IN ('entity','observation')),
  entity_id TEXT REFERENCES memory_entities(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES memory_observations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version > 1),
  reason TEXT NOT NULL, actor_kind TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK ((entity_id IS NOT NULL AND observation_id IS NULL AND record_type='entity')
      OR (entity_id IS NULL AND observation_id IS NOT NULL AND record_type='observation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_local_entity_revision ON memory_revisions(entity_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS ix_local_observation_revision ON memory_revisions(observation_id, version);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(entity_id UNINDEXED, title, body);

PRAGMA user_version = 1;
