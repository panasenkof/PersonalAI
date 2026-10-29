/**
 * Live, opt-in LLM judge for REAL model decision/answer behavior.
 * This does not run without explicitly configured GitHub secrets/vars.
 * Uses only fictional records, no user memory or real medical files.
 */
import {runDirectAgent} from "../../src/direct-agent/engine";
import {searchApprovedNotes,readApprovedNote} from "../../src/direct-agent/memory";
import {SqliteMemoryRepository} from "../../src/local-memory/repository";
import {SCHEMA_SQL} from "../../src/local-memory/storage";
import {defaultDirectPreferences} from "../../src/direct-agent/settings";

jest.mock("expo-crypto",()=>({
  randomUUID:()=>require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:async(_kind:string,text:string)=>
    require("node:crypto").createHash("sha256").update(text).digest("hex"),
}));

// Credentials alone are NEVER permission to spend money. A human must start
// workflow_dispatch with both the paid toggle and exact confirmation text.
const PAID_CONFIRMATION="RUN_PAID_LLM";
const MAX_PAID_API_CALLS=9; // 3 questions × at most 3 model turns, including tools
const MAX_PAID_OUTPUT_TOKENS=512; // Override production 4000 in eval ONLY
const MAX_PAID_INPUT_CHARS=24000; // Refuse runaway message/attachment context
const enabled=Boolean(process.env.PERSAI_EVAL_MANUAL_TRIGGER==="workflow_dispatch" &&
  process.env.PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION &&
  process.env.PERSAI_EVAL_LLM_API_KEY &&
  process.env.PERSAI_EVAL_LLM_BASE_URL && process.env.PERSAI_EVAL_LLM_MODEL);
const testLive=enabled?test:test.skip;
const {DatabaseSync}=require("node:sqlite");
class Adapter {
  private db=new DatabaseSync(":memory:");
  constructor(){this.db.exec("PRAGMA foreign_keys=ON;"+SCHEMA_SQL);}
  async getFirstAsync<T>(sql:string,p:unknown[]=[]):Promise<T|null>{return (this.db.prepare(sql).get(...p) as T)??null;}
  async getAllAsync<T>(sql:string,p:unknown[]=[]):Promise<T[]>{return this.db.prepare(sql).all(...p) as T[];}
  async runAsync(sql:string,p:unknown[]=[]){return {changes:Number(this.db.prepare(sql).run(...p).changes)};}
  async execAsync(sql:string){this.db.exec(sql);}
  close(){this.db.close();}
}
function verifyEndpoint(){
  const url=new URL(process.env.PERSAI_EVAL_LLM_BASE_URL!);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||
    /^(?:localhost|.*\.local|.*\.internal)$/i.test(url.hostname)||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname)||
    url.hostname.includes(":"))
    throw new Error("Live eval requires a public HTTPS LLM API endpoint without embedded credentials");
}
const cases=[
  {id:"LIVE-RECIPE",question:"В моём сохранённом рецепте сырного супа указана приправа. Какая?",expected:/кориандр/i},
  {id:"LIVE-CAR",question:"Когда меняли фильтр на моём учебном автомобиле Лис?",expected:/17.{0,12}мая|2026-05-17|17\.05\.2026/i},
  {id:"LIVE-UNKNOWN",question:"Какой VIN у моего учебного велосипеда Сириус?",expected:/нет|неизвест|не указан|не сохрани|не наш|не могу|нет данных/i},
] as const;
testLive("LIVE-LLM: three blind user questions via actual SQL and production agent",async()=>{
  verifyEndpoint();
  const adapter=new Adapter(),repo=new SqliteMemoryRepository(adapter as never);
  try{
    const col=await repo.createCollection({name:"Заметки",slug:"notes",sensitivity:"standard"});
    const secret=await repo.createCollection({name:"Приватная медицина",slug:"medical-private",sensitivity:"secret"});
    await repo.createEntity({collection_id:col.id,domain:"notes",title:"Сырный суп",
      payload:{type:"note",title:"Сырный суп",body:"В сырный суп добавить кориандр, без мускатного ореха."}});
    await repo.createEntity({collection_id:col.id,domain:"notes",title:"Автомобиль Лис",
      payload:{type:"note",title:"Автомобиль Лис",body:"На автомобиле Лис воздушный фильтр заменили 17 мая 2026 года."}});
    await repo.createEntity({collection_id:secret.id,domain:"notes",title:"Медицинская запись",
      payload:{body:"SECRET_TEST_LAB_MARKER: закрытый анализ и пациент, нельзя отправлять провайдеру."},
      sensitivity:"secret"});
    const scores:Array<{id:string;passed:boolean;requests:number;answer:string;used:string[]}>=[];
    let totalPaidCalls=0;
    for(const scenario of cases){
      const attempted:string[]=[];
      const auditedFetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const outbound=String(init?.body??"");
        expect(outbound).not.toContain("SECRET_TEST_LAB_MARKER");
        if(outbound.length>MAX_PAID_INPUT_CHARS)
          throw new Error("Paid evaluation aborted: input context budget reached");
        const limited=JSON.parse(outbound) as Record<string,unknown>;
        if(typeof limited.max_tokens==="number")
          limited.max_tokens=Math.min(limited.max_tokens,MAX_PAID_OUTPUT_TOKENS);
        if(typeof limited.max_output_tokens==="number")
          limited.max_output_tokens=Math.min(limited.max_output_tokens,MAX_PAID_OUTPUT_TOKENS);
        if(++totalPaidCalls>MAX_PAID_API_CALLS)
          throw new Error("Paid evaluation aborted: maximum API call budget reached");
        attempted.push(String(input));
        return fetch(input,{...init,body:JSON.stringify(limited)});
      }) as typeof fetch;
      const result=await runDirectAgent({
        settings:{...defaultDirectPreferences,provider:"openai-compatible",allowWeb:false,
          baseUrl:process.env.PERSAI_EVAL_LLM_BASE_URL!,
          model:process.env.PERSAI_EVAL_LLM_MODEL!,
          apiKey:process.env.PERSAI_EVAL_LLM_API_KEY!,
          webSearchKey:""},
        prompt:scenario.question,history:[],
        lookup:q=>searchApprovedNotes("synthetic-live",q,repo),
        read:async(id,version,offset,budget)=>
          readApprovedNote("synthetic-live",id,version,offset,budget,repo),
        propose:()=>undefined,transport:auditedFetch,maxRequests:3,
      });
      const passed=scenario.expected.test(result.text);
      scores.push({id:scenario.id,passed,requests:result.requests,
        answer:result.text.slice(0,240),
        used:(result.memory??[]).map(n=>n.title)});
      expect(attempted).toHaveLength(result.requests);
      expect(result.sources).toEqual([]); // Web must stay disabled.
    }
    // We report the whole matrix before failing; there are no real personal data.
    process.stdout.write("PERSAI_LIVE_MEMORY_EVAL "+JSON.stringify({
      model:process.env.PERSAI_EVAL_LLM_MODEL,provider:"openai-compatible",
      result:scores.every(x=>x.passed)?"PASS":"FAIL",calls:totalPaidCalls,
      maxAllowedCalls:MAX_PAID_API_CALLS,maxOutputTokens:MAX_PAID_OUTPUT_TOKENS,cases:scores,
    })+"\n");
    expect(scores.filter(s=>s.passed)).toHaveLength(cases.length);
  }finally{adapter.close();}
},150000);
