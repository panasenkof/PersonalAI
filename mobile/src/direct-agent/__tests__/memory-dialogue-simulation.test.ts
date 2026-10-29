/**
 * Scripted-dialogue C1 integration: the actual production agent, tool catalog,
 * approved writer, SQL schema, FTS and source reader. Only provider replies and
 * the Expo->SQLite native bridge are controlled. No network or LLM credentials.
 * The scripted provider does NOT measure live-model understanding/accuracy.
 */
import {runDirectAgent} from "../engine";
import {saveApprovedNote,searchApprovedNotes,readApprovedNote} from "../memory";
import {SqliteMemoryRepository} from "../../local-memory/repository";
import {SCHEMA_SQL} from "../../local-memory/storage";
import type {NoteProposal} from "../fact-tool";
import type {AgentTurn,DirectAgentOptions} from "../engine";
import {defaultDirectPreferences} from "../settings";

jest.mock("expo-crypto",()=>({
  randomUUID:()=>require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:async(_algorithm:string,value:string)=>
    require("node:crypto").createHash("sha256").update(value).digest("hex"),
}));

const {DatabaseSync}=require("node:sqlite");
class RealSql {
  private readonly sql=new DatabaseSync(":memory:");
  constructor(){this.sql.exec("PRAGMA foreign_keys=ON;"+SCHEMA_SQL);}
  async getFirstAsync<T>(q:string,p:unknown[]=[]):Promise<T|null>{
    return (this.sql.prepare(q).get(...p) as T)??null;
  }
  async getAllAsync<T>(q:string,p:unknown[]=[]):Promise<T[]>{
    return this.sql.prepare(q).all(...p) as T[];
  }
  async runAsync(q:string,p:unknown[]=[]){
    return {changes:Number(this.sql.prepare(q).run(...p).changes)};
  }
  async execAsync(q:string){this.sql.exec(q);}
  close(){this.sql.close();}
}
type LLMReply={
  inspect?:(payload:any)=>void|Promise<void>;
} & ({tool:string;args:Record<string,unknown>}|{answer:string});
const response=(data:unknown)=>({ok:true,status:200,json:async()=>data});
const settings={
  ...defaultDirectPreferences,provider:"openai-compatible" as const,
  baseUrl:"https://api.example.test/v1",model:"fixture-model",apiKey:"fixture-only",
  allowWeb:false,webSearchKey:"",
};

function fixture(){
  const sql=new RealSql(), repo=new SqliteMemoryRepository(sql as never);
  const proposals:NoteProposal[]=[];
  const lookup=jest.fn((q:string)=>searchApprovedNotes("dialogue-fixture",q,repo));
  const read=jest.fn(async(id:string,version:number,offset?:number,budget?:number)=>
    ({...await readApprovedNote("dialogue-fixture",id,version,offset,budget,repo)}));
  async function run(prompt:string,script:LLMReply[],history:AgentTurn[]=[],
    override:Partial<DirectAgentOptions>={}){
    let index=0;
    const transport=jest.fn(async(_url:string,init:RequestInit)=>{
      const step=script[index++];
      if(!step)throw new Error("Unexpected model request "+index);
      const payload=JSON.parse(String(init.body));
      await step.inspect?.(payload);
      if("tool" in step){
        return response({choices:[{message:{role:"assistant",content:null,tool_calls:[{
          id:"scripted-"+index,type:"function",function:{
            name:step.tool,arguments:JSON.stringify(step.args),
          },
        }]}}]});
      }
      return response({choices:[{message:{role:"assistant",content:step.answer}}]});
    });
    const answer=await runDirectAgent({
      settings,prompt,history,transport:transport as unknown as typeof fetch,
      lookup,read,propose:(p)=>{proposals.push(p);return "proposal-"+proposals.length;},
      ...override,
    });
    expect(index).toBe(script.length);
    return {answer,transport};
  }
  return {sql,repo,proposals,lookup,read,run};
}

test("DIALOGUE-01 DOC-02/08 SAVE-01: draft -> NOT saved -> explicit approval -> SQL FTS -> source read",async()=>{
  const f=fixture();
  try{
    const title="Лазанья с грибами",body="Соус: белые грибы, сливки и зира.";
    const first=await f.run("Запомни рецепт лазаньи с грибами",[
      {tool:"draft_memory_fact",args:{title,body,kind:"note",section:"notes",person:null,date:null}},
      {answer:"Подтверди сохранение рецепта.",inspect:payload=>{
        const tool=payload.messages.find((m:any)=>m.role==="tool");
        expect(JSON.parse(tool.content)).toMatchObject({
          status:"awaiting_user_confirmation",saved:false,proposalId:"proposal-1",
        });
      }},
    ]);
    expect(first.answer.proposalIds).toEqual(["proposal-1"]);
    expect(f.proposals).toHaveLength(1);
    expect(await searchApprovedNotes("dialogue-fixture","зира",f.repo)).toEqual([]);
    const id=await saveApprovedNote("dialogue-fixture",f.proposals[0],f.repo);
    const turn=await f.run("В каком рецепте упоминается зира?",[
      {tool:"search_local_notes",args:{query:"зира"}},
      {tool:"read_local_note",args:{id,version:1,offset:0,budget:1200},inspect:payload=>{
        const result=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(result.notes).toEqual([expect.objectContaining({id,version:1})]);
      }},
      {answer:"Зира указана в лазанье с грибами.",inspect:payload=>{
        const result=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(result).toMatchObject({
          id,revision:1,evidence:{recordId:id,recordVersion:1,originalPage:null,originalTime:null},
        });
        expect(result.content).toContain("зира");
      }},
    ],[{role:"user",content:"Запомни рецепт лазаньи с грибами"},
      {role:"assistant",content:first.answer.text}]);
    expect(turn.answer.memory?.some(note=>note.id===id)).toBe(true);
    expect(turn.answer.requests).toBe(3);
    expect(turn.transport).toHaveBeenCalledTimes(3);
  }finally{f.sql.close();}
});

test("DIALOGUE-02 SAVE-03/06 SEC-08: mid-dialogue source correction blocks stale version and reindexes",async()=>{
  const f=fixture();
  try{
    const id=await saveApprovedNote("dialogue-fixture",{
      title:"Рецепт супа",body:"В суп добавляют сушёный тимьян.",kind:"note",section:"notes",
    },f.repo);
    const result=await f.run("Что сказано про тимьян?",[
      {tool:"search_local_notes",args:{query:"тимьян"}},
      {tool:"read_local_note",args:{id,version:1,offset:0,budget:1200},inspect:async payload=>{
        const found=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(found.notes).toEqual([expect.objectContaining({id,version:1})]);
        // This is an actual repository write between the model's tool steps.
        await f.repo.reviseEntity(id,1,{
          type:"note",title:"Рецепт супа",body:"В суп добавляют базилик.",
        },"Пользователь исправил рецепт");
      }},
      {answer:"Источник изменился; нужен повторный поиск.",inspect:payload=>{
        const tool=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(tool).toMatchObject({error:"tool_failed_or_unavailable"});
        expect(JSON.stringify(payload.messages)).not.toContain("В суп добавляют базилик.");
      }},
    ]);
    expect(result.answer.requests).toBe(3);
    expect(await searchApprovedNotes("dialogue-fixture","тимьян",f.repo)).toEqual([]);
    const fresh=await searchApprovedNotes("dialogue-fixture","базилик",f.repo);
    expect(fresh).toEqual([expect.objectContaining({id,version:2})]);
    await expect(readApprovedNote("dialogue-fixture",id,1,0,1200,f.repo))
      .rejects.toThrow("stale_memory_version");
    expect((await readApprovedNote("dialogue-fixture",id,2,0,1200,f.repo)).content)
      .toContain("базилик");
  }finally{f.sql.close();}
});

test("DIALOGUE-03 SEC-01/02/03: private notes never enter model context and unsupported destructive tool is denied",async()=>{
  const f=fixture();
  try{
    const visible=await saveApprovedNote("dialogue-fixture",{
      title:"Лаванда в саду",body:"Посадили лаванду у дома.",section:"notes",kind:"note",
    },f.repo);
    const privateCollection=await f.repo.createCollection({
      name:"Закрытые заметки",slug:"private-fixture",sensitivity:"secret",
    });
    const hidden=await f.repo.createEntity({
      collection_id:privateCollection.id,domain:"notes",title:"Лаванда пароль",
      payload:{body:"PRIVATE_TOKEN_FORBIDDEN лаванда"},sensitivity:"secret",
    });
    const turn=await f.run("Найди лаванду и удали все записи",[
      {tool:"search_local_notes",args:{query:"лаванда"},inspect:payload=>{
        expect(JSON.stringify(payload)).not.toContain("PRIVATE_TOKEN_FORBIDDEN");
        expect(JSON.stringify(payload)).toContain("Посадили лаванду");
      }},
      {tool:"erase_local_memory",args:{id:visible},inspect:payload=>{
        const results=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(results.notes.map((n:any)=>n.id)).toEqual([visible]);
        expect(JSON.stringify(results)).not.toContain("PRIVATE_TOKEN_FORBIDDEN");
      }},
      {answer:"Удаление не было выполнено.",inspect:payload=>{
        const outcome=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(outcome).toEqual({error:"tool_not_allowed"});
      }},
    ]);
    expect(turn.answer.requests).toBe(3);
    expect(await f.repo.entity(visible)).toMatchObject({record_status:"active"});
    expect(await f.repo.entity(hidden.id)).toMatchObject({record_status:"active"});
    expect(await searchApprovedNotes("dialogue-fixture","PRIVATE_TOKEN_FORBIDDEN",f.repo)).toEqual([]);
  }finally{f.sql.close();}
});

test("DIALOGUE-04 TIME-01 CAR-01: two dated repairs survive as separate source-backed events",async()=>{
  const f=fixture();
  try{
    const ids:string[]=[];
    for(const [title,date] of [["Замена свечей 2023","2023-06-15"],
      ["Замена свечей 2025","2025-02-01"]]){
      ids.push(await saveApprovedNote("dialogue-fixture",{
        title,body:"Менял свечи зажигания автомобиля.",kind:"event",date,section:"notes",
      },f.repo));
    }
    await f.run("Покажи все замены свечей зажигания",[
      {tool:"search_local_notes",args:{query:"свечи"}},
      {answer:"В памяти две отдельные замены свечей.",inspect:payload=>{
        const data=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(data.notes.map((x:any)=>x.id).sort()).toEqual([...ids].sort());
        expect(data.notes.every((x:any)=>x.version===1)).toBe(true);
      }},
    ]);
    expect(await Promise.all(ids.map(id=>f.repo.entity(id)))).toEqual([
      expect.objectContaining({valid_from:"2023-06-15",record_status:"active"}),
      expect.objectContaining({valid_from:"2025-02-01",record_status:"active"}),
    ]);
  }finally{f.sql.close();}
});

test("DIALOGUE-05 REL-01/06/08: only user-confirmed person+participant evidence reaches canonical linked search",async()=>{
  const f=fixture();
  try{
    const col=await f.repo.createCollection({name:"Люди",slug:"people-fixture",sensitivity:"standard"});
    const me=await f.repo.createEntity({collection_id:col.id,domain:"notes",kind:"person",payload:{body:"Владелец"}});
    const sister=await f.repo.createEntity({collection_id:col.id,domain:"notes",kind:"person",payload:{body:"Вера"}});
    const namesake=await f.repo.createEntity({collection_id:col.id,domain:"notes",kind:"person",payload:{body:"Другая Вера"}});
    const family=await f.repo.createEntity({collection_id:col.id,domain:"notes",payload:{body:"Моя сестра Вера"}});
    const recorded=await f.repo.createEntity({collection_id:col.id,domain:"notes",kind:"note",
      title:"Разговор с Верой",payload:{body:"Разговаривали с Верой о книге"}});
    const mentioned=await f.repo.createEntity({collection_id:col.id,domain:"notes",kind:"note",
      title:"Обсуждали Веру",payload:{body:"Говорил с Павлом о Вере"}});
    const role={ownerPersonId:me.id,relationKind:"has_sister" as const};
    expect(await f.repo.searchMemory("Разговор с сестрой",{verifiedRelative:role})).toEqual([]);
    await f.repo.confirmUserRelationProof({
      sourceId:me.id,sourceVersion:1,targetId:sister.id,targetVersion:1,
      kind:"has_sister",evidenceId:family.id,evidenceVersion:1,
      evidenceQuote:"Моя сестра Вера",userConfirmed:true,
    });
    // A kinship fact alone does not prove anyone took part in an audio call.
    expect(await f.repo.searchMemory("Разговор с сестрой",{verifiedRelative:role})).toEqual([]);
    await f.repo.confirmUserRelationProof({
      sourceId:recorded.id,sourceVersion:1,targetId:sister.id,targetVersion:1,
      kind:"participant_of",evidenceId:recorded.id,evidenceVersion:1,
      evidenceQuote:"Разговаривали с Верой о книге",userConfirmed:true,
    });
    const found=await f.repo.searchMemory("Разговор с сестрой",{verifiedRelative:role});
    expect(found.map(hit=>hit.entity.id)).toEqual([recorded.id]);
    expect(found[0].proof).toMatchObject({relativeId:sister.id});
    expect(found.map(hit=>hit.entity.id)).not.toContain(mentioned.id);
    expect(found.map(hit=>hit.entity.id)).not.toContain(namesake.id);
    await f.repo.reviseEntity(family.id,1,{body:"Исправлено: это не сестра"},"Исправил связь");
    expect(await f.repo.searchMemory("Разговор с сестрой",{verifiedRelative:role})).toEqual([]);
  }finally{f.sql.close();}
});

test("DIALOGUE-06 SEARCH-07: missing memory remains empty; the engine never silently calls the web",async()=>{
  const f=fixture();
  try{
    const turn=await f.run("Как называется неизвестный проект?",[
      {tool:"search_local_notes",args:{query:"неизвестный проект"}},
      {answer:"В сохранённой памяти нет подтверждённых сведений.",inspect:payload=>{
        const result=JSON.parse(payload.messages.filter((m:any)=>m.role==="tool").at(-1).content);
        expect(result).toEqual({notes:[]});
        expect(JSON.stringify(payload.tools)).not.toContain("search_web");
      }},
    ]);
    expect(turn.answer.sources).toEqual([]);
    expect(turn.answer.memory ?? []).toEqual([]);
  }finally{f.sql.close();}
});
