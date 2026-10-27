/**
 * №66.4 R0: conservative, deterministic proof-path evaluator.
 *
 * Does not read the database, infer a person's identity from their name,
 * attach an audio file from a mere mention or create a confirmed relation.
 * Caller MUST supply ACL-scoped and source-version-verified graph edges.
 * The future SQLCipher relation evidence store feeds this pure contract.
 */
export type RelationProofKind = "sibling_of" | "participant_of" | "mentioned_in" | "about";
export type RelationProofStatus = "pending" | "confirmed" | "rejected" | "deferred" | "retracted";
export type RelationProof = {
  id: string;
  kind: RelationProofKind;
  sourceEntityId: string;
  targetEntityId: string;
  sourceRecordVersion: number;
  targetRecordVersion: number;
  evidenceEntityId: string;
  evidenceRecordVersion: number;
  evidenceQuote: string;
  status: RelationProofStatus;
  evidenceState: "current" | "stale" | "withdrawn";
  identityState: "resolved" | "ambiguous" | "unresolved";
};
/** This map carries version numbers only for records the caller is permitted to use. */
export type ProofAccess = {
  recordVersions: ReadonlyMap<string, number>;
  readableEvidence: ReadonlySet<string>;
};
export type RelativeConversation = {
  conversationId: string;
  relativeId: string;
  relationEvidenceId: string;
  participantEvidenceId: string;
};
export type RelativeConversationResult = {
  paths: RelativeConversation[];
  /** Only readable, current proof paths contribute to this flag. */
  truncated: boolean;
};
const MAX_EDGES = 256;
const MAX_PATHS = 20;

export function isEligibleRelationProof(edge: RelationProof, access: ProofAccess): boolean {
  if (!edge.id?.trim() || !edge.sourceEntityId?.trim() || !edge.targetEntityId?.trim() ||
      edge.sourceEntityId === edge.targetEntityId || !edge.evidenceEntityId?.trim() ||
      !edge.evidenceQuote?.trim() || edge.evidenceQuote.length > 6000 ||
      ![edge.sourceRecordVersion,edge.targetRecordVersion,edge.evidenceRecordVersion]
        .every(n => Number.isSafeInteger(n) && n >= 1)) return false;
  return edge.status === "confirmed" && edge.evidenceState === "current" &&
    edge.identityState === "resolved" &&
    access.recordVersions.get(edge.sourceEntityId) === edge.sourceRecordVersion &&
    access.recordVersions.get(edge.targetEntityId) === edge.targetRecordVersion &&
    access.recordVersions.get(edge.evidenceEntityId) === edge.evidenceRecordVersion &&
    access.readableEvidence.has(edge.evidenceEntityId);
}

/** Only sibling_of + participant_of yield a conversation path.
 *
 * "Lisa is mentioned in the audio" never proves "I talked to Lisa".
 * The result contains conversation entity IDs, NOT invented media URLs,
 * transcripts, timecodes, or claims that audio exists.
 */
export function resolveSiblingConversationPaths(
  ownPersonId: string,
  edges: readonly RelationProof[],
  access: ProofAccess,
): RelativeConversationResult {
  if (!ownPersonId?.trim() || ownPersonId.length > 256) {
    throw new Error("relational_owner_id_invalid");
  }
  const visible = edges.filter(e => isEligibleRelationProof(e, access) &&
    (e.kind === "sibling_of" || e.kind === "participant_of"));
  const limited = visible.slice(0,MAX_EDGES);
  const siblings = new Map<string,string>();
  for (const edge of limited) {
    // The user's viewpoint is one stable person entity, never a name search.
    if (edge.kind === "sibling_of" && edge.sourceEntityId === ownPersonId) {
      siblings.set(edge.targetEntityId,edge.id);
    }
  }
  const paths: RelativeConversation[]=[];
  const seen = new Set<string>();
  for (const edge of limited) {
    if (edge.kind !== "participant_of") continue;
    const siblingEvidence=siblings.get(edge.targetEntityId);
    if (!siblingEvidence || !access.recordVersions.has(edge.sourceEntityId)) continue;
    const key=edge.sourceEntityId+"\u0000"+edge.targetEntityId;
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push({conversationId:edge.sourceEntityId,relativeId:edge.targetEntityId,
      relationEvidenceId:siblingEvidence,participantEvidenceId:edge.id});
  }
  // If more confirmed paths are available, disclose only that the visible
  // result set is partial, not hidden counts or protected graph metadata.
  return {paths:paths.slice(0,MAX_PATHS),
    truncated:visible.length>MAX_EDGES || paths.length>MAX_PATHS};
}
