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
type ScanSQL = SQL & Pick<SQLite.SQLiteDatabase, "getAllAsync">;
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
    await insertTemporalCandidate(tx, candidate, id, evidenceId);
  });
  return id;
}

async function insertTemporalCandidate(
  db: SQL, candidate: TemporalClaimCandidate, id: string, evidenceId: string,
): Promise<void> {
  await requireCurrentSource(db, candidate.evidence.entityId, candidate.evidence.recordVersion);
  await db.runAsync(
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
  await db.runAsync(
    "INSERT INTO memory_temporal_evidence " +
    "(id,claim_id,entity_id,source_record_version,quote,origin,created_at) VALUES (?,?,?,?,?,?,?)",
    [evidenceId,id,candidate.evidence.entityId,candidate.evidence.recordVersion,
     candidate.evidence.quote,candidate.evidence.origin,candidate.recordedAt],
  );
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


/** T2b: one bounded *same-collection standard-scope* scan on explicit typed input.
 *
 * Caller still owns the decision to extract/submit a claim and must provide a
 * stable source revision. This API never executes a background LLM or resolves
 * identities by names. A result is a proposal, not an accepted current fact.
 */
export type TemporalStagedReview = {
  claimId: string;
  proposalIds: string[];
  /** True means candidate search was capped and is NOT exhaustive. */
  truncated: boolean;
  /** Protected/unclassified sources are preserved, but never cross-scope scanned. */
  reviewScope: "standard" | "skipped_privacy" | "not_eligible";
};
const MAX_TEMPORAL_PREVIOUS = 32;

type EligibleSource = {
  collection_id: string; collection_sensitivity: string; entity_sensitivity: string;
};
type ExistingReview = { id: string };
type PreviousReviewCandidate = { id: string };

export async function stageTemporalCandidateWithReview(
  db: ScanSQL, candidate: TemporalClaimCandidate,
): Promise<TemporalStagedReview> {
  validateTemporalClaim(candidate);
  const id = uid(), evidenceId = uid();
  const result: TemporalStagedReview = {
    claimId:id,proposalIds:[],truncated:false,reviewScope:"not_eligible",
  };
  await withUnlockedTransaction(db, async tx => {
    // A single transaction guards both source revision and candidate discovery.
    await insertTemporalCandidate(tx,candidate,id,evidenceId);
    if (candidate.kind !== "state" || candidate.cardinality !== "single" ||
        !candidate.subjectId || candidate.modality !== "asserted" ||
        candidate.negated || candidate.endConfirmed || candidate.evidence.origin !== "direct") return;
    const source = await tx.getFirstAsync<EligibleSource>(
      "SELECT e.collection_id, col.sensitivity AS collection_sensitivity," +
      "e.sensitivity AS entity_sensitivity FROM memory_entities e " +
      "JOIN memory_collections col ON col.id=e.collection_id " +
      "WHERE e.id=? AND e.record_version=? AND e.record_status='active'",
      [candidate.evidence.entityId,candidate.evidence.recordVersion],
    );
    if (!source) throw new Error("temporal_source_stale");
    // Deliberately avoid cross-collection and private/unclassified metadata
    // disclosure. A future user-scoped review API may support them separately.
    if (source.collection_sensitivity !== "standard" ||
        !["standard","inherit"].includes(source.entity_sensitivity)) {
      result.reviewScope = "skipped_privacy"; return;
    }
    result.reviewScope = "standard";
    const previous = await tx.getAllAsync<PreviousReviewCandidate>(
      "SELECT c.id FROM memory_temporal_claims c " +
      "JOIN memory_entities e ON e.id=c.entity_id " +
      "AND e.record_version=c.source_record_version AND e.record_status='active' " +
      "JOIN memory_collections col ON col.id=e.collection_id " +
      "WHERE c.subject_id=? AND c.predicate=? AND c.context=? " +
      "AND c.id<>? AND c.temporal_kind='state' AND c.modality='asserted' " +
      "AND c.negated=0 AND c.cardinality='single' AND c.end_confirmed=0 " +
      "AND c.knowledge_recorded_at<=? AND e.collection_id=? " +
      "AND col.sensitivity='standard' AND e.sensitivity IN ('standard','inherit') " +
      "ORDER BY c.knowledge_recorded_at DESC,c.id DESC LIMIT ?",
      [candidate.subjectId,candidate.predicate,candidate.context,id,
       candidate.recordedAt,source.collection_id,MAX_TEMPORAL_PREVIOUS+1],
    );
    result.truncated=previous.length>MAX_TEMPORAL_PREVIOUS;
    // Leave the latest 32 candidates unchanged; old events, unresolved
    // identities and other roles are never closed merely due to new notes.
    for (const row of previous.slice(0,MAX_TEMPORAL_PREVIOUS)) {
      const before = await readCurrentCandidate(tx,row.id);
      const kind = compareTemporalCandidates(before.claim,candidate);
      if (kind !== "possible_change" && kind !== "possible_reconfirmation") continue;
      const already = await tx.getFirstAsync<ExistingReview>(
        "SELECT id FROM memory_temporal_proposals WHERE previous_claim_id=? AND incoming_claim_id=?",
        [row.id,id],
      );
      if (already) continue; // preserve previous reject/defer/accept decisions
      const proposalId=uid();
      await tx.runAsync(
        "INSERT INTO memory_temporal_proposals " +
        "(id,previous_claim_id,incoming_claim_id,review_kind,status,previous_version," +
        "incoming_version,proposal_version,created_at,updated_at) " +
        "VALUES (?,?,?,?,'pending',?,?,1,?,?)",
        [proposalId,row.id,id,kind,before.version,1,candidate.recordedAt,candidate.recordedAt],
      );
      result.proposalIds.push(proposalId);
    }
  });
  return result;
}


/**
 * №72.3/T3a: source-backed, bounded knowledge-history listing.
 *
 * This is intentionally NOT a "what is true now?" query: temporal rows are
 * candidates until the full accepted-claim lifecycle has been implemented.
 * No claim with a stale/archived source or outside standard ACL is surfaced.
 * The cursor orders by *knowledge/recorded time*, never pretending it is the
 * occurrence date. Native current/as-of/events reasoning follows in T3b.
 */
export type TemporalHistoryMode = "all" | "states" | "events";
export type TemporalHistoryCursor = { recordedAt: string; claimId: string };
export type TemporalHistoryItem = {
  claimId: string; claimVersion: number;
  claim: TemporalClaimCandidate;
  /** A proposal to revise is not sufficient to mark this claim confirmed. */
  verification: "candidate_unconfirmed";
};
export type TemporalHistoryPage = {
  items: TemporalHistoryItem[]; nextCursor: TemporalHistoryCursor | null;
};
export type TemporalHistoryQuery = {
  subjectId: string; collectionId: string;
  mode: TemporalHistoryMode; limit?: number;
  before?: TemporalHistoryCursor;
};

export async function listTemporalKnowledgeHistory(
  db: ScanSQL, query: TemporalHistoryQuery,
): Promise<TemporalHistoryPage> {
  if (!query.subjectId?.trim() || !query.collectionId?.trim() ||
      query.subjectId.length > 256 || query.collectionId.length > 256 ||
      !["all","states","events"].includes(query.mode)) {
    throw new Error("temporal_history_scope_invalid");
  }
  const limit=query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("temporal_history_limit_invalid");
  }
  if (query.before && (!query.before.claimId?.trim() ||
      query.before.claimId.length > 256 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(query.before.recordedAt) ||
      !Number.isFinite(Date.parse(query.before.recordedAt)) ||
      new Date(query.before.recordedAt).toISOString() !== query.before.recordedAt)) {
    throw new Error("temporal_history_cursor_invalid");
  }
  const where=[
    "c.subject_id=?", "e.collection_id=?", "col.sensitivity='standard'",
    "e.sensitivity IN ('standard','inherit')",
    "e.record_status='active'", "e.record_version=c.source_record_version",
  ];
  const params: (string|number)[]=[query.subjectId,query.collectionId];
  if (query.mode !== "all") {
    where.push("c.temporal_kind=?");
    params.push(query.mode==="states"?"state":"event");
  }
  if (query.before) {
    where.push("(c.knowledge_recorded_at<? OR (c.knowledge_recorded_at=? AND c.id<?))");
    params.push(query.before.recordedAt,query.before.recordedAt,query.before.claimId);
  }
  params.push(limit+1);
  const rows=await db.getAllAsync<ClaimRow>(
    "SELECT c.*, evidence.quote, evidence.origin FROM memory_temporal_claims c " +
    "JOIN memory_entities e ON e.id=c.entity_id " +
    "JOIN memory_collections col ON col.id=e.collection_id " +
    "JOIN memory_temporal_evidence evidence ON evidence.id=(" +
    "SELECT ev.id FROM memory_temporal_evidence ev WHERE ev.claim_id=c.id " +
    "AND ev.entity_id=c.entity_id AND ev.source_record_version=c.source_record_version " +
    "ORDER BY ev.created_at,ev.id LIMIT 1) " +
    "WHERE "+where.join(" AND ")+" "+
    "ORDER BY c.knowledge_recorded_at DESC,c.id DESC LIMIT ?",
    params,
  );
  const visible=rows.slice(0,limit);
  const items=visible.map(row=>({
    claimId:row.id,claimVersion:row.claim_version,claim:fromRow(row),
    verification:"candidate_unconfirmed" as const,
  }));
  const last=visible.at(-1);
  return {
    items,
    nextCursor:rows.length>limit && last
      ? { recordedAt:last.knowledge_recorded_at,claimId:last.id } : null,
  };
}


/**
 * №72.3/T3b1: query typed source-backed state *candidates* for a VALID date.
 * This does not reconstruct "what PersAI knew on that date": knowledge time
 * remains recordedAt, and decision history needs its own snapshot read.
 * Neither an open state nor an accepted end makes the incoming claim true.
 */
export type TemporalAtDateFit = "potentially_applicable" | "boundary_uncertain" | "outside_date";
export type TemporalAtDateQuery = {
  subjectId: string;
  collectionId: string;
  predicate: string;
  context: string;
  validDate: string;
  limit?: number;
  before?: TemporalHistoryCursor;
};
export type TemporalAtDateItem = TemporalHistoryItem & { timeFit: TemporalAtDateFit };
export type TemporalAtDatePage = {
  items: TemporalAtDateItem[];
  nextCursor: TemporalHistoryCursor | null;
  /** More source-current candidates may exist beyond the requested page. */
  partial: boolean;
};

function temporalValidDate(value: string): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day]=value.split("-").map(Number);
  if (year<1000 || year>9999) return false;
  const result=new Date(Date.UTC(year,month-1,day));
  return result.toISOString().slice(0,10)===value;
}
function temporalUtcInstant(value: string): boolean {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString()===value;
}
function dateExtent(bound: TemporalBound | null): { first: string; last: string } | null {
  if (!bound?.normalized) return null;
  const raw=bound.normalized;
  if (bound.precision==="day") return {first:raw,last:raw};
  if (bound.precision==="year") return {first:raw+"-01-01",last:raw+"-12-31"};
  if (bound.precision==="month") {
    const [year,month]=raw.split("-").map(Number);
    return {first:raw+"-01",last:raw+"-"+String(new Date(Date.UTC(year,month,0)).getUTCDate()).padStart(2,"0")};
  }
  return null;
}

/** Compare ranges without inventing a day for imprecise starts or ends. */
export function temporalFitAtDate(
  claim: TemporalClaimCandidate, validDate: string,
): TemporalAtDateFit {
  validateTemporalClaim(claim);
  if (!temporalValidDate(validDate)) throw new Error("temporal_query_date_invalid");
  if (claim.kind!=="state" || claim.modality!=="asserted" || claim.negated) {
    return "outside_date";
  }
  const start=dateExtent(claim.occurredOrStarted);
  const end=claim.endConfirmed ? dateExtent(claim.ended) : null;
  if (start && validDate<start.first) return "outside_date";
  if (end && validDate>end.last) return "outside_date";
  // Unknown starts/ends and a year/month boundary may overlap or not.
  if (!start || (start.first!==start.last && validDate<=start.last) ||
      (claim.endConfirmed && (!end || (end.first!==end.last && validDate>=end.first)))) {
    return "boundary_uncertain";
  }
  // Source is still a candidate. This means only "time bounds allow it",
  // never that it is a user-approved current state.
  return "potentially_applicable";
}

/** Source-revision/ACL-filtered, keyset-paged valid-time evidence.
 *
 * A SQL bound on predicate/context avoids silently missing relevant states
 * due to a global top-N truncation. Caller must paginate for complete results.
 */
export async function listTemporalStateCandidatesAtDate(
  db: ScanSQL, query: TemporalAtDateQuery,
): Promise<TemporalAtDatePage> {
  if (!query.subjectId?.trim() || !query.collectionId?.trim() ||
      !query.predicate?.trim() || !query.context?.trim() ||
      query.subjectId.length>256 || query.collectionId.length>256 ||
      query.predicate.length>120 || query.context.length>120) {
    throw new Error("temporal_query_scope_invalid");
  }
  if (!temporalValidDate(query.validDate)) throw new Error("temporal_query_date_invalid");
  const limit=query.limit??20;
  if (!Number.isSafeInteger(limit) || limit<1 || limit>50) {
    throw new Error("temporal_query_limit_invalid");
  }
  if (query.before && (!query.before.claimId?.trim() ||
      query.before.claimId.length>256 || !temporalUtcInstant(query.before.recordedAt))) {
    throw new Error("temporal_query_cursor_invalid");
  }
  const where=[
    "c.subject_id=?","c.predicate=?","c.context=?","c.temporal_kind='state'",
    "c.modality='asserted'","c.negated=0",
    "e.collection_id=?","col.sensitivity='standard'",
    "e.sensitivity IN ('standard','inherit')","e.record_status='active'",
    "e.record_version=c.source_record_version",
  ];
  const args:(string|number)[]=[
    query.subjectId,query.predicate,query.context,query.collectionId,
  ];
  if (query.before) {
    where.push("(c.knowledge_recorded_at<? OR (c.knowledge_recorded_at=? AND c.id<?))");
    args.push(query.before.recordedAt,query.before.recordedAt,query.before.claimId);
  }
  args.push(limit+1);
  const rows=await db.getAllAsync<ClaimRow>(
    "SELECT c.*, ev.quote, ev.origin FROM memory_temporal_claims c "+
    "JOIN memory_entities e ON e.id=c.entity_id "+
    "JOIN memory_collections col ON col.id=e.collection_id "+
    "JOIN memory_temporal_evidence ev ON ev.id=("+
    "SELECT witness.id FROM memory_temporal_evidence witness "+
    "WHERE witness.claim_id=c.id AND witness.entity_id=c.entity_id "+
    "AND witness.source_record_version=c.source_record_version "+
    "ORDER BY witness.created_at,witness.id LIMIT 1) "+
    "WHERE "+where.join(" AND ")+" "+
    "ORDER BY c.knowledge_recorded_at DESC,c.id DESC LIMIT ?",
    args,
  );
  const visible=rows.slice(0,limit);
  const items=visible.map(row=>{
    const claim=fromRow(row);
    return {claimId:row.id,claimVersion:row.claim_version,claim,
      verification:"candidate_unconfirmed" as const,
      timeFit:temporalFitAtDate(claim,query.validDate)};
  });
  const last=visible.at(-1);
  return {
    items,
    nextCursor:rows.length>limit && last
      ? {recordedAt:last.knowledge_recorded_at,claimId:last.id} : null,
    partial:rows.length>limit,
  };
}
