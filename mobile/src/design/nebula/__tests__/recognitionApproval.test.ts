import { recognitionApprovalMatches } from "../recognitionApproval";

const baseline = {
  approved: { profileId: "p1", noteId: "note-1", recordVersion: 7, attachmentId: "file-1" },
  activeProfile: "p1",
  selected: { id: "note-1", record_version: 7, record_status: "active" },
  busy: false, dirty: false, unlocked: true,
};

test("recognition begins only for the exact unlocked note and original after explicit consent", () => {
  expect(recognitionApprovalMatches(baseline)).toBe(true);
});

test.each([
  ["locked", { unlocked: false }],
  ["other profile", { activeProfile: "p2" }],
  ["note changed", { selected: { ...baseline.selected, id: "other-note" } }],
  ["stale CAS version", { selected: { ...baseline.selected, record_version: 8 } }],
  ["already trashed", { selected: { ...baseline.selected, record_status: "trashed" } }],
  ["dirty author text", { dirty: true }],
  ["busy upload", { busy: true }],
  ["missing original", { approved: { ...baseline.approved, attachmentId: "" } }],
  ["note unloaded", { selected: null }],
] as const)("rejects consent after %s", (_label, override) => {
  expect(recognitionApprovalMatches({ ...baseline, ...override })).toBe(false);
});
