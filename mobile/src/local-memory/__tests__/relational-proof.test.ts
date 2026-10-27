import {
  isEligibleRelationProof, resolveSiblingConversationPaths,
  type ProofAccess, type RelationProof,
} from "../relational-proof";

function edge(
  id: string, kind: RelationProof["kind"],
  sourceEntityId: string, targetEntityId: string,
  changes: Partial<RelationProof> = {},
): RelationProof {
  return {
    id,kind,sourceEntityId,targetEntityId,
    sourceRecordVersion:1,targetRecordVersion:1,
    evidenceEntityId:"fact-"+id,evidenceRecordVersion:1,
    evidenceQuote:"Подтверждённое исходное свидетельство "+id,
    status:"confirmed",evidenceState:"current",identityState:"resolved",
    ...changes,
  };
}
function allowed(edges: RelationProof[], override: Record<string,number> = {}): ProofAccess {
  const versions = new Map<string,number>();
  const evidence = new Set<string>();
  for(const e of edges) {
    versions.set(e.sourceEntityId,1);versions.set(e.targetEntityId,1);
    versions.set(e.evidenceEntityId,1);evidence.add(e.evidenceEntityId);
  }
  for(const [id,v] of Object.entries(override)) versions.set(id,v);
  return {recordVersions:versions,readableEvidence:evidence};
}

test("R1: user→sister Lisa→actual participant in a conversation returns a defensible path",()=>{
  const edges=[
    edge("kin","has_sister","me","lisa"),
    edge("participant","participant_of","conversation-a","lisa"),
  ];
  expect(resolveSiblingConversationPaths("me",edges,allowed(edges))).toEqual({
    paths:[{conversationId:"conversation-a",relativeId:"lisa",
      relationEvidenceId:"kin",participantEvidenceId:"participant"}],truncated:false,
  });
  // Relative arrival/order of those independent facts does not change output.
  expect(resolveSiblingConversationPaths("me",[edges[1],edges[0]],allowed(edges)).paths)
    .toHaveLength(1);
});

test("R6: mentioning Lisa in another person's conversation does not establish participation",()=>{
  const edges=[
    edge("kin","has_sister","me","lisa"),
    edge("mention","mentioned_in","conversation-a","lisa"),
    edge("about","about","conversation-b","lisa"),
  ];
  expect(resolveSiblingConversationPaths("me",edges,allowed(edges)).paths).toEqual([]);
});

test("generic sibling_of or brother_of does not prove the user asked for a sister",()=>{
  for (const kind of ["sibling_of","brother_of"] as const) {
    const edges=[
      edge("kin",kind,"me","alex"),
      edge("part","participant_of","conversation","alex"),
    ];
    expect(resolveSiblingConversationPaths("me",edges,allowed(edges)).paths).toEqual([]);
  }
});

test("R4: two people named Lisa cannot be merged by label or substring",()=>{
  const edges=[
    edge("kin","has_sister","me","lisa-id-1"),
    edge("someone","participant_of","conversation-b","lisa-id-2"),
    edge("correct","participant_of","conversation-a","lisa-id-1"),
  ];
  expect(resolveSiblingConversationPaths("me",edges,allowed(edges)).paths)
    .toEqual([{conversationId:"conversation-a",relativeId:"lisa-id-1",
      relationEvidenceId:"kin",participantEvidenceId:"correct"}]);
});

test("R7: stale entity version, withdrawn evidence, pending model link and ambiguous identity give no paths",()=>{
  const edges=[
    edge("kin","has_sister","me","lisa"),
    edge("participant","participant_of","conversation-a","lisa"),
  ];
  const access=allowed(edges,{"lisa":2});
  expect(resolveSiblingConversationPaths("me",edges,access).paths).toEqual([]);
  const variants=[
    {...edges[0],status:"pending" as const},
    {...edges[0],evidenceState:"stale" as const},
    {...edges[0],identityState:"ambiguous" as const},
    {...edges[0],evidenceState:"withdrawn" as const},
  ];
  for (const changed of variants) {
    const v=[changed,edges[1]];
    expect(resolveSiblingConversationPaths("me",v,allowed(v)).paths).toEqual([]);
  }
});

test("R8/R11: protected intermediate evidence blocks the chain without disclosing hidden names",()=>{
  const edges=[
    edge("kin","has_sister","me","lisa"),
    edge("participant","participant_of","conversation-a","lisa"),
  ];
  const access=allowed(edges);
  const hiddenEvidence:ProofAccess={
    ...access,
    readableEvidence:new Set([...access.readableEvidence].filter(id=>id!=="fact-kin")),
  };
  expect(resolveSiblingConversationPaths("me",edges,hiddenEvidence))
    .toEqual({paths:[],truncated:false});
  const sourceVisible=allowed(edges);
  const missingSource:ProofAccess={
    ...sourceVisible,
    recordVersions:new Map([...sourceVisible.recordVersions].filter(([id])=>id!=="fact-participant")),
  };
  expect(resolveSiblingConversationPaths("me",edges,missingSource).paths).toEqual([]);
});

test("R9: capped, deduplicated evidence paths report partial results, never invented audio/timecodes",()=>{
  const edges=[edge("kin","has_sister","me","lisa")];
  for(let i=0;i<26;i++) {
    edges.push(edge("part-"+i,"participant_of","conversation-"+i,"lisa"));
  }
  const result=resolveSiblingConversationPaths("me",edges,allowed(edges));
  expect(result.paths).toHaveLength(20);
  expect(result.truncated).toBe(true);
  expect(result.paths[0]).toMatchObject({relativeId:"lisa"});
  expect("audioUrl" in result.paths[0]).toBe(false);
  expect("startMs" in result.paths[0]).toBe(false);
});

test("malformed/self-referential/unsupported or user-unapproved proofs fail closed",()=>{
  const normal=edge("kin","has_sister","me","lisa");
  expect(isEligibleRelationProof({...normal,targetEntityId:"me"},allowed([normal]))).toBe(false);
  expect(isEligibleRelationProof({...normal,evidenceQuote:""},allowed([normal]))).toBe(false);
  expect(isEligibleRelationProof({...normal,sourceRecordVersion:0},allowed([normal]))).toBe(false);
  expect(isEligibleRelationProof({...normal,status:"rejected"},allowed([normal]))).toBe(false);
  expect(()=>resolveSiblingConversationPaths("",[normal],allowed([normal])))
    .toThrow("relational_owner_id_invalid");
});
