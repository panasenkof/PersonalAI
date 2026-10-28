/**
 * №72.1 / T1: typed, deterministic temporal-claim candidate boundary.
 *
 * A candidate is NOT a confirmed fact and this module NEVER changes records,
 * decides that an old state ended, or promotes LLM interpretations to evidence.
 * The future SQLCipher claim/evidence/proposal migration will consume this
 * contract; existing memory_entities and source/extraction tables remain truth.
 */
export type TemporalKind = "event" | "state" | "observation" | "enduring";
export type TemporalModality = "asserted" | "planned" | "hypothetical";
export type TemporalPrecision = "day" | "month" | "year" | "approximate" | "unknown";
export type TemporalCardinality = "single" | "multiple" | "unknown";

/** A null normalized value is unknown, NOT today, ongoing, or a point-in-time. */
export type TemporalBound = {
  normalized: string | null;
  precision: TemporalPrecision;
  raw: string;
  anchorDate: string | null;
  sourceTimeZone: string | null;
};

export type TemporalEvidenceRef = {
  entityId: string;
  recordVersion: number;
  /** Exact source wording, never a model-invented attribution. */
  quote: string;
  /** An extraction from a model is not user confirmation. */
  origin: "direct" | "derived";
};

export type TemporalClaimCandidate = {
  /** Knowledge/ingestion time, separate from when the statement held in life. */
  recordedAt: string;
  /** Identity must already be resolved before suggesting a change. */
  subjectId: string | null;
  predicate: string;
  /** E.g. employment.primary vs employment.secondary; residence.actual vs registration. */
  context: string;
  value: string;
  kind: TemporalKind;
  modality: TemporalModality;
  negated: boolean;
  /** Explicit property-and-context cardinality, never inferred from personhood. */
  cardinality: TemporalCardinality;
  occurredOrStarted: TemporalBound | null;
  ended: TemporalBound | null;
  /** End can be confirmed despite an unknown date. No inferred end on insert. */
  endConfirmed: boolean;
  evidence: TemporalEvidenceRef;
};

function isRecordedInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const time = Date.UTC(year, month - 1, day);
  return year >= 1000 && year <= 9999 &&
    new Date(time).toISOString().slice(0, 10) === date;
}
function isDateForPrecision(date: string, precision: TemporalPrecision): boolean {
  if (precision === "day") return isCalendarDate(date);
  if (precision === "month") return /^(1\d{3}|[2-9]\d{3})-(0[1-9]|1[0-2])$/.test(date);
  if (precision === "year") return /^(1\d{3}|[2-9]\d{3})$/.test(date);
  return false; // approximate and unknown cannot silently become exact
}
function validBound(bound: TemporalBound | null): boolean {
  if (!bound) return true;
  if (!bound.raw.trim() || bound.raw.length > 500) return false;
  if (bound.anchorDate !== null && !isCalendarDate(bound.anchorDate)) return false;
  if (bound.sourceTimeZone !== null &&
    (bound.sourceTimeZone.trim().length === 0 || bound.sourceTimeZone.length > 80)) return false;
  if (bound.precision === "unknown" || bound.precision === "approximate") {
    return bound.normalized === null;
  }
  return bound.normalized !== null && isDateForPrecision(bound.normalized, bound.precision);
}


/** Inclusive calendar range of a date with declared precision.
 * Unknown/approximate never become a guessed exact date. */
function earliestValidDay(bound: TemporalBound | null): string | null {
  if (!bound?.normalized) return null;
  if (bound.precision === "day") return bound.normalized;
  if (bound.precision === "month") return bound.normalized + "-01";
  if (bound.precision === "year") return bound.normalized + "-01-01";
  return null;
}
function latestValidDay(bound: TemporalBound | null): string | null {
  if (!bound?.normalized) return null;
  if (bound.precision === "day") return bound.normalized;
  if (bound.precision === "year") return bound.normalized + "-12-31";
  if (bound.precision === "month") {
    const [year, month] = bound.normalized.split("-").map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return bound.normalized + "-" + String(last).padStart(2,"0");
  }
  return null;
}

/** Reject guessed precision and provenance before any future persistence. */
export function validateTemporalClaim(value: TemporalClaimCandidate): void {
  if (!["state","event","observation","enduring"].includes(value.kind) ||
      !["asserted","planned","hypothetical"].includes(value.modality) ||
      !["single","multiple","unknown"].includes(value.cardinality) ||
      typeof value.negated !== "boolean" || typeof value.endConfirmed !== "boolean") {
    throw new Error("temporal_type_invalid");
  }
  if (!isRecordedInstant(value.recordedAt)) throw new Error("temporal_recorded_at_invalid");
  if (!value.predicate.trim() || !value.context.trim() || !value.value.trim() ||
      value.predicate.length > 120 || value.context.length > 120 ||
      value.value.length > 3000) throw new Error("temporal_claim_fields_invalid");
  if (value.subjectId !== null && !value.subjectId.trim()) {
    throw new Error("temporal_subject_invalid");
  }
  if (!validBound(value.occurredOrStarted) || !validBound(value.ended)) {
    throw new Error("temporal_bound_invalid");
  }
  if (value.endConfirmed && value.kind !== "state") {
    throw new Error("only_state_can_confirm_end");
  }
  if (value.ended !== null && !value.endConfirmed) {
    throw new Error("end_requires_explicit_confirmation");
  }
  // Reject impossible closed intervals; a coarse year/month denotes a range,
  // not its first guessed day. Unknown/approximate endpoints remain unknown.
  if (value.endConfirmed && value.ended !== null) {
    const earliestStart = earliestValidDay(value.occurredOrStarted);
    const latestEnd = latestValidDay(value.ended);
    if (earliestStart && latestEnd && latestEnd < earliestStart) {
      throw new Error("temporal_end_before_start");
    }
  }
  if (!value.evidence.entityId.trim() ||
      !Number.isSafeInteger(value.evidence.recordVersion) ||
      value.evidence.recordVersion < 1 ||
      !value.evidence.quote.trim() || value.evidence.quote.length > 6000) {
    throw new Error("temporal_evidence_invalid");
  }
}

export type TemporalReview =
  | "independent" | "identity_unresolved" | "possible_change" | "possible_reconfirmation";

/**
 * Bounded, conservative candidate comparison, not a write/apply API.
 * Even "possible_change" does not end an earlier state.
 * User confirmation, source CAS and history are required in T2.
 */
export function compareTemporalCandidates(
  previous: TemporalClaimCandidate, incoming: TemporalClaimCandidate,
): TemporalReview {
  validateTemporalClaim(previous);
  validateTemporalClaim(incoming);
  if (previous.kind !== "state" || incoming.kind !== "state" ||
      previous.predicate !== incoming.predicate ||
      previous.context !== incoming.context) return "independent";
  if (!previous.subjectId || !incoming.subjectId) return "identity_unresolved";
  if (previous.subjectId !== incoming.subjectId) return "independent";
  if (previous.modality !== "asserted" || incoming.modality !== "asserted" ||
      previous.negated || incoming.negated ||
      previous.evidence.origin !== "direct" || incoming.evidence.origin !== "direct" ||
      previous.endConfirmed) return "independent";
  // Part-time jobs and addresses can coexist; only explicitly single-valued
  // property+role combinations are even eligible for a proposed transition.
  if (previous.cardinality !== "single" || incoming.cardinality !== "single") {
    return "independent";
  }
  // An old payslip or historical residence entered today must not propose
  // terminating a newer state. Compare VALID time, not ingestion timestamps.
  // A separate "historical overlap/conflict" review will handle these cases.
  const earlierStart = earliestValidDay(previous.occurredOrStarted);
  const latestIncomingStart = latestValidDay(incoming.occurredOrStarted);
  if (earlierStart && latestIncomingStart && latestIncomingStart < earlierStart) {
    return "independent";
  }
  return previous.value === incoming.value
    ? "possible_reconfirmation" : "possible_change";
}
