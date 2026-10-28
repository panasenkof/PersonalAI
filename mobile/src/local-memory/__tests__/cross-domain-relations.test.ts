/**
 * Executable cross-domain relation-path C1 tests. Not an end-to-end proof that
 * confirmed relations are persisted or an audio attachment is actually found.
 */
import {
  resolveDirectRelationConversationPaths, isEligibleRelationProof,
  type DirectPersonRelation, type RelationProof, type ProofAccess,
} from "../relational-proof";

function proof(kind:RelationProof["kind"],person:string,conversation:string,fix:Partial<RelationProof>={}):RelationProof {
  return {
    id:kind+"-"+person+"-"+conversation,kind,sourceEntityId:kind==="participant_of"?conversation:"owner-1",
    targetEntityId:person,sourceRecordVersion:1,targetRecordVersion:1,
    evidenceEntityId:"evidence-"+kind+"-"+person+"-"+conversation,evidenceRecordVersion:1,
    evidenceQuote:"Прямое свидетельство: "+kind+" "+person,
    status:"confirmed",evidenceState:"current",identityState:"resolved",
    ...fix,
  };
}
function scope(edges:RelationProof[]):ProofAccess {
  const version=new Map<string,number>();const evidence=new Set<string>();
  edges.forEach(e=>{
    version.set(e.sourceEntityId,e.sourceRecordVersion);
    version.set(e.targetEntityId,e.targetRecordVersion);
    version.set(e.evidenceEntityId,e.evidenceRecordVersion);
    evidence.add(e.evidenceEntityId);
  });
  return {recordVersions:version,readableEvidence:evidence};
}
const roleCases: readonly [string,DirectPersonRelation,string,string][]=[
  ["RE01","has_mother","мама Ирина","обсуждение ремонта квартиры"],
  ["RE02","has_father","папа Сергей","поездка на дачу"],
  ["RE03","has_brother","брат Денис","разговор о работе"],
  ["RE04","has_spouse","супруга Анна","семейный бюджет"],
  ["RE05","has_child","сын Павел","встреча в школе"],
  ["RE06","has_friend","друг Максим","поход выходного дня"],
  ["RE07","has_colleague","коллега Мария","проектная планёрка"],
  ["RE08","has_doctor","врач Евгения","обсуждение результатов обследования"],
  ["RE09","has_teacher","учительница Ольга","родительское собрание"],
  ["RE10","has_sister","сестра Вера","аудио о семейном празднике"],
];
test.each(roleCases)("%s: confirmed role %s and participant proof finds %s",(_id,kind,person,conversation)=>{
  const a=proof(kind,person,"kin"), b=proof("participant_of",person,conversation);
  const paths=resolveDirectRelationConversationPaths("owner-1", kind,[b,a],scope([a,b]));
  expect(paths).toEqual({
    paths:[{
      conversationId:conversation,relativeId:person,
      relationEvidenceId:a.id,participantEvidenceId:b.id,
    }],truncated:false,
  });
});

test("RE11: colleague who is mentioned but was not on the call is not a participant",()=>{
  const a=proof("has_colleague","Мария","colleague");
  const b=proof("mentioned_in","Мария","call");
  const c=proof("about","Мария","note");
  expect(resolveDirectRelationConversationPaths("owner-1","has_colleague",[a,b,c],scope([a,b,c])).paths).toEqual([]);
});

test("RE12: a spouse and a sibling are not interchangeable and direction is exact",()=>{
  const a=proof("has_spouse","Пётр","spouse");
  const b=proof("participant_of","Пётр","meeting");
  const edges=[a,b];
  expect(resolveDirectRelationConversationPaths("owner-1","has_sister",edges,scope(edges)).paths).toEqual([]);
  expect(resolveDirectRelationConversationPaths("Пётр","has_spouse",edges,scope(edges)).paths).toEqual([]);
});

test("RE13: two colleagues with matching names remain different people",()=>{
  const a=proof("has_colleague","person-maria-a","colleague");
  const b=proof("participant_of","person-maria-b","call");
  const c=proof("participant_of","person-maria-a","meeting");
  expect(resolveDirectRelationConversationPaths("owner-1","has_colleague",[a,b,c],scope([a,b,c])).paths)
    .toMatchObject([{conversationId:"meeting",relativeId:"person-maria-a"}]);
});

test("RE14: one verified relation joins many recordings but yields bounded distinct paths",()=>{
  const kin=proof("has_mother","Ирина","kin");
  const calls=Array.from({length:29},(_,i)=>proof("participant_of","Ирина","call-"+i));
  const edges=[kin,...calls];
  const r=resolveDirectRelationConversationPaths("owner-1","has_mother",edges,scope(edges));
  expect(r.paths).toHaveLength(20);
  expect(r.truncated).toBe(true);
  expect(new Set(r.paths.map(x=>x.conversationId)).size).toBe(20);
  // Hundreds of unrelated confirmed participants must not consume the role
  // budget ahead of a valid family conversation.
  const strangers=Array.from({length:300},(_,i)=>proof("participant_of","stranger-"+i,"elsewhere-"+i));
  const scoped=[...strangers,kin,proof("participant_of","Ирина","specific-call")];
  const found=resolveDirectRelationConversationPaths("owner-1","has_mother",scoped,scope(scoped));
  expect(found.paths.map(x=>x.conversationId)).toEqual(["specific-call"]);
  expect(found.truncated).toBe(false);
});

test("RE15: a former colleague relation needs valid-time filtering before it may be used to answer about a date",()=>{
  const a=proof("has_colleague","former-colleague","work-2021");
  const b=proof("participant_of","former-colleague","call-2026");
  const edges=[a,b];
  // The pure resolver proves only a direct path; it has no valid-time inputs.
  // Contract consumers MUST NOT assert "current colleague" from this result.
  const r=resolveDirectRelationConversationPaths("owner-1","has_colleague",edges,scope(edges));
  expect(r.paths).toHaveLength(1);
  expect("current" in r.paths[0]).toBe(false);
  expect("validAt" in r.paths[0]).toBe(false);
});

test("RE16: no relation at all never becomes a social fact from participant evidence",()=>{
  const participant=proof("participant_of","doctor-1","appointment");
  expect(resolveDirectRelationConversationPaths("owner-1","has_doctor",[participant],scope([participant])).paths).toEqual([]);
});

test.each([
  ["RE17","pending proposal", {status:"pending" as const}],
  ["RE18","deferred approval", {status:"deferred" as const}],
  ["RE19","explicit rejection", {status:"rejected" as const}],
  ["RE20","retracted proof", {status:"retracted" as const}],
  ["RE21","stale extraction", {evidenceState:"stale" as const}],
  ["RE22","withdrawn witness", {evidenceState:"withdrawn" as const}],
  ["RE23","ambiguous speaker", {identityState:"ambiguous" as const}],
  ["RE24","unresolved identity", {identityState:"unresolved" as const}],
] as const)("%s: %s cannot produce an approved conversation path",(_id,_name,change)=>{
  const a=proof("has_friend","Друг","friends",{...change});
  const b=proof("participant_of","Друг","chat");
  const edges=[a,b];
  expect(resolveDirectRelationConversationPaths("owner-1","has_friend",edges,scope(edges)).paths).toEqual([]);
});

test("RE25: missing permission for the intermediate medical document blocks the entire path",()=>{
  const a=proof("has_doctor","doc-1","clinic");
  const b=proof("participant_of","doc-1","voice-appointment");
  const edges=[a,b];const access=scope(edges);
  const denied:ProofAccess={...access,readableEvidence:new Set([b.evidenceEntityId])};
  expect(resolveDirectRelationConversationPaths("owner-1","has_doctor",edges,denied)).toEqual({
    paths:[],truncated:false,
  });
});
test("RE26: removed source version invalidates a relationship instead of yielding phantom memories",()=>{
  const a=proof("has_friend","friend-old","note");
  const b=proof("participant_of","friend-old","recording");
  const edges=[a,b],access=scope(edges);
  const versions=new Map(access.recordVersions);versions.set(a.evidenceEntityId,2);
  expect(isEligibleRelationProof(a,{...access,recordVersions:versions})).toBe(false);
  expect(resolveDirectRelationConversationPaths("owner-1","has_friend",edges,{
    ...access,recordVersions:versions,
  }).paths).toEqual([]);
  // Two independent proofs: losing one does not erase the surviving user
  // confirmed relation and its separate evidence source.
  const second=proof("has_friend","friend-old","other-independent-note");
  const all=[a,second,b];
  const readable=scope(all);
  const oldEvidenceStale=new Map(readable.recordVersions);
  oldEvidenceStale.set(a.evidenceEntityId,2);
  const found=resolveDirectRelationConversationPaths("owner-1","has_friend",all,{
    ...readable,recordVersions:oldEvidenceStale,
  });
  expect(found.paths).toMatchObject([{
    relationEvidenceId:second.id,participantEvidenceId:b.id,
  }]);
});
test("RE27: unsupported relation type never creates a relation path",()=>{
  const a=proof("has_friend","p","friend");
  const b=proof("participant_of","p","conversation");
  const edges=[a,b];
  expect(()=>resolveDirectRelationConversationPaths("owner-1","acquaintance" as DirectPersonRelation,edges,scope(edges)))
    .toThrow("relational_role_invalid");
});
test("RE28: a conversation ID is not fabricated as an audio attachment",()=>{
  const a=proof("has_teacher","teacher","teacher");
  const b=proof("participant_of","teacher","meeting");
  const r=resolveDirectRelationConversationPaths("owner-1","has_teacher",[a,b],scope([a,b]));
  expect(r.paths).toHaveLength(1);
  expect("audio" in r.paths[0]).toBe(false);
  expect("timecode" in r.paths[0]).toBe(false);
  expect("file" in r.paths[0]).toBe(false);
});
