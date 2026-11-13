import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";

const settings:DirectAgentOptions["settings"]={
  provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
  apiKey:"test-key",webSearchKey:"",allowWeb:false,
};
const proposal={items:[{
  noteId:"n1",expectedVersion:4,targetSectionSlug:"projects",
  tags:["ai"],reason:"Относится к проекту",
}]};
const request={
  items:[{
    noteId:"n1",expectedVersion:4,targetSectionSlug:"projects",
    tags:["AI"],reason:"Относится к проекту",
  }],
};

function catalog(additional:Partial<DirectAgentOptions>={}){
  const options:DirectAgentOptions={settings,prompt:"Разбери входящие",history:[],
    lookup:jest.fn(async()=>[]),propose:jest.fn(),...additional};
  return createToolCatalog(options,[],[],[]);
}
test("S9-1c2: no write-proposal tool without explicitly approved private turn",()=>{
  expect(catalog().definitions.map(x=>x.name)).not.toContain("propose_inbox_triage");
  expect(catalog({listInboxForTriage:jest.fn(async()=>({items:[]}))})
    .definitions.map(x=>x.name)).not.toContain("propose_inbox_triage");
});
test("S9-1c2: approved turn exposes only read and inert proposal tools",async()=>{
  const proposeInboxTriage=jest.fn(async()=>proposal);
  const c=catalog({listInboxForTriage:jest.fn(async()=>({items:[]})),proposeInboxTriage});
  expect(c.definitions.map(x=>x.name)).toEqual(["list_inbox_for_triage","propose_inbox_triage"]);
  expect(await c.run("propose_inbox_triage",request)).toMatchObject({
    status:"awaiting_user_confirmation",saved:false,requiresUserTap:true,count:1,
  });
  expect(proposeInboxTriage).toHaveBeenCalledWith(request);
  expect(c.finish().inboxTriageProposal).toEqual(proposal);
  expect(await c.run("propose_inbox_triage",request))
    .toHaveProperty("error","inbox_triage_proposal_already_created");
  expect(proposeInboxTriage).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(c.finish().taskState)).not.toContain("n1");
  expect(await c.run("draft_memory_fact",{})).toHaveProperty("error","tool_not_allowed");
});
test("S9-1c2: invalid proposal envelope never invokes host",async()=>{
  const proposeInboxTriage=jest.fn(async()=>proposal);
  const c=catalog({listInboxForTriage:jest.fn(async()=>({items:[]})),proposeInboxTriage});
  expect(await c.run("propose_inbox_triage",{items:[],extra:"sql"})).toHaveProperty("error");
  expect(await c.run("propose_inbox_triage",{items:"invalid"})).toHaveProperty("error");
  expect(proposeInboxTriage).not.toHaveBeenCalled();
});
