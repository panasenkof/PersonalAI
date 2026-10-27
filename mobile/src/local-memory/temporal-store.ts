/**
 * №72.1/T1b: durable SQLCipher candidates; no user-facing fact approval yet.
 * This API never ends an older state or promotes model output to fact.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import {
  compareTemporalCandidates, validateTemporalClaim,
  type TemporalBound, type TemporalClaimCandidate,
} from "./temporal-claims";
import { withUnlockedTransaction } from "./transaction";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "runAsync" | "execAsync">;
type ClaimRow = {
  id: string; entity_id: string; source_record_version: number;
  subject_id: string | null; predicate: string; context: string; value: string;
  temporal_kind: TemporalClaimCandidate["kind"];
  modality: TemporalClaimCandidate["modality"]; negated: number;
  cardinality: TemporalClaimCandidate["cardinality"];
  started_json: string | null; ended_json: string | null; end_confirmed: number;
  knowledge_recorded_at: string; claim_version: number;
  quote: string; origin: TemporalClaimCandidate["evidence"]["origin"];
};
const uid = () => Crypto.randomUUID();

async function requireCurrentSource(db: SQL, entityId: string, version: number): Promise<void> {
  const source = await db.getFirstAsync<{ record_version: number }>(
    "SELECT record_version FROM memory_entities WHERE id=? AND record_version=? AND record_status='active'",
    [entityId, version],
  );
  if (!source || source.record_version !== version) throw new Error("temporal_source_stale");
}

/** Both candidate and source quote survive together or not at all. */
export async function stageTemporalCandidate(
  db: SQL, candidate: TemporalClaimCandidate,
): Promise<string> {
  validateTemporalClaim(candidate);
  const id = uid(), evidenceId = uid();
  await withUnlockedTransaction(db, async tx => {
    await requireCurrentSource(tx, candidate.evidence.entityId, candidate.evidence.recordVersion);
    await tx.runAsync(
      "INSERT INTO memory_temporal_claims " +
      "(id,entity_id,source_record_version,subject_id,predicate,context,value,temporal_kind," +
      "modality,negated,cardinality,started_json,ended_json,end_confirmed," +
      "knowledge_recorded_at,claim_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
      [id,candidate.evidence.entityId,candidate.evidence.recordVersion,candidate.subjectId,
       candidate.predicate,candidate.context,candidate.value,candidate.kind,candidate.modality,
       candidate.negated ? 1 : 0,candidate.cardinality,
       candidate.occurredOrStarted === null ? null : JSON.stringify(candidate.occurredOrStarted),
       candidate.ended === null ? null : JSON.stringify(candidate.ended),
       candidate.endConfirmed ? 1 : 0,candidate.recordedAt],
    );
    await tx.runAsync(
      "INSERT INTO memory_temporal_evidence " +
      "(id,claim_id,entity_id,source_record_version,quote,origin,created_at) VALUES (?,?,?,?,?,?,?)",
      [evidenceId,id,candidate.evidence.entityId,candidate.evidence.recordVersion,
       candidate.evidence.quote,candidate.evidence.origin,candidate.recordedAt],
    );
  });
  return id;
}

function fromRow(row: ClaimRow): TemporalClaimCandidate {
  const claim: TemporalClaimCandidate = {
    recordedAt: row.knowledge_recorded_at,
    subjectId: row.subject_id, predicate: row.predicate, context: row.context,
    value: row.value, kind: row.temporal_kind, modality: row.modality,
    negated: row.negated === 1, cardinality: row.cardinality,
    occurredOrStarted: row.started_json === null ? null : JSON.parse(row.started_json) as TemporalBound,
    ended: row.ended_json === null ? null : JSON.parse(row.ended_json) as TemporalBound,
    endConfirmed: row.end_confirmed === 1,
    evidence: { entityId: row.entity_id, recordVersion: row.source_record_version,
      quote: row.quote, origin: row.origin },
  };
  validateTemporalClaim(claim);
  return claim;
}

export async function readCurrentCandidate(
  db: SQL, id: string,
): Promise<{ claim: TemporalClaimCandidate; version: number }> {
  // Verify source freshness and active status at proposal creation.
  const row = await db.getFirstAsync<ClaimRow>(
    "SELECT c.*, e.quote, e.origin FROM memory_temporal_claims c " +
    "JOIN memory_temporal_evidence e ON e.claim_id=c.id " +
    "AND e.entity_id=c.entity_id AND e.source_record_version=c.source_record_version " +
    "JOIN memory_entities n ON n.id=c.entity_id AND n.record_version=c.source_record_version " +
    "AND n.record_status='active' WHERE c.id=? ORDER BY e.created_at,e.id LIMIT 1",
    [id],
  );
  if (!row) throw new Error("temporal_source_stale");
  return { claim: fromRow(row), version: row.claim_version };
}

/** Proposed changes remain pending; no source, fact, or validity is altered. */
export async function stageTemporalReviewProposal(
  db: SQL, previousId: string, incomingId: string,
): Promise<string | null> {
  if (!previousId || !incomingId || previousId === incomingId) {
    throw new Error("temporal_proposal_invalid");
  }
  let result: string | null = null;
  await withUnlockedTransaction(db, async tx => {
    const previous = await readCurrentCandidate(tx, previousId);
    const incoming = await readCurrentCandidate(tx, incomingId);
    const kind = compareTemporalCandidates(previous.claim, incoming.claim);
    if (kind !== "possible_change" && kind !== "possible_reconfirmation") return;
    const existing = await tx.getFirstAsync<{ id: string }>(
      "SELECT id FROM memory_temporal_proposals WHERE previous_claim_id=? AND incoming_claim_id=?",
      [previousId,incomingId],
    );
    if (existing) { result = existing.id; return; }
    const id = uid();
    await tx.runAsync(
      "INSERT INTO memory_temporal_proposals " +
      "(id,previous_claim_id,incoming_claim_id,review_kind,status,previous_version," +
      "incoming_version,proposal_version,created_at,updated_at) " +
      "VALUES (?,?,?,?,'pending',?,?,1,?,?)",
      [id,previousId,incomingId,kind,previous.version,incoming.version,
       incoming.claim.recordedAt,incoming.claim.recordedAt],
    );
    result = id;
  });
  return result;
}
