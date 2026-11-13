import { createToolCatalog } from "../tool-catalog";
import { defaultDirectPreferences } from "../settings";
import type { DirectAgentOptions } from "../engine";
import type { DuplicateCandidatesPage } from "../../local-memory/agent-catalog";

const fingerprint="a".repeat(64);
const page:DuplicateCandidatesPage={
  scope:"standard_active_notes",kind:"same_url",scanned:2,partial:false,
  hasMoreGroups:false,contentIncluded:false,
  groups:[{fingerprint,totalCount:2,complete:true,sourceUrl:"https://example.org",
    records:[
      {id:"n1",version:2,title:"Первая",section:"Проекты",collectionId:"projects",
        attachmentCount:1,tagCount:2},
      {id:"n2",version:3,title:"Вторая",section:"Проекты",collectionId:"projects",
        attachmentCount:0,tagCount:3},
    ]}],
};
const options=(reader?:DirectAgentOptions["findDuplicates"]):DirectAgentOptions=>({
  settings:{...defaultDirectPreferences,apiKey:"test-key",webSearchKey:"",allowWeb:false},
  prompt:"Найди дубли",history:[],lookup:async()=>[],propose:()=>undefined,
  ...(reader?{findDuplicates:reader}:{}),
});
const request={
  noteIds:["n1","n2"],expectedVersions:[2,3],keepNoteId:"n2",
  reason:"Одинаковый адрес материала",
};
test("S9-2b: no proposal without an actual same-turn duplicate read",async()=>{
  const c=createToolCatalog(options(jest.fn(async()=>page)),[],[],[]);
  expect(c.definitions.map(x=>x.name)).toContain("propose_merge_notes");
  expect(await c.run("propose_merge_notes",request))
    .toHaveProperty("error","invalid_or_unverified_duplicate_merge_proposal");
  expect(c.finish().duplicateMergeProposal).toBeUndefined();
  expect(JSON.stringify(c.finish().taskState)).not.toContain("n1");
});
test("S9-2b: only exact discovered group stages one no-write preview",async()=>{
  const c=createToolCatalog(options(jest.fn(async()=>page)),[],[],[]);
  expect(await c.run("find_duplicate_candidates",{kind:"same_url",limit:5}))
    .toHaveProperty("outcome","found");
  expect(await c.run("propose_merge_notes",request)).toMatchObject({
    status:"awaiting_user_confirmation",saved:false,requiresUserTap:true,
    keepNoteId:"n2",noteCount:2,attachments:1,sourceTagEntries:5,
  });
  expect(c.finish().duplicateMergeProposal).toMatchObject({
    keepNoteId:"n2",noteIds:["n2","n1"],expectedVersions:[3,2],fingerprint,
  });
  expect(await c.run("propose_merge_notes",request))
    .toHaveProperty("error","merge_preview_already_proposed_this_turn");
  expect(JSON.stringify(c.finish().taskState)).not.toContain("n1");
  expect(c.definitions.map(x=>x.name)).not.toContain("confirm_merge_notes");
});
test("S9-2b: an incomplete replacement discovery revokes old group handles",async()=>{
  const reader=jest.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({
    ...page,partial:true,groups:[{...page.groups[0],complete:false,totalCount:6}],
  });
  const c=createToolCatalog(options(reader),[],[],[]);
  await c.run("find_duplicate_candidates",{kind:"same_url",limit:5});
  await c.run("find_duplicate_candidates",{kind:"same_url",limit:5});
  expect(await c.run("propose_merge_notes",request))
    .toHaveProperty("error","invalid_or_unverified_duplicate_merge_proposal");
});
test("S9-2b: forged version or extra note can't create a proposal",async()=>{
  const c=createToolCatalog(options(jest.fn(async()=>page)),[],[],[]);
  await c.run("find_duplicate_candidates",{kind:"same_url",limit:5});
  for(const invalid of [
    {...request,expectedVersions:[2,4]},
    {...request,noteIds:["n1","forged"]},
    {...request,extra:"apply"},
  ])expect(await c.run("propose_merge_notes",invalid))
    .toHaveProperty("error","invalid_or_unverified_duplicate_merge_proposal");
  expect(c.finish().duplicateMergeProposal).toBeUndefined();
});
