import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentSettings } from "../settings";

const settings: DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",
  model:"test-model",apiKey:"test",webSearchKey:"",allowWeb:false,
};

test("read_local_note can read a long note beyond prefetch and records the actual source first",async()=>{
  const initial=Array.from({length:8},(_,i)=>({
    id:"prefetch-"+i,title:"Found "+i,via:"search" as const,
  }));
  const read=jest.fn().mockImplementation(async(id:string,version:number,offset=0,budget=4000)=>({
    id,revision:version,title:"Long evidence",content:"A".repeat(Math.min(6000,budget)),
    offset,totalChars:52_000,hasMore:true,nextOffset:offset+Math.min(6000,budget),
    evidence:{recordId:id,recordVersion:version,startChar:offset,
      endChar:offset+Math.min(6000,budget),coverage:"excerpt",originalPage:null,originalTime:null},
  }));
  const catalog=createToolCatalog({settings,prompt:"Разбери позднюю часть записи",
    history:[],lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),read,
  },[],[],initial);
  const first=await catalog.run("read_local_note",{
    id:"deep",version:7,offset:30_000,budget:6000,
  });
  expect(first).toMatchObject({outcome:"read",offset:30_000,hasMore:true,nextOffset:36_000});
  expect(read).toHaveBeenCalledWith("deep",7,30_000,6000);
  expect(catalog.memory()[0]).toEqual({id:"deep",title:"Long evidence",via:"assistant"});
  expect(await catalog.run("read_local_note",{
    id:"deep",version:7,offset:36_000,budget:6001,
  })).toMatchObject({error:"invalid_memory_read_request"});
  expect(read).toHaveBeenCalledTimes(1);
});

test("stale/mismatched read response cannot be claimed as a used note",async()=>{
  const catalog=createToolCatalog({settings,prompt:"Найди источник",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    read:jest.fn().mockResolvedValue({id:"another",revision:7,title:"Incorrect",
      content:"Wrong text",hasMore:false}),
  },[],[],[]);
  await catalog.run("read_local_note",{id:"expected",version:7,offset:0,budget:4000});
  expect(catalog.memory()).toEqual([]);
});
