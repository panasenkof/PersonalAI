import { createToolCatalog } from "../tool-catalog";
import { defaultDirectPreferences } from "../settings";
import type { DirectAgentOptions } from "../engine";
import type { DuplicateCandidatesPage } from "../../local-memory/agent-catalog";

const example:DuplicateCandidatesPage={
  scope:"standard_active_notes",kind:"same_url",contentIncluded:false,
  scanned:2,partial:false,hasMoreGroups:false,
  groups:[{
    fingerprint:"sha256-value",sourceUrl:"https://example.org/info",
    totalCount:2,complete:true,records:[
      {id:"source-note-1",version:3,title:"Первая",section:"Проекты",
        collectionId:"projects",attachmentCount:2,tagCount:3},
      {id:"source-note-2",version:5,title:"Вторая",section:"Проекты",
        collectionId:"projects",attachmentCount:0,tagCount:1},
    ],
  }],
};
const context=(findDuplicates?:DirectAgentOptions["findDuplicates"]):DirectAgentOptions=>({
  settings:{...defaultDirectPreferences,apiKey:"test-key",allowWeb:false},
  prompt:"Найди дубли",history:[],lookup:async()=>[],
  propose:()=>undefined,...(findDuplicates?{findDuplicates}:{}),
});
test("S9-2a: duplicate candidate tool is absent without an authorized local reader",()=>{
  const c=createToolCatalog(context(),[],[],[]);
  expect(c.definitions.map(x=>x.name)).not.toContain("find_duplicate_candidates");
});
test("S9-2a: exact duplicate tool is read-only with bounded safe arguments",async()=>{
  const read=jest.fn(async()=>example);
  const c=createToolCatalog(context(read),[],[],[]);
  const definition=c.definitions.find(x=>x.name==="find_duplicate_candidates");
  expect(definition).toBeDefined();
  expect(await c.run("find_duplicate_candidates",{kind:"same_url",limit:10}))
    .toMatchObject({scope:"standard_active_notes",groups:[{totalCount:2}],outcome:"found"});
  expect(read).toHaveBeenCalledWith("same_url",10);
  expect(JSON.stringify(c.finish().taskState)).not.toContain("source-note-1");
  for(const args of [
    {kind:"similar_meaning",limit:5},
    {kind:"same_text",limit:11},
    {kind:"same_url",limit:0},
    {kind:"same_url",limit:5,autoMerge:true},
  ]){
    expect(await c.run("find_duplicate_candidates",args))
      .toHaveProperty("error","invalid_duplicate_candidate_arguments");
  }
  expect(read).toHaveBeenCalledTimes(1);
  expect(c.definitions.map(x=>x.name)).not.toContain("confirm_merge_notes");
});
test("S9-2a: malformed candidate lists are not accepted as search evidence",async()=>{
  const read=jest.fn(async()=>({
    ...example,groups:[{...example.groups[0],complete:true,totalCount:3}],
  }));
  const c=createToolCatalog(context(read),[],[],[]);
  expect(await c.run("find_duplicate_candidates",{kind:"same_url",limit:10}))
    .toHaveProperty("error","invalid_duplicate_candidate_result");
});
test("S9-2a: import-only agent does not expose duplicate discovery",()=>{
  const c=createToolCatalog({...context(jest.fn()),contextOnly:true},[],[],[]);
  expect(c.definitions.map(x=>x.name)).not.toContain("find_duplicate_candidates");
});
