/**
 * Temporal review inbox: local, evidence-backed, bounded and standard-scope.
 *
 * A proposal is not a confirmed fact. This read API is intentionally separate
 * from the model tool surface and requires an unlocked SQLCipher connection.
 * It does NOT infer identity, traverse private collections or apply decisions.
 */
import type * as SQLite from "expo-sqlite";
import type { TemporalClaimCandidate } from "./temporal-claims";
import { readCurrentCandidate } from "./temporal-store";

type SQL = Pick<SQLite.SQLiteDatabase, "getAllAsync" | "getFirstAsync">;
export type TemporalInboxStatus = "pending" | "deferred";
export type TemporalInboxCursor = { createdAt: string; proposalId: string };
export type TemporalInboxQuery = {
  collectionId: string;
  limit?: number;
  before?: TemporalInboxCursor;
};
export type TemporalInboxItem = {
  proposalId: string;
  reviewKind: "possible_change" | "possible_reconfirmation";
  status: TemporalInboxStatus;
  expectedProposalVersion: number;
  expectedPreviousClaimVersion: number;
  expectedIncomingClaimVersion: number;
  previous: TemporalClaimCandidate;
  incoming: TemporalClaimCandidate;
};
export type TemporalInboxPage = {
  items: TemporalInboxItem[];
  nextCursor: TemporalInboxCursor | null;
};

type ProposalRow = {
  id: string;
  created_at: string;
  review_kind: TemporalInboxItem["reviewKind"];
  status: TemporalInboxStatus;
  previous_claim_id: string;
  incoming_claim_id: string;
  previous_version: number;
  incoming_version: number;
  proposal_version: number;
};

const isTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/**
 * List only proposals for two currently readable, source-version-matching
 * claims in the same standard collection. Sources with no remaining evidence
 * are excluded before the limit/cursor is computed.
 */
export async function listTemporalReviewInbox(
  db: SQL, query: TemporalInboxQuery,
): Promise<TemporalInboxPage> {
  if (typeof query.collectionId !== "string" ||
      !query.collectionId.trim() || query.collectionId.length > 256) {
    throw new Error("temporal_review_scope_invalid");
  }
  const limit = query.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("temporal_review_limit_invalid");
  }
  if (query.before && (
      typeof query.before.proposalId !== "string" ||
      !query.before.proposalId.trim() ||
      query.before.proposalId.length > 256 ||
      !isTimestamp(query.before.createdAt))) {
    throw new Error("temporal_review_cursor_invalid");
  }
  const where = [
    "p.status IN ('pending','deferred')",
    "pre.entity_id<>post.entity_id OR pre.id<>post.id",
    "src_pre.collection_id=? AND src_post.collection_id=?",
    "col_pre.sensitivity='standard' AND col_post.sensitivity='standard'",
    "src_pre.sensitivity IN ('standard','inherit')",
    "src_post.sensitivity IN ('standard','inherit')",
    "src_pre.record_status='active' AND src_post.record_status='active'",
    "src_pre.record_version=pre.source_record_version",
    "src_post.record_version=post.source_record_version",
    "p.previous_version=pre.claim_version AND p.incoming_version=post.claim_version",
    "EXISTS (SELECT 1 FROM memory_temporal_evidence ep WHERE ep.claim_id=pre.id " +
      "AND ep.entity_id=pre.entity_id AND ep.source_record_version=pre.source_record_version)",
    "EXISTS (SELECT 1 FROM memory_temporal_evidence ei WHERE ei.claim_id=post.id " +
      "AND ei.entity_id=post.entity_id AND ei.source_record_version=post.source_record_version)",
  ];
  const params: (string | number)[] = [query.collectionId, query.collectionId];
  if (query.before) {
    where.push("(p.created_at<? OR (p.created_at=? AND p.id<?))");
    params.push(query.before.createdAt, query.before.createdAt, query.before.proposalId);
  }
  params.push(limit+1);
  const rows = await db.getAllAsync<ProposalRow>(
    "SELECT p.id,p.created_at,p.review_kind,p.status,p.previous_claim_id," +
    "p.incoming_claim_id,p.previous_version,p.incoming_version,p.proposal_version " +
    "FROM memory_temporal_proposals p " +
    "JOIN memory_temporal_claims pre ON pre.id=p.previous_claim_id " +
    "JOIN memory_temporal_claims post ON post.id=p.incoming_claim_id " +
    "JOIN memory_entities src_pre ON src_pre.id=pre.entity_id " +
    "JOIN memory_entities src_post ON src_post.id=post.entity_id " +
    "JOIN memory_collections col_pre ON col_pre.id=src_pre.collection_id " +
    "JOIN memory_collections col_post ON col_post.id=src_post.collection_id " +
    "WHERE " + where.join(" AND ") +
    " ORDER BY p.created_at DESC,p.id DESC LIMIT ?",
    params,
  );
  const visible = rows.slice(0,limit);
  const items: TemporalInboxItem[] = [];
  for (const row of visible) {
    // Revalidate source evidence at the point of constructing each card.
    const previous = await readCurrentCandidate(db,row.previous_claim_id);
    const incoming = await readCurrentCandidate(db,row.incoming_claim_id);
    if (previous.version !== row.previous_version || incoming.version !== row.incoming_version) {
      throw new Error("temporal_review_stale");
    }
    items.push({
      proposalId: row.id, reviewKind: row.review_kind, status: row.status,
      expectedProposalVersion: row.proposal_version,
      expectedPreviousClaimVersion: row.previous_version,
      expectedIncomingClaimVersion: row.incoming_version,
      previous: previous.claim, incoming: incoming.claim,
    });
  }
  const last=visible.at(-1);
  return {
    items,
    nextCursor:rows.length>limit && last
      ? {createdAt:last.created_at,proposalId:last.id} : null,
  };
}
