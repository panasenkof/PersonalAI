/**
 * Canonical read-only dependency gate for irreversible GLOBAL trash clearing.
 *
 * A trashed record can still be a source, endpoint, or witness for another
 * person's relation or temporal fact. Bulk clear must not silently destroy
 * those references; the user can inspect them and explicitly delete that
 * individual record by the existing per-note action.
 *
 * Alias `e` is the memory_entities row being considered. This SAME predicate
 * is evaluated in the SQLCipher preview and again INSIDE the purge writer's
 * BEGIN IMMEDIATE transaction, to catch late-added relations.
 */
export const BULK_PURGE_NEEDS_REVIEW_SQL = [
  "EXISTS (SELECT 1 FROM memory_relations r " +
    "WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id)",
  "EXISTS (SELECT 1 FROM memory_relation_evidence w WHERE w.evidence_entity_id=e.id)",
  "EXISTS (SELECT 1 FROM memory_review_proposals p " +
    "WHERE p.source_entity_id=e.id OR p.target_entity_id=e.id OR p.evidence_entity_id=e.id)",
  "EXISTS (SELECT 1 FROM memory_temporal_claims c WHERE c.entity_id=e.id)",
  "EXISTS (SELECT 1 FROM memory_temporal_evidence te WHERE te.entity_id=e.id)",
  // Purging the currently bound profile person would silently unset the
  // user-owned identity pointer (ON DELETE SET NULL). Require manual review.
  "EXISTS (SELECT 1 FROM memory_profile_self self WHERE self.person_id=e.id)",
].join(" OR ");
