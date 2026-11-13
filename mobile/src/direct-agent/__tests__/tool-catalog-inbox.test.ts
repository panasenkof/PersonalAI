import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";

const settings: DirectAgentOptions["settings"] = {
  provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
  apiKey:"test",webSearchKey:"",allowWeb:false,
};
const options = (extra:Partial<DirectAgentOptions>={}):DirectAgentOptions=>({
  settings,prompt:"Разбери Входящие",history:[],
  lookup:async()=>[],propose:()=>undefined,...extra,
});

test("S9-1b: Inbox is never advertised on normal or import-only turns",async()=>{
  for (const extra of [{},{contextOnly:true},{skipLocalMemory:true}]) {
    const read=jest.fn(async()=>({items:[]}));
    const opts=options({...extra,...(extra.contextOnly||extra.skipLocalMemory?{inboxRead:read}:{})});
    const catalog=createToolCatalog(opts,[],[],[]);
    expect(catalog.definitions.map(d=>d.name)).not.toContain("list_inbox_for_triage");
    expect(await catalog.run("list_inbox_for_triage",{limit:1})).toHaveProperty("error","tool_not_allowed");
    expect(read).not.toHaveBeenCalled();
  }
});
test("S9-1b: authorized Inbox read is a single real catalog tool with guarded arguments",async()=>{
  const read=jest.fn(async(limit:number,cursor?:number)=>({
    items:[{noteId:"n1",expectedVersion:3,title:"Тема",excerpt:"Текст",tags:[]}],
    ...(cursor===undefined?{nextCursor:1}:{}),
  }));
  const catalog=createToolCatalog(options({inboxRead:read}),[],[],[]);
  expect(catalog.definitions.filter(d=>d.name==="list_inbox_for_triage")).toHaveLength(1);
  for (const args of [{},{limit:11,cursor:null},{limit:0,cursor:null},{limit:1,cursor:-1},{limit:1,cursor:null,extra:true},{limit:1.1,cursor:null},{limit:1}]) {
    expect(await catalog.run("list_inbox_for_triage",args)).toHaveProperty("error","invalid_inbox_triage_args");
  }
  expect(read).not.toHaveBeenCalled();
  expect(await catalog.run("list_inbox_for_triage",{limit:2,cursor:null})).toMatchObject({
    items:[{noteId:"n1",expectedVersion:3,excerpt:"Текст"}],nextCursor:1,
  });
  expect(read).toHaveBeenCalledWith(2,undefined);
  // Consent is one turn only: never persist its private snippets in TaskState evidence.
  expect(JSON.stringify(catalog.finish().taskState)).not.toContain("Текст");
  expect(JSON.stringify(catalog.finish().taskState)).not.toContain("n1");
  const second=await catalog.run("list_inbox_for_triage",{limit:1,cursor:1});
  expect(second).toMatchObject({items:[{noteId:"n1"}]});
  expect(second).not.toHaveProperty("nextCursor");
  expect(read).toHaveBeenCalledWith(1,1);
});
test("S9-1b: the tool does not exist on an independent next turn",async()=>{
  const consented=createToolCatalog(options({inboxRead:async()=>({items:[]})}),[],[],[]);
  expect(consented.definitions.map(d=>d.name)).toContain("list_inbox_for_triage");
  const next=createToolCatalog(options(),[],[],[]);
  expect(next.definitions.map(d=>d.name)).not.toContain("list_inbox_for_triage");
});
