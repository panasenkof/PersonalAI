import {
  validDuplicateMergeProposal, validDuplicateMergeReceipt,
  confirmDuplicateMerge, undoDuplicateMerge,
} from "../duplicate-merge-actions";
import { changeNotes, undoNotes } from "../../local-memory/note-actions";
import type { VerifiedDuplicateMergeRequest } from "../duplicate-merge-gate";

jest.mock("../../local-memory/storage",()=>({
  localMemorySessionUnlocked:jest.fn(()=>true),
  withLocalMemoryDatabase:jest.fn(async(_profile:string,fn:(db:unknown)=>Promise<unknown>)=>fn({})),
}));
jest.mock("../../local-memory/note-actions",()=>({
  changeNotes:jest.fn(async()=>"notes:merge:merge-test"),
  undoNotes:jest.fn(async()=>{}),
}));
const proposal:VerifiedDuplicateMergeRequest={
  noteIds:["a","b"],expectedVersions:[2,3],keepNoteId:"a",
  fingerprint:"a".repeat(64),reason:"Один источник",
  attachmentCount:2,sourceTagEntries:4,
  records:[
    {id:"a",version:2,title:"А",section:"Проекты",collectionId:"x",attachmentCount:1,tagCount:2},
    {id:"b",version:3,title:"Б",section:"Проекты",collectionId:"x",attachmentCount:1,tagCount:2},
  ],
};
const receipt={
  batch:"notes:merge:merge-test",keepNoteId:"a",noteIds:["a","b"],mergedCount:1,
};
beforeEach(()=>jest.clearAllMocks());

test("S9-2d: shape and tag/attachment count must match exact visible members",()=>{
  expect(validDuplicateMergeProposal(proposal)).toBe(true);
  expect(validDuplicateMergeProposal({...proposal,noteIds:["b","a"]})).toBe(false);
  expect(validDuplicateMergeProposal({...proposal,expectedVersions:[3,2]})).toBe(false);
  expect(validDuplicateMergeProposal({...proposal,sourceTagEntries:13})).toBe(false);
  expect(validDuplicateMergeProposal({...proposal,attachmentCount:3})).toBe(false);
  expect(validDuplicateMergeProposal({...proposal,fingerprint:"not-a-sha"})).toBe(false);
});
test("S9-2d: confirmed click sends canonical batch with verified order",async()=>{
  expect(await confirmDuplicateMerge("guest",proposal)).toEqual(receipt);
  expect(changeNotes).toHaveBeenCalledWith(expect.anything(),"merge",[
    {id:"a",record_version:2},{id:"b",record_version:3},
  ],undefined,undefined,undefined,{noteIds:["a","b"],keepNoteId:"a"});
});
test("S9-2d: unrecognized/corrupt receipt cannot authorize Undo",async()=>{
  expect(validDuplicateMergeReceipt(receipt)).toBe(true);
  for(const invalid of [
    {...receipt,batch:"notes:trash:merge-test"},
    {...receipt,noteIds:["a","a"]},
    {...receipt,keepNoteId:"b"},
    {...receipt,mergedCount:2},
  ]) expect(validDuplicateMergeReceipt(invalid)).toBe(false);
  await expect(undoDuplicateMerge("guest",{...receipt,undone:true as const}))
    .rejects.toThrow();
  expect(undoNotes).not.toHaveBeenCalled();
});
test("S9-2d: Undo routes to existing journal and marks receipt consumed",async()=>{
  expect(await undoDuplicateMerge("guest",receipt)).toEqual({...receipt,undone:true});
  expect(undoNotes).toHaveBeenCalledWith(expect.anything(),"notes:merge:merge-test",
    undefined,{noteIds:["a","b"],keepNoteId:"a"});
});
