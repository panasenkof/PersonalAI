/**
 * №66.4 R0: conservative, deterministic proof-path evaluator.
 *
 * Does not read the database, infer a person's identity from their name,
 * attach an audio file from a mere mention or create a confirmed relation.
 * Caller MUST supply ACL-scoped and source-version-verified graph edges.
 * The future SQLCipher relation evidence store feeds this pure contract.
 */
/** Relation roles are directional: from viewpoint owner to a distinct person. */
export type DirectPersonRelation =
  | "has_sister" | "has_brother" | "has_mother" | "has_father"
  | "has_spouse" | "has_child" | "has_friend" | "has_colleague"
  | "has_doctor" | "has_teacher";
export type RelationProofKind = DirectPersonRelation | "brother_of" | "sibling_of"
  | "participant_of" | "mentioned_in" | "about";
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

/**
 * Resolve a direct role with a specific person, then a confirmed participation
 * edge to a conversation entity. This is a pure proof contract, not a search
 * over names. Time-specific queries additionally need validity filtering in
 * the future SQLCipher reader before creating the ProofAccess/edge set.
 */
export function resolveDirectRelationConversationPaths(
  ownPersonId: string,
  relationKind: DirectPersonRelation,
  edges: readonly RelationProof[],
  access: ProofAccess,
): RelativeConversationResult {
  if (!ownPersonId?.trim() || ownPersonId.length > 256) {
    throw new Error("relational_owner_id_invalid");
  }
  if (![
    "has_sister","has_brother","has_mother","has_father","has_spouse",
    "has_child","has_friend","has_colleague","has_doctor","has_teacher",
  ].includes(relationKind)) {
    throw new Error("relational_role_invalid");
  }
  const visible = edges.filter(e => isEligibleRelationProof(e,access) &&
    (e.kind===relationKind || e.kind==="participant_of"));
  // Discovery is ordered by the caller; the bounded subset is deliberately
  // partial, not proof that no later valid path exists.
  const limited=visible.slice(0,MAX_EDGES);
  const related=new Map<string,string>();
  for(const edge of limited) {
    if(edge.kind===relationKind && edge.sourceEntityId===ownPersonId &&
       !related.has(edge.targetEntityId)) {
      related.set(edge.targetEntityId,edge.id);
    }
  }
  const paths:RelativeConversation[]=[];
  const seen=new Set<string>();
  for(const edge of limited) {
    if(edge.kind!=="participant_of") continue;
    const proof=related.get(edge.targetEntityId);
    if(!proof) continue;
    const key=edge.sourceEntityId+"\u0000"+edge.targetEntityId;
    if(seen.has(key)) continue;
    seen.add(key);
    paths.push({conversationId:edge.sourceEntityId,relativeId:edge.targetEntityId,
      relationEvidenceId:proof,participantEvidenceId:edge.id});
  }
  return {paths:paths.slice(0,MAX_PATHS),
    truncated:visible.length>MAX_EDGES || paths.length>MAX_PATHS};
}

/** Backwards-compatible strict sister query; a generic sibling does not qualify. */
export function resolveSiblingConversationPaths(
  ownPersonId: string,
  edges: readonly RelationProof[],
  access: ProofAccess,
): RelativeConversationResult {
  return resolveDirectRelationConversationPaths(ownPersonId,"has_sister",edges,access);
}
