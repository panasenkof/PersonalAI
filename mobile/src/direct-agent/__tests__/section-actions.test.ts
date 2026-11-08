import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../../local-memory/storage";
import { SqliteMemoryRepository } from "../../local-memory/repository";
import { previewSectionAction, confirmSectionAction, validSectionProposal } from "../section-actions";

let mockDatabase:SqliteAdapter;
let mockUnlocked=true;
let mockCounter=0;
jest.mock("../../local-memory/storage",()=>({
  ...jest.requireActual("../../local-memory/storage"),
  localMemorySessionUnlocked:()=>mockUnlocked,
  withLocalMemoryDatabase:async(_profile:string,action:(db:SqliteAdapter)=>Promise<unknown>)=>action(mockDatabase),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>("generated-"+(++mockCounter))}));
class SqliteAdapter {
  readonly db=new DatabaseSync(":memory:");
  constructor(){this.db.exec(SCHEMA_SQL);this.db.exec("PRAGMA foreign_keys=ON");}
  async execAsync(sql:string){this.db.exec(sql);}
  async getFirstAsync<T>(sql:string,params:unknown[]=[]):Promise<T|null>{
    return (this.db.prepare(sql).get(...(params as any[])) as T)??null;
  }
  async getAllAsync<T>(sql:string,params:unknown[]=[]):Promise<T[]>{
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }
  async runAsync(sql:string,params:unknown[]=[]){
    const result=this.db.prepare(sql).run(...(params as any[]));
    return {changes:Number(result.changes)};
  }
}
let repo:SqliteMemoryRepository;
beforeEach(()=>{
  mockCounter=0;mockUnlocked=true;mockDatabase=new SqliteAdapter();
  repo=new SqliteMemoryRepository(mockDatabase as never);
});
afterEach(()=>mockDatabase.db.close());

test("deep parent path is a valid preview, but its creation is deferred to user tap",async()=>{
  const ai=await repo.createCollection({name:"ИИ",slug:"section-ai",sensitivity:"standard"});
  const training=await repo.createCollection({name:"Обучение",slug:"section-training",parentId:ai.id});
  const proposed=await previewSectionAction("guest",{kind:"create",name:"Полезные скиллы",
    parentSlug:training.slug,reason:"Пользователь попросил создать подраздел"});
  expect(proposed).toMatchObject({kind:"create",name:"Полезные скиллы",
    parentId:training.id,parentName:"ИИ / Обучение"});
  expect(validSectionProposal(proposed)).toBe(true);
  expect((await repo.listCollections())).toHaveLength(2);
  const receipt=await confirmSectionAction("guest",proposed);
  expect(receipt).toMatchObject({kind:"create",verified:true,parentName:"ИИ / Обучение"});
  expect((await repo.listCollections()).find(c=>c.id===receipt.id)?.parent_id).toBe(training.id);
});

test("deletion requires empty custom section; archived/trashed notes and children block it",async()=>{
  const root=await repo.createCollection({name:"ИИ",slug:"section-ai",sensitivity:"standard"});
  const child=await repo.createCollection({name:"Обучение",slug:"section-learn",parentId:root.id});
  await expect(previewSectionAction("guest",{kind:"delete",sectionSlug:root.slug,
    reason:"Удалить по запросу пользователя"})).rejects.toThrow("section_has_children");
  const note=await repo.createEntity({collection_id:child.id,domain:"notes",
    title:"Курс",payload:{body:"Материал"}});
  await repo.setEntityStatus(note.id,note.record_version,"archived");
  await expect(previewSectionAction("guest",{kind:"delete",sectionSlug:child.slug,
    reason:"Удалить по запросу пользователя"})).rejects.toThrow("section_not_empty");
  await mockDatabase.runAsync("DELETE FROM memory_entities WHERE id=?",[note.id]);
  const preview=await previewSectionAction("guest",{kind:"delete",sectionSlug:child.slug,
    reason:"Удалить по запросу пользователя"});
  await repo.createEntity({collection_id:child.id,domain:"notes",title:"Позже",payload:{body:"Снова заполнено"}});
  await expect(confirmSectionAction("guest",preview)).rejects.toThrow("collection_not_empty");
  expect((await repo.listCollections()).some(c=>c.id===child.id)).toBe(true);
});

test("cannot delete protected collections or confirm a stale moved folder",async()=>{
  const notes=await repo.createCollection({name:"Заметки",slug:"notes",sensitivity:"standard"});
  const privateFolder=await repo.createCollection({name:"Личное",slug:"private",sensitivity:"sensitive"});
  const standard=await repo.createCollection({name:"Обычное",slug:"section-standard",sensitivity:"standard"});
  const move=await repo.createCollection({name:"Пустое",slug:"section-empty",sensitivity:"standard"});
  for(const slug of [notes.slug,privateFolder.slug])
    await expect(previewSectionAction("guest",{kind:"delete",sectionSlug:slug,
      reason:"Пользователь хочет удалить"})).rejects.toThrow("section_delete_protected_or_missing");
  const proposal=await previewSectionAction("guest",{kind:"delete",sectionSlug:move.slug,
    reason:"Пользователь хочет удалить"});
  await repo.moveCollection(move.id,standard.id);
  await expect(confirmSectionAction("guest",proposal)).rejects.toThrow("stale_collection");
  mockUnlocked=false;
  await expect(previewSectionAction("guest",{kind:"delete",sectionSlug:move.slug,
    reason:"Пользователь хочет удалить"})).rejects.toThrow("application_locked");
});
