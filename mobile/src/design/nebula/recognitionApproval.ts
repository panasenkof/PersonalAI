/**
 * One-file recognition consent. This read-only guard is checked on the FINAL
 * button tap; the canonical writer still checks current SQLCipher CAS, source
 * revision and ACL again before any remote upload or candidate application.
 */
export function recognitionApprovalMatches(input: {
  approved: { profileId: string; noteId: string; recordVersion: number; attachmentId: string };
  activeProfile: string | null | undefined;
  selected: { id: string; record_version: number; record_status: string } | null;
  busy: boolean;
  dirty: boolean;
  unlocked: boolean;
}): boolean {
  const { approved, activeProfile, selected, busy, dirty, unlocked } = input;
  return unlocked && !busy && !dirty &&
    Boolean(activeProfile && activeProfile === approved.profileId &&
      approved.attachmentId && approved.noteId &&
      selected && selected.id === approved.noteId &&
      selected.record_version === approved.recordVersion &&
      selected.record_status === "active");
}
