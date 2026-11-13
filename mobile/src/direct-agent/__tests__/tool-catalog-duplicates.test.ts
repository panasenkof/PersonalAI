import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";

const settings:DirectAgentOptions["settings"]={
  provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
  apiKey:"test-key",webSearchKey:"",allowWeb:false,
};
const candidate={
  kind:"same_url" as const,groups:[{totalMatches:2,notes:[
    {noteId:"n1",expectedVersion:2,title:"Первая",section:"Заметки",attachmentCount:1,tagCount:2},
    {noteId:"n2",expectedVersion:7,title:"Вторая",section:"Заметки",attachmentCount:0,tagCount:1},
  ]}],scope:"standard_active_notes" as const,contentIncluded:false as const,
  scanned:12,scanTruncated:false,moreGroups:false,
};
function catalog(additional:Partial<DirectAgentOptions>={}){
  const opts:DirectAgentOptions={settings,prompt:"Найди дубли",history:[],
    lookup:jest.fn(async()=>[]),propose:jest.fn(),...additional};
  return createToolCatalog(opts,[],[],[]);
}
test("S9-2b: read-only exact candidate tool appears only with a local host",()=>{
  expect(catalog().definitions.map(t=>t.name)).not.toContain("find_duplicate_candidates");
  expect(catalog({skipLocalMemory:true,
    findDuplicateCandidates:jest.fn(async()=>candidate)})
    .definitions.map(t=>t.name)).not.toContain("find_duplicate_candidates");
  expect(catalog({findDuplicateCandidates:jest.fn(async()=>candidate)})
    .definitions.map(t=>t.name)).toContain("find_duplicate_candidates");
});
test("S9-2b: tool returns metadata, not content or write authorization",async()=>{
  const read=jest.fn(async()=>candidate);
  const c=catalog({findDuplicateCandidates:read});
  const result=await c.run("find_duplicate_candidates",{kind:"same_url",limit:2});
  expect(read).toHaveBeenCalledWith("same_url",2);
  expect(result).toMatchObject({...candidate,outcome:"found"});
  expect(JSON.stringify(result)).not.toContain("payload_json");
  expect(JSON.stringify(c.finish().taskState)).not.toContain("n1");
  expect(c.definitions.map(x=>x.name)).not.toContain("propose_merge_notes");
  expect(await c.run("changeNotes",{})).toHaveProperty("error","tool_not_allowed");
});
test("S9-2b: invalid args never access encrypted repository",async()=>{
  const read=jest.fn(async()=>candidate);
  const c=catalog({findDuplicateCandidates:read});
  for(const args of [
    {kind:"semantic",limit:5},{kind:"same_text",limit:11},
    {kind:"same_url",limit:1,additional:"unsafe"},{kind:"same_url"},
    {kind:"same_url",limit:0},{kind:"same_url",limit:"5"},
  ])expect(await c.run("find_duplicate_candidates",args))
    .toHaveProperty("error","invalid_duplicate_candidate_request");
  expect(read).not.toHaveBeenCalled();
});
test("S9-2b: private Inbox turn still exposes ONLY authorized Inbox read tools",()=>{
  const c=catalog({
    listInboxForTriage:jest.fn(async()=>({items:[]})),
    findDuplicateCandidates:jest.fn(async()=>candidate),
  });
  expect(c.definitions.map(x=>x.name)).toEqual(["list_inbox_for_triage"]);
});
