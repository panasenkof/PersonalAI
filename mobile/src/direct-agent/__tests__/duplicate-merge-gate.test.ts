import { verifyDuplicateMergeRequest } from "../duplicate-merge-gate";
import type { DuplicateCandidateGroup } from "../../local-memory/agent-catalog";
const fingerprint="a".repeat(64);
const candidate=(id:string,version:number)=>({
  id,version,title:"Тест "+id,section:"Проекты",collectionId:"projects",
  attachmentCount:id==="a"?2:1,tagCount:id==="b"?3:1,
});
const group:DuplicateCandidateGroup={
  fingerprint,totalCount:3,complete:true,
  sourceUrl:"https://example.org/article",
  records:[candidate("a",2),candidate("b",4),candidate("c",7)],
};
const request={noteIds:["a","b","c"],expectedVersions:[2,4,7],
  keepNoteId:"b",reason:"Три копии одного материала"};

test("S9-2b: a complete same-turn group is reordered keep-first and never written",()=>{
  const result=verifyDuplicateMergeRequest(request,[group]);
  expect(result).toMatchObject({
    noteIds:["b","a","c"],expectedVersions:[4,2,7],
    keepNoteId:"b",fingerprint,attachmentCount:4,sourceTagEntries:5,
  });
  expect(result.records.map(x=>x.id)).toEqual(["b","a","c"]);
});

test("S9-2b: invented IDs, stale versions, subgroup or extra IDs cannot pass",()=>{
  for(const input of [
    {...request,noteIds:["a","b","invented"]},
    {...request,expectedVersions:[2,5,7]},
    {...request,noteIds:["a","b"],expectedVersions:[2,4]},
    {...request,noteIds:["a","b","c","d"],expectedVersions:[2,4,7,8]},
    {...request,keepNoteId:"elsewhere"},
  ])expect(()=>verifyDuplicateMergeRequest(input,[group]))
    .toThrow();
});

test("S9-2b: partial and oversized groups remain discovery-only",()=>{
  for(const incomplete of [
    {...group,complete:false},
    {...group,totalCount:4},
    {...group,records:group.records.slice(0,2)},
  ])expect(()=>verifyDuplicateMergeRequest(request,[incomplete]))
    .toThrow("duplicate_merge_group_not_verified_this_turn");
  expect(()=>verifyDuplicateMergeRequest(request,[]))
    .toThrow("duplicate_merge_group_not_verified_this_turn");
});

test("S9-2b: strict input shape, rationale and duplicate selections",()=>{
  for(const invalid of [
    {...request,noteIds:["a","a","c"]},
    {...request,expectedVersions:[2,4]},
    {...request,reason:"Нет"},
    {...request,extra:"autoCommit"},
    {...request,keepNoteId:3},
    {noteIds:[],expectedVersions:[],keepNoteId:"a",reason:"Причина"},
  ])expect(()=>verifyDuplicateMergeRequest(invalid,[group]))
    .toThrow("invalid_duplicate_merge_request");
});
test("S9-2b: malformed fingerprint is refused rather than trusted",()=>{
  expect(()=>verifyDuplicateMergeRequest(request,[{...group,fingerprint:"URL-secret"}]))
    .toThrow("invalid_duplicate_group_fingerprint");
});
