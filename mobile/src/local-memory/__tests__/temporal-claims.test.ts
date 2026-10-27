import {
  compareTemporalCandidates, validateTemporalClaim,
  type TemporalClaimCandidate, type TemporalBound,
} from "../temporal-claims";

const date = (normalized: string): TemporalBound => ({
  normalized, precision: "day", raw: normalized,
  anchorDate: "2026-10-27", sourceTimeZone: "Europe/Berlin",
});
function claim(patch: Partial<TemporalClaimCandidate> = {}): TemporalClaimCandidate {
  return {
    subjectId: "person-user", predicate: "employment", context: "primary",
    value: "A", kind: "state", modality: "asserted", negated: false,
    cardinality: "single", occurredOrStarted: date("2020-01-01"),
    ended: null, endConfirmed: false,
    evidence: { entityId: "note-1", recordVersion: 1,
      quote: "Работаю в A", origin: "direct" },
    ...patch,
  };
}

test("two spark-plug replacements remain two events, even when a later imported receipt is older", () => {
  const old = claim({ kind: "event", predicate: "replace_spark_plugs",
    context: "vehicle-1", value: "changed", occurredOrStarted: date("2023-03-01") });
  const recent = claim({ ...old, occurredOrStarted: date("2025-03-01") });
  const backdated = claim({ ...old, occurredOrStarted: date("2022-03-01") });
  expect(compareTemporalCandidates(old, recent)).toBe("independent");
  expect(compareTemporalCandidates(recent, backdated)).toBe("independent");
});

test("only explicitly single-valued identical subject+role can suggest a change", () => {
  const original = claim();
  expect(compareTemporalCandidates(original, claim({ value: "B" }))).toBe("possible_change");
  expect(compareTemporalCandidates(original, claim({ value: "A" })))
    .toBe("possible_reconfirmation");
  expect(compareTemporalCandidates(original, claim({ value: "B", context: "secondary" })))
    .toBe("independent");
  expect(compareTemporalCandidates(original, claim({ value: "B", cardinality: "multiple" })))
    .toBe("independent");
  expect(compareTemporalCandidates(original, claim({ value: "B", cardinality: "unknown" })))
    .toBe("independent");
  expect(compareTemporalCandidates(original, claim({ value: "B", subjectId: "person-2" })))
    .toBe("independent");
});

test("planned move, hypothetical or negated work, derived LLM assertion never ends a state", () => {
  const original = claim({ predicate: "residence", context: "actual_primary" });
  for (const extra of [
    { modality: "planned" as const }, { modality: "hypothetical" as const },
    { negated: true }, { evidence: { entityId: "note-2", recordVersion: 1,
      quote: "model suggested", origin: "derived" as const } },
  ]) {
    expect(compareTemporalCandidates(original, claim({
      predicate: "residence", context: "actual_primary", value: "B", ...extra,
    }))).toBe("independent");
  }
  expect(compareTemporalCandidates(original, claim({
    predicate: "residence", context: "registered_address", value: "B",
  }))).toBe("independent");
});

test("unresolved identity never assumes that two Lizas or cars are the same", () => {
  expect(compareTemporalCandidates(claim({ subjectId: null }), claim({ value: "B" })))
    .toBe("identity_unresolved");
  expect(compareTemporalCandidates(claim(), claim({ subjectId: null, value: "B" })))
    .toBe("identity_unresolved");
});

test("unknown end is not interpreted as still current; confirmed end blocks transition inference", () => {
  const unknownEnd = claim();
  expect(unknownEnd.ended).toBeNull();
  const explicitlyFinished = claim({ endConfirmed: true, ended: {
    normalized: null, precision: "unknown", raw: "Больше не работаю в А",
    anchorDate: null, sourceTimeZone: null,
  } });
  validateTemporalClaim(explicitlyFinished);
  expect(compareTemporalCandidates(explicitlyFinished, claim({ value: "B" })))
    .toBe("independent");
});

test("exact calendar validation rejects fake dates and refuses to invent precision", () => {
  expect(() => validateTemporalClaim(claim({
    occurredOrStarted: date("2025-02-30"),
  }))).toThrow("temporal_bound_invalid");
  expect(() => validateTemporalClaim(claim({
    occurredOrStarted: { ...date("2025-01-01"), precision: "approximate" },
  }))).toThrow("temporal_bound_invalid");
  const relative = {
    normalized: null, precision: "approximate" as const, raw: "Год назад",
    anchorDate: "2020-10-27", sourceTimeZone: "Europe/Moscow",
  };
  expect(() => validateTemporalClaim(claim({ occurredOrStarted: relative }))).not.toThrow();
  expect(() => validateTemporalClaim(claim({ occurredOrStarted: {
    ...relative, anchorDate: "2020-13-01",
  } }))).toThrow("temporal_bound_invalid");
});

test("never accept unconfirmed end date, phantom source or invalid evidence revision", () => {
  expect(() => validateTemporalClaim(claim({
    ended: date("2024-09-01"),
  }))).toThrow("end_requires_explicit_confirmation");
  expect(() => validateTemporalClaim(claim({
    evidence: { entityId: "note-1", recordVersion: 0,
      origin: "direct", quote: "В А" },
  }))).toThrow("temporal_evidence_invalid");
  expect(() => validateTemporalClaim(claim({
    evidence: { entityId: "note-1", recordVersion: 1,
      origin: "derived", quote: "" },
  }))).toThrow("temporal_evidence_invalid");
});

test("observations and lasting attributes are not automatically overwritten", () => {
  for (const kind of ["observation", "enduring"] as const) {
    expect(compareTemporalCandidates(claim({ kind }), claim({ kind, value: "B" })))
      .toBe("independent");
  }
});
