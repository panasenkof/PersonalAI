/**
 * Cross-domain evidence battery. Real SQL schema/repository; no fake search.
 * Questions are retained as blind LLM eval prompts; phrase is the controlled
 * retrieval hint and MUST NOT be mistaken for natural-language LLM accuracy.
 */
import {createHash,randomUUID} from "node:crypto";
import {SqliteMemoryRepository} from "../../src/local-memory/repository";
import {SCHEMA_SQL} from "../../src/local-memory/storage";
import {searchApprovedNotes,readApprovedNote} from "../../src/direct-agent/memory";
import {saveExtractionRun,extractionEvidence} from "../../src/local-memory/extractions";
import {listApprovedSourceSegments} from "../../src/local-memory/source-retrieval";
import {CASES,type DomainCase} from "../domain-fixtures";
import {runDirectAgent} from "../../src/direct-agent/engine";
import {defaultDirectPreferences} from "../../src/direct-agent/settings";

jest.mock("expo-crypto",()=>({
  randomUUID:()=>require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:async(_kind:string,text:string)=>
    require("node:crypto").createHash("sha256").update(text).digest("hex"),
}));

const {DatabaseSync}=require("node:sqlite");
class MemorySql {
  private sql=new DatabaseSync(":memory:");
  constructor(){this.sql.exec("PRAGMA foreign_keys=ON;"+SCHEMA_SQL);}
  async getFirstAsync<T>(q:string,p:unknown[]=[]):Promise<T|null>{return (this.sql.prepare(q).get(...p) as T)??null;}
  async getAllAsync<T>(q:string,p:unknown[]=[]):Promise<T[]>{return this.sql.prepare(q).all(...p) as T[];}
  async runAsync(q:string,p:unknown[]=[]){return {changes:Number(this.sql.prepare(q).run(...p).changes)};}
  async execAsync(q:string){this.sql.exec(q);}
  close(){this.sql.close();}
}
type Fixture={sql:MemorySql;repo:SqliteMemoryRepository;ids:Map<string,string>;
  collections:Map<string,string>;people:Map<string,string>};
async function seed():Promise<Fixture>{
  const sql=new MemorySql(),repo=new SqliteMemoryRepository(sql as never);
  const collections=new Map<string,string>();
  for(const [key,title,level] of [
    ["car-standard","Обслуживание автомобиля","standard"],["car-sensitive","Документы автомобиля","sensitive"],
    ["recipes-standard","Рецепты","standard"],["web-standard","Сохранённые статьи","standard"],
    ["home-standard","Домашние вещи","standard"],["home-sensitive","Домашний сейф","sensitive"],
    ["medical-sensitive","Медицинские данные","sensitive"],
  ] as const){
    collections.set(key,(await repo.createCollection({name:title,slug:key,sensitivity:level})).id);
  }
  const people=new Map<string,string>();
  const medical=collections.get("medical-sensitive")!;
  for(const [id,name] of [["person-owner","Алексей"],["person-maria","Мария"],["person-dmitry","Дмитрий"]]){
    const p=await repo.createEntity({collection_id:medical,domain:"notes",kind:"person",title:name,
      payload:{type:"person",title:name,body:"Вымышленный пациент "+name,identity:id},
      sensitivity:"sensitive"});
    people.set(id,p.id);
  }
  const ids=new Map<string,string>();
  for(const row of CASES){
    const key=row.domain==="medical"?"medical-sensitive":row.domain==="car"
      ? "car-"+row.scope:row.domain==="home"?"home-"+row.scope:row.domain+"-standard";
    const entity=await repo.createEntity({
      collection_id:collections.get(key)!,domain:"notes",
      title:row.title,
      payload:{type:"note",title:row.title,body:row.body,
        ...(row.owner?{subject_id:row.owner}:{}),
        ...(row.source?{source_url:row.source}:{}),
      },
      sensitivity:row.scope,
      source_kind:row.source?"link":"user",
      source_ref:row.source??null,
    });
    ids.set(row.id,entity.id);
    if(row.owner)await repo.linkEntities(entity.id,people.get(row.owner)!,"about");
  }
  return {sql,repo,ids,collections,people};
}
let f:Fixture;
beforeAll(async()=>{f=await seed();},30000);
afterAll(()=>f?.sql.close());

test("domain fixture covers all requested families with 54 independently named records",()=>{
  expect(CASES).toHaveLength(54);
  for(const domain of ["car","recipes","web","home","medical"]){
    expect(CASES.filter(x=>x.domain===domain).length).toBeGreaterThanOrEqual(8);
  }
  expect(new Set(CASES.map(x=>x.id)).size).toBe(CASES.length);
  expect(CASES.filter(x=>x.owner).map(x=>x.owner)).toEqual(expect.arrayContaining([
    "person-owner","person-maria","person-dmitry",
  ]));
});

test.each(CASES)("$id — $q: scoped production FTS locates the correct original",async(row:DomainCase)=>{
  const id=f.ids.get(row.id)!;
  const collectionKey=row.domain==="medical"?"medical-sensitive":row.domain==="car"
    ?"car-"+row.scope:row.domain==="home"?"home-"+row.scope:row.domain+"-standard";
  const hits=await f.repo.searchMemory(row.phrase,{
    collectionIds:[f.collections.get(collectionKey)!],
    sensitivities:[row.scope,"inherit"],limit:20,
  });
  expect(hits.map(h=>h.entity.id)).toContain(id);
  expect((await f.repo.entity(id))?.payload.body).toBe(row.body);
  if(row.scope==="standard"){
    const agent=await searchApprovedNotes("fixture",row.phrase,f.repo);
    expect(agent.map(h=>h.id)).toContain(id);
    const hit=agent.find(h=>h.id===id)!;
    const original=await readApprovedNote("fixture",id,hit.version!,0,6000,f.repo);
    expect(original.content).toContain(row.phrase.length>2?row.phrase.split("-")[0]:"");
    expect(original.evidence).toMatchObject({
      recordId:id,recordVersion:1,originalPage:null,originalTime:null,
    });
  }else{
    // Private medical, vehicle documents and house keys never leave the device.
    expect(await searchApprovedNotes("fixture",row.phrase,f.repo)).not.toContainEqual(
      expect.objectContaining({id}),
    );
    await expect(readApprovedNote("fixture",id,1,0,200,f.repo))
      .rejects.toThrow("memory_read_not_available");
  }
},30000);


test.each(CASES)("AGENT-$id — $q: real tool dispatch preserves ACL and correct source",async(row:DomainCase)=>{
  const id=f.ids.get(row.id)!;
  const sent:string[]=[];
  let request=0;
  const transport=(async(_url:string,init:RequestInit)=>{
    request++;
    const payload=JSON.parse(String(init.body));
    const serialized=JSON.stringify(payload);
    if(row.scope==="sensitive"){
      expect(serialized).not.toContain(row.body);
    }
    if(request===1){
      // Only the provider is scripted: all resulting search and evidence data
      // are resolved through the real production FTS/ACL implementation.
      return {ok:true,status:200,json:async()=>({
        choices:[{message:{role:"assistant",content:null,tool_calls:[{
          id:"lookup-1",type:"function",function:{
            name:"search_local_notes",arguments:JSON.stringify({query:row.phrase}),
          },
        }]}}],
      })};
    }
    const tools=payload.messages.filter((m:any)=>m.role==="tool");
    expect(tools).toHaveLength(1);
    const data=JSON.parse(tools[0].content);
    expect(Array.isArray(data.notes)).toBe(true);
    if(row.scope==="standard"){
      expect(data.notes.map((n:any)=>n.id)).toContain(id);
    }else{
      expect(data.notes.map((n:any)=>n.id)).not.toContain(id);
      expect(serialized).not.toContain(row.body);
    }
    sent.push(row.id);
    return {ok:true,status:200,json:async()=>({
      choices:[{message:{role:"assistant",content:row.scope==="standard"
        ?"Результат поиска доступен и подтверждён источником."
        :"Закрытые записи не передаются в облачную модель."}}],
    })};
  }) as unknown as typeof fetch;
  const result=await runDirectAgent({
    settings:{...defaultDirectPreferences,provider:"openai-compatible",allowWeb:false,
      baseUrl:"https://eval.example.test/v1",model:"scripted",apiKey:"fictional-key",webSearchKey:""},
    prompt:row.q,history:[],transport,
    lookup:query=>searchApprovedNotes("synthetic-domain",query,f.repo),
    read:async(rid,version,offset,budget)=>readApprovedNote("synthetic-domain",rid,version,offset,budget,f.repo),
    propose:()=>undefined,
  });
  expect(request).toBe(2);
  expect(sent).toEqual([row.id]);
  expect(result.sources).toEqual([]);
  if(row.scope==="standard"){
    expect(result.memory?.some(n=>n.id===id)).toBe(true);
  }else{
    expect(result.memory?.some(n=>n.id===id)).not.toBe(true);
  }
});

test("CAR-01/02: successive oil changes are events, not superseding current state",async()=>{
  const older=(await f.repo.entity(f.ids.get("car-oil-23")!))!;
  const newer=(await f.repo.entity(f.ids.get("car-oil-25")!))!;
  expect(older.payload.body).toContain("34000 км");
  expect(newer.payload.body).toContain("62000 км");
  expect(older.id).not.toBe(newer.id);
  expect(older.record_status).toBe("active");
  expect(newer.record_status).toBe("active");
  expect((await f.repo.searchMemory("масла",{collectionIds:[older.collection_id]}))
    .map(x=>x.entity.id)).toEqual(expect.arrayContaining([older.id,newer.id]));
});

test("CAR-DOC: service estimate, policy, receipts and registrations are distinct original records",async()=>{
  const keys=["car-brakes","car-clutch","car-policy","car-reg","car-receipt","car-battery","car-inspection"];
  const originals=await Promise.all(keys.map(k=>f.repo.entity(f.ids.get(k)!)));
  expect(new Set(originals.map(x=>x?.id)).size).toBe(keys.length);
  expect(originals.every(x=>x?.sensitivity==="sensitive")).toBe(true);
  expect(originals.find(x=>x!.title==="Страховой полис")!.payload.body).toContain("2027-05-31");
  expect(originals.find(x=>x!.title==="Наряд-заказ сцепление")!.payload.body).toContain("2026-02-09");
  // An ambiguous repair status cannot silently become a completion event.
  expect((await f.repo.entity(f.ids.get("car-diagnostic")!))!.payload.body).toContain("не отмечено как устранённое");
  expect((await f.repo.entity(f.ids.get("car-incident")!))!.payload.body).toContain("не указана");
});

test("RECIPE-EDIT: two lasagna recipes survive edits, old ingredient becomes unfindable",async()=>{
  const old=f.ids.get("recipe-white")!,other=f.ids.get("recipe-tomato")!;
  const entity=(await f.repo.entity(old))!;
  const edited=await f.repo.reviseEntity(old,1,{
    ...entity.payload,body:"Соус бешамель: молоко, мука, чёрный перец. Данные изменил пользователь.",
  },"Исправлена специя");
  expect(edited.record_version).toBe(2);
  expect((await f.repo.revisions("entity",old))[0].before_state.payload).toMatchObject({
    body:expect.stringContaining("мускатный"),
  });
  expect((await searchApprovedNotes("fixture","мускатный",f.repo)).map(n=>n.id)).not.toContain(old);
  expect((await searchApprovedNotes("fixture","индейки",f.repo)).map(n=>n.id)).toContain(other);
  await expect(readApprovedNote("fixture",old,1,0,400,f.repo)).rejects.toThrow("stale_memory_version");
});

test("WEB-SNAPSHOT: old web article keeps captured URL/date; unfetched link has no invented text",async()=>{
  const ai=(await f.repo.entity(f.ids.get("web-rag")!))!;
  expect(ai.source_ref).toBe("https://example.test/ai/rag");
  expect(ai.payload.body).toContain("2026-08-21");
  const link=(await f.repo.entity(f.ids.get("web-repair")!))!;
  expect(link.payload.body).toContain("полный текст не загружался");
  expect(link.source_ref).toBe("https://example.test/repair/meter");
  const read=await readApprovedNote("fixture",link.id,1,0,2000,f.repo);
  expect(read.evidence.originalPage).toBeNull();
  expect(read.evidence.originalTime).toBeNull();
  expect(read.content).not.toContain("показания мультиметра");
});

test("WEB-LIVE-RECOVERY: conditional absence and nominative queries locate a saved link, not unseen text",async()=>{
  const target=f.ids.get("web-repair")!;
  const natural="Открой все детали из статьи о мультиметре. Если полный текст не сохранился, скажи об этом.";
  for(const query of [natural,"мультиметр статья","статья о мультиметре"]){
    const hits=await searchApprovedNotes("synthetic-domain",query,f.repo);
    expect(hits.map(n=>n.id)).toContain(target);
    expect(hits.length).toBeLessThanOrEqual(5);
  }
  const hit=(await searchApprovedNotes("synthetic-domain",natural,f.repo)).find(n=>n.id===target)!;
  const opened=await readApprovedNote("synthetic-domain",hit.id,hit.version!,0,4000,f.repo);
  expect(opened.content).toContain("полный текст не загружался");
  expect(opened.content).not.toContain("показания мультиметра");
  // A conditional user's instruction must not grant access to private notes.
  expect((await searchApprovedNotes("synthetic-domain","СТС",f.repo))
    .map(n=>n.id)).not.toContain(f.ids.get("car-reg")!);
});

test("HOME-PHOTOS: independently bound image originals and location caption survive correction",async()=>{
  const cable=f.ids.get("home-cables")!,camera=f.ids.get("home-camera")!;
  for(const [id,attachment,description] of [[cable,"home-photo-cables","box.jpg"],
    [camera,"home-photo-camera","backpack.jpg"]] as const){
    const bytes=Uint8Array.from([255,216,255,224,1,2,3,4]);
    const sha=createHash("sha256").update(bytes).digest("hex");
    await f.sql.runAsync("INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
      [attachment,id,description,"image/jpeg",bytes.length,"2026-10-29"]);
    await f.sql.runAsync("INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
      [attachment,0,bytes,sha]);
    const linked=await f.sql.getFirstAsync<{entity_id:string;sha256:string}>(
      "SELECT a.entity_id,p.sha256 FROM memory_attachments a JOIN memory_attachment_parts p ON p.attachment_id=a.id WHERE a.id=?",
      [attachment]);
    expect(linked).toEqual({entity_id:id,sha256:sha});
  }
  // Photo bytes are synthetic; only explicit location captions are searchable.
  expect((await searchApprovedNotes("fixture","HDMI",f.repo)).map(n=>n.id)).toContain(cable);
  const record=(await f.repo.entity(camera))!;
  await f.repo.reviseEntity(camera,1,{...record.payload,body:"Камера теперь на антресоли гостиной."},"Перемещена камера");
  expect((await searchApprovedNotes("fixture","антресоли",f.repo)).map(n=>n.id)).toContain(camera);
  expect((await f.sql.getAllAsync("SELECT id FROM memory_attachments WHERE entity_id=?",[camera]))).toHaveLength(1);
  // NOT covered: recognizing an unlabeled object's appearance inside photos.
});

test("MED-FAMILY: explicit per-person relations and three independent lab measurements",async()=>{
  const records=["med-me-cbc","med-maria-cbc","med-dmitry-cbc"];
  const values=["142 г/л","126 г/л","155 г/л"];
  for(const [index,key] of records.entries()){
    const id=f.ids.get(key)!,spec=CASES.find(x=>x.id===key)!;
    const entity=(await f.repo.entity(id))!;
    expect(entity.payload.body).toContain(values[index]);
    expect(entity.payload.subject_id).toBe(spec.owner);
    const links=await f.repo.relationsForEntity(id);
    expect(links.map(x=>x.target_entity_id)).toContain(f.people.get(spec.owner!)!);
    expect(links.filter(x=>x.kind==="about")).toHaveLength(1);
    expect(await searchApprovedNotes("fixture",spec.phrase,f.repo)).toEqual([]);
  }
  // An exact record ID never gets silently replaced with a similarly named person's record.
  expect(f.ids.get(records[0])).not.toBe(f.ids.get(records[1]));
});

test("MED-MISSING: not supplied findings are not diagnosed or invented",async()=>{
  const mri=(await f.repo.entity(f.ids.get("med-maria-mri")!))!;
  const ekg=(await f.repo.entity(f.ids.get("med-dmitry-ecg")!))!;
  const glucose=(await f.repo.entity(f.ids.get("med-dmitry-glucose")!))!;
  expect(mri.payload.body).toContain("заключения отсутствует");
  expect(ekg.payload.body).toContain("не приложен");
  expect(glucose.payload.body).toContain("натощак не указано");
  expect(JSON.stringify([mri.payload,ekg.payload,glucose.payload])).not.toMatch(/диагноз:|диабет установлен/i);
});

test("PRIVATE-SCOPE: archive/reclassify never make test medical notes exportable",async()=>{
  const id=f.ids.get("med-maria-iron")!;
  const entity=(await f.repo.entity(id))!;
  await f.repo.reviseEntity(id,1,entity.payload,"Исправлена дата анализа",
    f.collections.get("home-standard")!);
  expect((await f.repo.entity(id))?.sensitivity).toBe("sensitive");
  expect((await searchApprovedNotes("fixture","ЛБ-202",f.repo)).map(x=>x.id)).not.toContain(id);
  await f.repo.setEntityStatus(id,2,"archived");
  expect((await f.repo.searchMemory("ЛБ-202",{sensitivities:["sensitive","inherit"]})).map(x=>x.entity.id)).not.toContain(id);
});


test("MED/CAR PDF: independently owned original reports, stated page and unknown coordinates",async()=>{
  const samples=[
    {key:"car-brakes",filename:"repair.pdf",text:"Колoдки: акт РТ-481",page:2},
    {key:"med-maria-cbc",filename:"cbc-maria.pdf",text:"Мария, гемоглобин 126 г/л",page:1},
    {key:"med-dmitry-cbc",filename:"cbc-dmitry.pdf",text:"Дмитрий, гемоглобин 155 г/л",page:3},
  ];
  for(const spec of samples){
    const id=f.ids.get(spec.key)!,attachmentId=randomUUID();
    const bytes=Uint8Array.from(Buffer.from("%PDF-1.4\nfixture-"+spec.key));
    const hash=createHash("sha256").update(bytes).digest("hex");
    await f.sql.runAsync("INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
      [attachmentId,id,spec.filename,"application/pdf",bytes.length,"2026-10-29"]);
    await f.sql.runAsync("INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
      [attachmentId,0,bytes,hash]);
    await saveExtractionRun(f.sql as never,{
      attachmentId,producerKind:"pdf",producerId:"fixture-pdf",producerRevision:"v1",
      coverage:"partial",status:"partial",language:"ru",
      segments:[
        {text:spec.text,location:{kind:"page",page:spec.page}},
        {text:"Дополнительное поле без подтверждённого номера страницы",location:{kind:"unknown"}},
      ],
    });
    const local=await extractionEvidence(f.sql as never,id,attachmentId);
    expect(local).toHaveLength(1);
    expect(local[0].segments.map(x=>x.location)).toEqual([
      {kind:"page",page:spec.page},{kind:"unknown"},
    ]);
    const wrongOwner=f.ids.get(spec.key==="car-brakes"?"med-maria-cbc":"car-brakes")!;
    expect(await extractionEvidence(f.sql as never,wrongOwner,attachmentId)).toEqual([]);
    await expect(listApprovedSourceSegments(f.sql as never,id,1))
      .rejects.toThrow("memory_source_not_available_or_stale");
    // This test uses a PDF-like byte fixture, NOT actual PDF parser/OCR quality.
    expect((await f.sql.getFirstAsync<{n:number}>(
      "SELECT count(*) AS n FROM memory_attachment_parts WHERE attachment_id=?",[attachmentId]))!.n).toBe(1);
  }
});

test("MED-FAMILY correction does not modify another person's lab original or history",async()=>{
  const mariaId=f.ids.get("med-maria-vit")!,alexId=f.ids.get("med-me-chol")!;
  const alex=(await f.repo.entity(alexId))!,maria=(await f.repo.entity(mariaId))!;
  await f.repo.reviseEntity(mariaId,1,{
    ...maria.payload,body:"Пациент Мария, витамин D 33 нг/мл; пользователь исправил опечатку бланка.",
  },"Исправление значения по бумажному оригиналу");
  expect((await f.repo.entity(alexId))!.payload.body).toBe(alex.payload.body);
  expect((await f.repo.entity(mariaId))!.payload.body).toContain("33 нг/мл");
  expect((await f.repo.revisions("entity",mariaId))).toHaveLength(1);
  expect((await f.repo.revisions("entity",alexId))).toHaveLength(0);
  expect((await f.repo.relationsForEntity(mariaId)).map(x=>x.target_entity_id))
    .toEqual([f.people.get("person-maria")!]);
});
