import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";
import type { InboxTriagePage } from "../inbox-triage";
import { parseConversation } from "../conversations";

const settings: DirectAgentOptions["settings"] = {
  provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
  apiKey:"test-key",webSearchKey:"",allowWeb:false,
};
const approval = {
  conversationId:"conversation-A",limit:2,
  label:"Разрешить разбор 2 записей из «Входящих»",
};
const privateText = "Закрытая информация из Inbox";
function harness(extra: Partial<DirectAgentOptions> = {}) {
  const request = jest.fn(() => approval);
  const read = jest.fn(async ():Promise<InboxTriagePage>=>({
    items:[{noteId:"private-id",expectedVersion:4,title:"Запись",
      excerpt:privateText,tags:["личное"]}],
  }));
  const opts:DirectAgentOptions = {
    settings,prompt:"Разбери «Входящие»",history:[],
    lookup:jest.fn(async()=>[]),propose:jest.fn(),
    requestInboxTriageApproval:request,
    ...extra,
  };
  return {opts,request,read,catalog:createToolCatalog(opts,[],[],[])};
}

test("S9-1b: LLM can only request consent, not read Inbox before a user tap", async () => {
  const {catalog,request}=harness();
  const definitions=catalog.definitions.map(d=>d.name);
  expect(definitions).toContain("request_inbox_triage_access");
  expect(definitions).not.toContain("list_inbox_for_triage");
  expect(await catalog.run("list_inbox_for_triage",{limit:2}))
    .toHaveProperty("error","tool_not_allowed");
  expect(request).not.toHaveBeenCalled();
  const result=await catalog.run("request_inbox_triage_access",{limit:2});
  expect(result).toMatchObject({status:"awaiting_user_confirmation",
    contentRead:false,saved:false,requiresUserTap:true,limit:2});
  expect(request).toHaveBeenCalledTimes(1);
  expect(catalog.finish().inboxApproval).toBe(approval);
  expect(await catalog.run("request_inbox_triage_access",{limit:2}))
    .toHaveProperty("error","inbox_approval_already_requested_this_turn");
  expect(request).toHaveBeenCalledTimes(1);
});

test("S9-1b: bad arguments and context-only turns never create an Inbox grant", async () => {
  const {catalog,request}=harness();
  for (const args of [{limit:11},{limit:0},{limit:"2"},{limit:2,sql:"DROP TABLE"}]) {
    expect(await catalog.run("request_inbox_triage_access",args)).toHaveProperty("error");
  }
  expect(request).not.toHaveBeenCalled();
  for(const options of [{contextOnly:true},{skipLocalMemory:true}]){
    const {catalog:c}=harness(options);
    expect(c.definitions.map(d=>d.name)).not.toContain("request_inbox_triage_access");
  }
});

test("S9-1b: approved turn contains ONLY the private reader, no web/workspace/write", async () => {
  const request=jest.fn(()=>approval);
  const read=jest.fn(async ():Promise<InboxTriagePage>=>({
    items:[{noteId:"private-id",expectedVersion:4,title:"Запись",
      excerpt:privateText,tags:["личное"]}],
  }));
  const {catalog,opts}=harness({requestInboxTriageApproval:request,listInboxForTriage:read});
  expect(catalog.definitions.map(d=>d.name)).toEqual(["list_inbox_for_triage"]);
  expect(catalog.guidance.map(d=>d.name)).toEqual(["list_inbox_for_triage"]);
  const result=await catalog.run("list_inbox_for_triage",{limit:2});
  expect(result).toMatchObject({items:[{noteId:"private-id",expectedVersion:4}],outcome:"found"});
  expect(read).toHaveBeenCalledWith({limit:2});
  for(const tool of ["request_inbox_triage_access","draft_memory_fact",
    "propose_move_local_note","search_local_notes","search_web","workspace_put"]){
    expect(await catalog.run(tool,{})).toHaveProperty("error","tool_not_allowed");
  }
  expect(opts.propose).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  // Private excerpts are tool responses to the approved LLM turn only,
  // never snapshots in TaskState evidence, diagnostics or persisted receipts.
  expect(JSON.stringify(catalog.finish())).not.toContain(privateText);
});

test("S9-1b: malformed read args cannot reach canonical private reader", async () => {
  const read=jest.fn(async():Promise<InboxTriagePage>=>({items:[]}));
  const {catalog}=harness({listInboxForTriage:read});
  for(const bad of [{limit:11},{limit:0},{limit:1,cursor:-1},
    {limit:1,query:"sensitive"},{limit:2.5},{limit:1,cursor:1.2}]){
    expect(await catalog.run("list_inbox_for_triage",bad)).toHaveProperty("error");
  }
  expect(read).not.toHaveBeenCalled();
  expect(await catalog.run("list_inbox_for_triage",{limit:1}))
    .toMatchObject({items:[],outcome:"empty"});
  expect(read).toHaveBeenCalledTimes(1);
});

test("S9-1b: encrypted reload never restores an expired consent card", () => {
  const row={id:"r1",role:"assistant",text:"Разрешить?",inboxApproval:approval};
  const c={id:"conversation-A",title:"Тест",createdAt:"2026-11-13T12:00:00.000Z",
    updatedAt:"2026-11-13T12:00:00.000Z",question:"",rows:[row],drafts:[]};
  expect(parseConversation(JSON.stringify(c))?.rows[0].inboxApproval).toBeUndefined();
});
