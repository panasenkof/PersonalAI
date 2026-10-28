/**
 * №72.2/T2a — user-only, transactional temporal review decisions.
 *
 * A candidate is NOT a confirmed fact. Only an explicit user action with a
 * validated end bound can close a previously open single-valued state.
 * This API is not exposed to an LLM/tool or automatic note-import pipeline.
 * All mutations are on the same unlocked SQLCipher connection.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import {
  compareTemporalCandidates, validateTemporalClaim,
  type TemporalBound,
} from "./temporal-claims";
import { readCurrentCandidate, isStandardTemporalReviewPair } from "./temporal-store";
import { withUnlockedTransaction } from "./transaction";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "runAsync" | "execAsync">;
export type TemporalUserChoice = "accept" | "keep_both" | "defer" | "dismiss";
type ReviewRow = {
  id: string; previous_claim_id: string; incoming_claim_id: string;
  review_kind: "possible_change" | "possible_reconfirmation";
  status: "pending" | "deferred" | "dismissed" | "applied";
  previous_version: number; incoming_version: number; proposal_version: number;
};
type DecisionRow = {
  id: string; proposal_id: string; action: TemporalUserChoice | "undo";
  expected_proposal_version: number; details_json: string;
};
export type TemporalDecisionExpected = {
  proposalId: string; expectedProposalVersion: number;
  expectedPreviousClaimVersion: number; expectedIncomingClaimVersion: number;
};
export type TemporalDecisionRequest = TemporalDecisionExpected & {
  choice: TemporalUserChoice;
  /** MUST come directly from the user's confirmation, never inferred. */
  confirmedEnd?: TemporalBound;
};
export type TemporalDecisionResult = { decisionId: string; nextProposalVersion: number };

const uid = () => Crypto.randomUUID();
const instant = () => new Date().toISOString();
function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function validateExpected(v: TemporalDecisionExpected): void {
  if (!v.proposalId?.trim() || !validVersion(v.expectedProposalVersion) ||
      !validVersion(v.expectedPreviousClaimVersion) ||
      !validVersion(v.expectedIncomingClaimVersion)) throw new Error("temporal_expected_invalid");
}
async function loadReview(db: SQL, id: string): Promise<ReviewRow> {
  const row = await db.getFirstAsync<ReviewRow>(
    "SELECT id,previous_claim_id,incoming_claim_id,review_kind,status," +
    "previous_version,incoming_version,proposal_version FROM memory_temporal_proposals WHERE id=?",
    [id],
  );
  if (!row) throw new Error("temporal_proposal_missing");
  return row;
}
async function checkedReview(db: SQL, expected: TemporalDecisionExpected) {
  const review = await loadReview(db, expected.proposalId);
  if (!await isStandardTemporalReviewPair(db,review.previous_claim_id,review.incoming_claim_id)) {
    throw new Error("temporal_review_not_available");
  }
  if (review.proposal_version !== expected.expectedProposalVersion ||
      review.previous_version !== expected.expectedPreviousClaimVersion ||
      review.incoming_version !== expected.expectedIncomingClaimVersion) {
    throw new Error("temporal_proposal_stale");
  }
  const previous = await readCurrentCandidate(db, review.previous_claim_id);
  const incoming = await readCurrentCandidate(db, review.incoming_claim_id);
  if (previous.version !== expected.expectedPreviousClaimVersion ||
      incoming.version !== expected.expectedIncomingClaimVersion) {
    throw new Error("temporal_claim_stale");
  }
  return { review, previous, incoming };
}
function possibleEarliest(bound: TemporalBound): string | null {
  if (!bound.normalized) return null;
  if (bound.precision === "day") return bound.normalized;
  if (bound.precision === "month") return bound.normalized + "-01";
  if (bound.precision === "year") return bound.normalized + "-01-01";
  return null;
}
function possibleLatest(bound: TemporalBound): string | null {
  if (!bound.normalized) return null;
  if (bound.precision === "day") return bound.normalized;
  if (bound.precision === "year") return bound.normalized + "-12-31";
  if (bound.precision === "month") {
    const [year, month] = bound.normalized.split("-").map(Number);
    const last = new Date(Date.UTC(year,month,0)).getUTCDate();
    return bound.normalized + "-" + String(last).padStart(2,"0");
  }
  return null;
}
function validEndAgainstStart(start: TemporalBound | null, end: TemporalBound): boolean {
  if (!start) return true;
  // Bound precision gives a range, not a fabricated day. Reject only when
  // *all* possible end dates precede *every* possible start date.
  const firstStart = possibleEarliest(start), lastEnd = possibleLatest(end);
  return !firstStart || !lastEnd || lastEnd >= firstStart;
}

/** One explicit decision; no model-generated or inferred closure. */
export async function decideTemporalReview(
  db: SQL, req: TemporalDecisionRequest,
): Promise<TemporalDecisionResult> {
  validateExpected(req);
  if (!["accept","keep_both","defer","dismiss"].includes(req.choice)) {
    throw new Error("temporal_choice_invalid");
  }
  if (req.choice !== "accept" && req.confirmedEnd !== undefined) {
    throw new Error("temporal_end_without_accept");
  }
  if (req.choice === "accept" && !req.confirmedEnd) {
    throw new Error("temporal_user_end_required");
  }
  const decisionId = uid();
  let nextProposalVersion = req.expectedProposalVersion;
  await withUnlockedTransaction(db, async tx => {
    const { review, previous, incoming } = await checkedReview(tx, req);
    if (review.status !== "pending" && review.status !== "deferred") {
      throw new Error("temporal_proposal_not_pending");
    }
    const kind = compareTemporalCandidates(previous.claim, incoming.claim);
    if (kind !== review.review_kind ||
        (req.choice === "accept" && kind !== "possible_change")) {
      throw new Error("temporal_proposal_stale");
    }
    const prior = { endConfirmed: previous.claim.endConfirmed,
      ended: previous.claim.ended, claimVersion: previous.version };
    if (req.choice === "accept") {
      const end = req.confirmedEnd!;
      // Preserve unknown precision instead of assuming the incoming start is
      // the exact end of the previous job/address.
      validateTemporalClaim({ ...previous.claim, ended: end, endConfirmed: true });
      if (!validEndAgainstStart(previous.claim.occurredOrStarted, end)) {
        throw new Error("temporal_end_before_start");
      }
      const changed = await tx.runAsync(
        "UPDATE memory_temporal_claims SET ended_json=?,end_confirmed=1," +
        "claim_version=claim_version+1 WHERE id=? AND claim_version=? AND end_confirmed=0",
        [JSON.stringify(end),review.previous_claim_id,previous.version],
      );
      if (changed.changes !== 1) throw new Error("temporal_claim_stale");
    }
    const status = req.choice === "accept" ? "applied" :
      req.choice === "defer" ? "deferred" : "dismissed";
    const at = instant();
    const changed = await tx.runAsync(
      "UPDATE memory_temporal_proposals SET status=?,proposal_version=proposal_version+1," +
      "updated_at=? WHERE id=? AND proposal_version=? AND status IN ('pending','deferred')",
      [status,at,review.id,review.proposal_version],
    );
    if (changed.changes !== 1) throw new Error("temporal_proposal_stale");
    await tx.runAsync(
      "INSERT INTO memory_temporal_decisions " +
      "(id,proposal_id,action,actor_kind,expected_proposal_version,details_json,created_at) " +
      "VALUES (?,?,?,'user',?,?,?)",
      [decisionId,review.id,req.choice,review.proposal_version,
       JSON.stringify({ schema: 1, priorStatus: review.status, previous: prior,
         confirmedEnd: req.choice === "accept" ? req.confirmedEnd : null,
         incomingClaimVersion: incoming.version }),at],
    );
    nextProposalVersion = review.proposal_version + 1;
  });
  return { decisionId, nextProposalVersion };
}

/** Reverse the most recent user decision, retaining BOTH journal entries. */
export async function undoTemporalReview(
  db: SQL, req: TemporalDecisionExpected & { decisionId: string },
): Promise<TemporalDecisionResult> {
  validateExpected(req);
  if (!req.decisionId?.trim()) throw new Error("temporal_decision_missing");
  const undoId = uid();
  let nextProposalVersion = req.expectedProposalVersion;
  await withUnlockedTransaction(db, async tx => {
    const review = await loadReview(tx,req.proposalId);
    if (!await isStandardTemporalReviewPair(tx,review.previous_claim_id,review.incoming_claim_id)) {
      throw new Error("temporal_review_not_available");
    }
    const priorDecision = await tx.getFirstAsync<DecisionRow>(
      "SELECT id,proposal_id,action,expected_proposal_version,details_json " +
      "FROM memory_temporal_decisions WHERE id=? AND proposal_id=?",
      [req.decisionId,req.proposalId],
    );
    if (!priorDecision || priorDecision.action === "undo") {
      throw new Error("temporal_decision_missing");
    }
    // Only the last single decision can be undone. No late undo is allowed
    // after another user choice, correction or claim source edit.
    if (review.proposal_version !== req.expectedProposalVersion ||
        review.proposal_version !== priorDecision.expected_proposal_version + 1) {
      throw new Error("temporal_undo_stale");
    }
    const expectedStatus = priorDecision.action === "accept" ? "applied" :
      priorDecision.action === "defer" ? "deferred" : "dismissed";
    if (review.status !== expectedStatus) throw new Error("temporal_undo_stale");
    const details: {
      schema: number; priorStatus: ReviewRow["status"];
      previous: { endConfirmed: boolean; ended: TemporalBound | null; claimVersion: number };
      confirmedEnd: TemporalBound | null; incomingClaimVersion: number;
    } = JSON.parse(priorDecision.details_json);
    if (details.schema !== 1 || !["pending","deferred"].includes(details.priorStatus) ||
        !validVersion(details.previous.claimVersion)) throw new Error("temporal_decision_corrupt");
    // readCurrentCandidate verifies source revision, active status and a
    // surviving evidence anchor before reverting the factual state.
    const previous = await readCurrentCandidate(tx, review.previous_claim_id);
    const incoming = await readCurrentCandidate(tx, review.incoming_claim_id);
    if (incoming.version !== req.expectedIncomingClaimVersion ||
        incoming.version !== details.incomingClaimVersion) {
      throw new Error("temporal_undo_stale");
    }
    const expectedPreviousVersion = details.previous.claimVersion +
      (priorDecision.action === "accept" ? 1 : 0);
    if (previous.version !== req.expectedPreviousClaimVersion ||
        previous.version !== expectedPreviousVersion) throw new Error("temporal_undo_stale");
    if (priorDecision.action === "accept") {
      if (!previous.claim.endConfirmed ||
          JSON.stringify(previous.claim.ended) !== JSON.stringify(details.confirmedEnd)) {
        throw new Error("temporal_undo_stale");
      }
      const changed = await tx.runAsync(
        "UPDATE memory_temporal_claims SET ended_json=?,end_confirmed=?," +
        "claim_version=claim_version+1 WHERE id=? AND claim_version=?",
        [details.previous.ended === null ? null : JSON.stringify(details.previous.ended),
         details.previous.endConfirmed ? 1 : 0,review.previous_claim_id,previous.version],
      );
      if (changed.changes !== 1) throw new Error("temporal_undo_stale");
    }
    const at = instant();
    const changed = await tx.runAsync(
      "UPDATE memory_temporal_proposals SET status=?,proposal_version=proposal_version+1," +
      "previous_version=?,updated_at=? WHERE id=? AND proposal_version=?",
      [details.priorStatus,
       previous.version + (priorDecision.action === "accept" ? 1 : 0),
       at,review.id,review.proposal_version],
    );
    if (changed.changes !== 1) throw new Error("temporal_undo_stale");
    await tx.runAsync(
      "INSERT INTO memory_temporal_decisions " +
      "(id,proposal_id,action,actor_kind,expected_proposal_version,details_json,created_at) " +
      "VALUES (?,?,'undo','user',?,?,?)",
      [undoId,review.id,review.proposal_version,
       JSON.stringify({ schema:1, undoes:priorDecision.id,from:review.status,to:details.priorStatus }),at],
    );
    nextProposalVersion = review.proposal_version + 1;
  });
  return { decisionId: undoId, nextProposalVersion };
}
