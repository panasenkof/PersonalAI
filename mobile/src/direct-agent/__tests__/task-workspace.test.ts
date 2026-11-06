import { createToolCatalog } from "../tool-catalog";
import { beginTask, parseTaskState, taskContext } from "../task-state";
import { parseConversation } from "../conversations";
import { defaultDirectPreferences } from "../settings";
import type { TaskState } from "../task-state";

const settings={...defaultDirectPreferences,apiKey:"test",allowWeb:false,webSearchKey:""};
function setup(taskState?:TaskState,gate=()=>true) {
  const states:TaskState[]=[];
  const catalog=createToolCatalog({settings,prompt:"Проанализируй статьи",history:[],
    lookup:jest.fn(async()=>[]),propose:jest.fn(),
    ...(taskState?{taskState}:{}),
    workspaceAvailable:gate,onTaskState:state=>states.push(state),
    saveWorkspace:async state=>{states.push(state);},
  },[],[],[]);
  return {catalog,states};
}
const put=(key:string,content:string,kind="finding")=>({key,content,kind});

test("9B: scratchpad writes are scoped to a task and preserved by existing encrypted conversation parser",async()=>{
  const {catalog,states}=setup();
  expect(catalog.definitions.map(d=>d.name)).toEqual(expect.arrayContaining([
    "workspace_put","workspace_get","workspace_list","workspace_clear",
  ]));
  expect(await catalog.run("workspace_put",put("paper_a","Model comparison draft")))
    .toMatchObject({status:"workspace_written",personalMemorySaved:false});
  const listed=await catalog.run("workspace_list",{});
  expect(listed).toMatchObject({scope:"current_task",modelDraftsOnly:true,count:1,
    entries:[{key:"paper_a",kind:"finding",chars:22}]});
  const read=await catalog.run("workspace_get",{key:"paper_a"});
  expect(read).toMatchObject({outcome:"read",verifiedSource:false,
    entry:{key:"paper_a",content:"Model comparison draft"}});
  expect(states.length).toBeGreaterThan(1);
  const savedState=catalog.finish().taskState!;
  expect(taskContext(savedState)).not.toContain("Model comparison draft");
  const chat=parseConversation(JSON.stringify({
    id:"task",title:"Обзор",createdAt:"2026-11-06",updatedAt:"2026-11-06",question:"",
    rows:[],drafts:[],taskState:savedState,
  }));
  expect(chat?.taskState?.workspace?.entries).toEqual([{
    key:"paper_a",kind:"finding",content:"Model comparison draft",
  }]);
  const next=setup(beginTask(chat!.taskState,"Продолжи вчерашний анализ"));
  expect(await next.catalog.run("workspace_get",{key:"paper_a"})).toMatchObject({
    entry:{content:"Model comparison draft"},verifiedSource:false,
  });
  expect(await next.catalog.run("workspace_clear",{})).toMatchObject({
    status:"workspace_cleared",discarded:1,personalMemoryDeleted:false,
  });
  expect(await next.catalog.run("workspace_get",{key:"paper_a"}))
    .toMatchObject({error:"workspace_key_missing"});
});

test("9B: workspace entries cannot exceed safe size or count, and duplicate keys update in place",async()=>{
  const {catalog}=setup();
  expect(await catalog.run("workspace_put",put("key","x".repeat(1201))))
    .toMatchObject({error:"invalid_workspace_entry"});
  expect(await catalog.run("workspace_put",put("../private","content")))
    .toMatchObject({error:"invalid_workspace_entry"});
  expect(await catalog.run("workspace_put",{...put("a","value"),sourceId:"secret"}))
    .toMatchObject({error:"invalid_workspace_entry"});
  for(let i=0;i<16;i++)expect(await catalog.run("workspace_put",put("k"+i,"fact")))
    .toHaveProperty("status","workspace_written");
  expect(await catalog.run("workspace_put",put("extra","next")))
    .toMatchObject({error:"workspace_capacity_reached"});
  expect(await catalog.run("workspace_put",put("k0","updated")))
    .toHaveProperty("status","workspace_written");
  expect(catalog.finish().taskState?.workspace?.entries).toHaveLength(16);
  expect(catalog.finish().taskState?.workspace?.entries.find(x=>x.key==="k0")?.content).toBe("updated");
});

test("9B: workspace is isolated after a goal change until explicit clear",async()=>{
  const {catalog}=setup();
  await catalog.run("workspace_put",put("comparison","old topic"));
  await catalog.run("update_task_state",{goal:"Другой вопрос",selection:"",openQuestions:[]});
  expect(await catalog.run("workspace_get",{key:"comparison"}))
    .toMatchObject({error:"workspace_task_changed_clear_first"});
  expect(taskContext(catalog.finish().taskState)).not.toContain('"key":"comparison"');
  expect(taskContext(catalog.finish().taskState)).toContain('"requiresClear":true');
  expect(await catalog.run("workspace_put",put("next","new data")))
    .toMatchObject({error:"workspace_task_changed_clear_first"});
  expect(await catalog.run("workspace_clear",{})).toMatchObject({status:"workspace_cleared"});
  expect(await catalog.run("workspace_put",put("next","new data")))
    .toMatchObject({status:"workspace_written"});
  expect(catalog.finish().taskState?.workspace?.goal).toBe("Другой вопрос");
});

test("9B: model cannot read/write scratchpad if AppLock revoked or host did not offer the capability",async()=>{
  let unlocked=true;
  const {catalog}=setup(undefined,()=>unlocked);
  expect(await catalog.run("workspace_put",put("one","untrusted"))).toMatchObject({
    status:"workspace_written",
  });
  unlocked=false;
  expect(await catalog.run("workspace_get",{key:"one"}))
    .toEqual({error:"workspace_locked"});
  expect(await catalog.run("workspace_clear",{}))
    .toEqual({error:"workspace_locked"});
  const denied=createToolCatalog({settings,prompt:"Привет",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
  },[],[],[]);
  expect(denied.definitions.some(d=>d.name==="workspace_put")).toBe(false);
  expect(await denied.run("workspace_get",{key:"one"})).toEqual({error:"tool_not_allowed"});
});

test("9B: corrupted persisted scratchpad is dropped while unrelated task receipts remain",()=>{
  const state=beginTask(undefined,"Task");
  const fake={...state,workspace:{version:1,goal:state.goal,entries:[
    {key:"good",kind:"finding",content:"valid"},
    {key:"../../secret",kind:"finding",content:"untrusted"},
  ]},evidence:[{tool:"draft_memory_fact",outcome:"saved",subject:"x",excerpt:"saved"}]};
  const parsed=parseTaskState(fake);
  expect(parsed?.workspace).toBeUndefined();
  expect(parsed?.evidence).toHaveLength(1);
});

test("9B: a failed durable write never returns a false success or updates the scratchpad",async()=>{
  const saved=jest.fn(async()=>{throw new Error("encrypted_disk_unavailable");});
  const catalog=createToolCatalog({settings,prompt:"Сравнить",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    onTaskState:jest.fn(),workspaceAvailable:()=>true,saveWorkspace:saved,
  },[],[],[]);
  expect(await catalog.run("workspace_put",put("draft","data")))
    .toEqual({error:"tool_failed_or_unavailable"});
  expect(saved).toHaveBeenCalledTimes(1);
  expect(catalog.finish().taskState?.workspace).toBeUndefined();
  expect(await catalog.run("workspace_list",{}))
    .toMatchObject({count:0,entries:[]});
});

test("9B: failed durable clear retains the prior workspace for safe retry",async()=>{
  const saveWorkspace=jest.fn(async(state:TaskState)=>{
    if(state.workspace===undefined)throw new Error("db_write_failed");
  });
  const catalog=createToolCatalog({settings,prompt:"Сравнить статьи",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    onTaskState:jest.fn(),workspaceAvailable:()=>true,saveWorkspace,
  },[],[],[]);
  expect(await catalog.run("workspace_put",put("checkpoint","Intermediate draft")))
    .toMatchObject({status:"workspace_written"});
  expect(await catalog.run("workspace_clear",{}))
    .toEqual({error:"tool_failed_or_unavailable"});
  expect(await catalog.run("workspace_get",{key:"checkpoint"}))
    .toMatchObject({entry:{content:"Intermediate draft"}});
});

test("9B: explicit isolated photo-to-web turns do not advertise the scratchpad",async()=>{
  const saveWorkspace=jest.fn(async()=>{});
  const catalog=createToolCatalog({settings,prompt:"Найди это фото в интернете",
    history:[],skipLocalMemory:true,lookup:jest.fn().mockResolvedValue([]),
    propose:jest.fn(),onTaskState:jest.fn(),
    workspaceAvailable:()=>true,saveWorkspace,
  },[],[],[]);
  expect(catalog.definitions.some(d=>d.name.startsWith("workspace_"))).toBe(false);
  expect(await catalog.run("workspace_list",{})).toEqual({error:"tool_not_allowed"});
  expect(saveWorkspace).not.toHaveBeenCalled();
});
