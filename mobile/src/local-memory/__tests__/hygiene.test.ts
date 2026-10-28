import { MemoryHygieneService } from "../hygiene";
import { SqliteMemoryRepository } from "../repository";
import { authorizeLocalMemorySession, revokeLocalMemorySession, SCHEMA_SQL } from "../storage";
import { MemoryAccessError, MemoryConflictError } from "../types";

jest.mock("expo-crypto", () => ({
  randomUUID: () => require("node:crypto").randomUUID(),
}));
const { DatabaseSync } = require("node:sqlite");

class NativeBridge {
  sqlite = new DatabaseSync(":memory:");
  statements: string[] = [];
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys=ON;");
    this.sqlite.exec(SCHEMA_SQL);
  }
  getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return Promise.resolve((this.sqlite.prepare(sql).get(...params) as T) ?? null);
  }
  getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return Promise.resolve(this.sqlite.prepare(sql).all(...params) as T[]);
  }
  runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return Promise.resolve({ changes: Number(this.sqlite.prepare(sql).run(...params).changes) });
  }
  execAsync(sql: string): Promise<void> {
    this.statements.push(sql);
    this.sqlite.exec(sql);
    return Promise.resolve();
  }
  close() { this.sqlite.close(); }
}
let native: NativeBridge;
let repo: SqliteMemoryRepository;
let review: MemoryHygieneService;

beforeEach(() => {
  authorizeLocalMemorySession();
  native = new NativeBridge();
  repo = new SqliteMemoryRepository(native as never);
  review = repo.hygiene();
});
afterEach(() => { revokeLocalMemorySession(); native.close(); });

async function note(body: string, collectionId?: string) {
  const col = collectionId ?? (await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity:"standard" })).id;
  return repo.createEntity({ collection_id: col, domain: "notes", title: body, payload: { body } });
}

test("persistent keep/pin and defer policies use CAS, do not rewrite source content, and can be reset", async () => {
  const n = await note("Важный документ");
  expect(await review.preference(n.id)).toEqual({
    entityId: n.id, guard: "normal", skipUntil: null, preferenceVersion: 0,
  });
  const pin = await review.setPreference({ id: n.id, recordVersion: 1 }, 0, "pinned", null);
  expect(pin).toMatchObject({ guard: "pinned", preferenceVersion: 1 });
  expect((await review.dryRun([{ id: n.id, recordVersion: 1 }], "archive"))[0])
    .toMatchObject({ eligible: false, reasons: ["pinned"], canPurgeOriginals: false });
  await expect(review.setPreference({ id: n.id, recordVersion: 1 }, 0, "normal", null))
    .rejects.toBeInstanceOf(MemoryConflictError);
  const future = "2099-01-01T00:00:00.000Z";
  await review.setPreference({ id: n.id, recordVersion: 1 }, 1, "normal", future);
  expect((await review.dryRun([{ id: n.id, recordVersion: 1 }], "trash"))[0].reasons).toContain("deferred");
  await review.setPreference({ id: n.id, recordVersion: 1 }, 2, "never_suggest", null);
  expect((await review.dryRun([{ id: n.id, recordVersion: 1 }], "archive"))[0].reasons).toEqual(["never_suggest"]);
  await review.setPreference({ id: n.id, recordVersion: 1 }, 3, "normal", null);
  expect((await review.dryRun([{ id: n.id, recordVersion: 1 }], "archive"))[0]).toMatchObject({
    eligible: true, reasons: [], immediateReclaimableBytes: 0,
  });
  expect(await repo.entity(n.id)).toMatchObject({ payload: { body: "Важный документ" }, record_version: 1 });
  expect(await repo.revisions("entity", n.id)).toHaveLength(0);
});

test("dry-run reports incoming/outgoing graph links, attached bytes, and does not delete any evidence", async () => {
  const col = await repo.createCollection({ name: "Архив", slug: "notes",sensitivity:"standard" });
  const original = await note("Статья", col.id);
  const other = await note("Цитата", col.id);
  await repo.linkEntities(other.id, original.id, "cites");
  native.sqlite.prepare(`INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at)
    VALUES (?,?,?,?,?,?)`).run("file", original.id, "article.pdf", "application/pdf", 1024, "now");
  native.sqlite.prepare("INSERT INTO memory_attachment_parts VALUES ('file',0,X'010203','sha')").run();
  native.sqlite.prepare(`INSERT INTO memory_observations
    (id,entity_id,kind,payload_json,occurred_at,created_at) VALUES (?,?,?,?,?,?)`)
    .run("obs", original.id, "quote", '{"sentence":"source"}', "now", "now");
  const found = await review.dryRun([{ id: original.id, recordVersion: 1 }], "trash");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({
    eligible: true, dependencies: {
      attachments: 1, attachmentBytes: 1024, inboundRelations: 1,
      outboundRelations: 0, observations: 1,
    }, canPurgeOriginals: false, immediateReclaimableBytes: 0,
  });
  expect(found[0].unverifiedDependencies).toContain("future_claim_evidence");
  expect(native.sqlite.prepare("SELECT count(*) AS n FROM memory_attachments").get().n).toBe(1);
  expect((await repo.entity(other.id))?.record_status).toBe("active");
  expect(native.sqlite.prepare("SELECT count(*) AS n FROM memory_relations").get().n).toBe(1);
});

test("changing a record invalidates both policy updates and any stale review", async () => {
  const n = await note("Сначала");
  await repo.reviseEntity(n.id, 1, { body: "Теперь" }, "Правка");
  await expect(review.setPreference({ id: n.id, recordVersion: 1 }, 0, "pinned", null))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect((await review.dryRun([{ id: n.id, recordVersion: 1 }], "trash"))[0].reasons)
    .toContain("stale_record_version");
  expect(await review.preference(n.id)).toMatchObject({ guard: "normal", preferenceVersion: 0 });
});

test("deletion cascades preference only for deleted owner and pin does not affect other notes", async () => {
  const col = await repo.createCollection({ name: "Заметки", slug: "notes",sensitivity:"standard" });
  const n1 = await note("А", col.id), n2 = await note("Б", col.id);
  await review.setPreference({ id: n1.id, recordVersion: 1 }, 0, "never_suggest", null);
  expect((await review.dryRun([
    { id: n1.id, recordVersion: 1 }, { id: n2.id, recordVersion: 1 },
  ], "archive")).map(x => x.eligible)).toEqual([false, true]);
  native.sqlite.prepare("DELETE FROM memory_entities WHERE id=?").run(n1.id);
  expect(native.sqlite.prepare("SELECT count(*) AS n FROM memory_cleanup_preferences").get().n).toBe(0);
  expect((await repo.entity(n2.id))?.title).toBe("Б");
});

test("rejects malformed batch, invalid policy/date, and closed application sessions before reading DB", async () => {
  const n = await note("Обычная запись");
  await expect(review.dryRun([], "archive")).rejects.toThrow("invalid_review_selection");
  await expect(review.dryRun([{ id: n.id, recordVersion: 1 }, { id: n.id, recordVersion: 1 }], "archive"))
    .rejects.toThrow("invalid_review_selection");
  await expect(review.setPreference({ id: n.id, recordVersion: 1 }, 0, "unsafe" as never, null))
    .rejects.toThrow("invalid_review_guard");
  await expect(review.setPreference({ id: n.id, recordVersion: 1 }, 0, "normal", "tomorrow"))
    .rejects.toThrow("invalid_review_skip_until");
  revokeLocalMemorySession();
  await expect(review.preference(n.id)).rejects.toBeInstanceOf(MemoryAccessError);
  await expect(review.dryRun([{ id: n.id, recordVersion: 1 }], "archive"))
    .rejects.toBeInstanceOf(MemoryAccessError);
  await expect(review.setPreference({ id: n.id, recordVersion: 1 }, 0, "pinned", null))
    .rejects.toBeInstanceOf(MemoryAccessError);
});

test("CLEAN-05/CLEAN-07/SAVE-04: review 25 sources with exclusions, guards and read-only byte impact",async()=>{
  const col=await repo.createCollection({name:"Архив для просмотра",slug:"archive-review",sensitivity:"standard"});
  const notes=[];
  for(let i=0;i<25;i++){
    notes.push(await note(i<15?"Видео посмотреть позже "+i:"Сохранённая статья "+i,col.id));
  }
  // Medical and pinned documents remain untouched: the preview records
  // blockers rather than converting age or MIME into an auto-delete decision.
  await review.setPreference({id:notes[3].id,recordVersion:1},0,"pinned",null);
  await review.setPreference({id:notes[4].id,recordVersion:1},0,"never_suggest",null);
  const before=Number(native.sqlite.prepare("SELECT count(*) AS n FROM memory_entities").get().n);
  const excluded=[notes[0].id,notes[1].id,notes[2].id];
  const selection=notes.map(n=>({id:n.id,recordVersion:n.record_version}));
  const preview=await review.previewWithExclusions(selection,excluded,"archive");
  expect(preview.selectedCount).toBe(25);
  expect(preview.excludedIds).toEqual(excluded);
  expect(preview.included.map(x=>x.id)).not.toContain(notes[0].id);
  expect(preview.included).toHaveLength(22);
  expect(preview.blockedIds).toEqual([notes[3].id,notes[4].id]);
  expect(preview.eligibleIds).toHaveLength(20);
  expect(preview.canPurgeOriginals).toBe(false);
  expect(preview.originalBytesAtRisk).toBe(0);
  expect(native.sqlite.prepare("SELECT count(*) AS n FROM memory_entities").get().n).toBe(before);
  expect(native.sqlite.prepare("SELECT count(*) AS n FROM memory_revisions").get().n).toBe(0);
  expect((await repo.entity(notes[3].id))?.record_status).toBe("active");
  expect(native.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("CLEAN-01/CLEAN-04/SEC-04: all excluded is a valid no-op; malformed exclusion fails closed",async()=>{
  const col=await repo.createCollection({name:"Материалы",slug:"review-materials",sensitivity:"standard"});
  const n1=await note("Медицинский документ 2018",col.id),n2=await note("Видео 2021",col.id);
  const targets=[{id:n1.id,recordVersion:1},{id:n2.id,recordVersion:1}];
  const preview=await review.previewWithExclusions(targets,[n2.id,n1.id],"trash");
  expect(preview).toMatchObject({
    action:"trash",selectedCount:2,excludedIds:[n1.id,n2.id],
    included:[],eligibleIds:[],blockedIds:[],originalBytesAtRisk:0,
    canPurgeOriginals:false,
  });
  await expect(review.previewWithExclusions(targets,["unknown"],"trash"))
    .rejects.toThrow("invalid_review_exclusion");
  await expect(review.previewWithExclusions(targets,[n1.id,n1.id],"trash"))
    .rejects.toThrow("invalid_review_selection");
  await expect(review.previewWithExclusions(targets.concat(targets),[],"archive"))
    .rejects.toThrow("invalid_review_selection");
  // A changed source is returned as blocked, never silently auto-accepted.
  await repo.reviseEntity(n1.id,1,{body:"Исправленный медицинский документ"},"Исправление");
  const stale=await review.previewWithExclusions(targets,[],"archive");
  expect(stale.blockedIds).toContain(n1.id);
  expect(stale.included.find(x=>x.id===n1.id)?.reasons).toContain("stale_record_version");
  revokeLocalMemorySession();
  await expect(review.previewWithExclusions(targets,[],"trash"))
    .rejects.toBeInstanceOf(MemoryAccessError);
});

test("CLEAN-04/05/07: confirmed preview applies via existing note writer with exclusions and undo",async()=>{
  const col=await repo.createCollection({name:"Статьи и видео",slug:"read-later",sensitivity:"standard"});
  const keep=await note("Медицинский анализ: сохранить",col.id);
  const pin=await note("Документы о машине",col.id);
  const article=await note("Статья об экологии",col.id);
  const video=await note("Непросмотренное видео",col.id);
  await review.setPreference({id:pin.id,recordVersion:1},0,"pinned",null);
  const all=[keep,pin,article,video].map(n=>({id:n.id,recordVersion:n.record_version}));
  const preview=await review.previewWithExclusions(all,[keep.id],"archive");
  expect(preview.excludedIds).toEqual([keep.id]);
  expect(preview.blockedIds).toEqual([pin.id]);
  expect(preview.eligibleIds).toEqual([article.id,video.id]);
  const allowed=preview.included.filter(row=>row.eligible);
  const token=await repo.changeNotes("archive",allowed.map(row=>({
    id:row.id,record_version:row.expectedRecordVersion,
  })),undefined,{expectedPreferences:allowed.map(row=>({
    id:row.id,preferenceVersion:row.expectedPreferenceVersion,
  }))});
  expect((await repo.entity(keep.id))?.record_status).toBe("active");
  expect((await repo.entity(pin.id))?.record_status).toBe("active");
  expect((await repo.entity(article.id))?.record_status).toBe("archived");
  expect((await repo.entity(video.id))?.record_status).toBe("archived");
  await repo.undoNotes(token);
  expect((await repo.entity(article.id))?.record_status).toBe("active");
  expect((await repo.entity(video.id))?.record_status).toBe("active");
  expect(native.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("CLEAN-08/SEC-06: pinned/deferred/changed/secret after preview rolls back whole batch",async()=>{
  const col=await repo.createCollection({name:"Архив",slug:"safe-review",sensitivity:"standard"});
  const a=await note("Масло автомобиля",col.id),b=await note("Рецепт лазаньи",col.id);
  const targets=[a,b].map(n=>({id:n.id,recordVersion:n.record_version}));
  const getGuard=(p:Awaited<ReturnType<MemoryHygieneService["previewWithExclusions"]>>)=>({
    expectedPreferences:p.included.map(row=>({id:row.id,preferenceVersion:row.expectedPreferenceVersion})),
  });
  const p=await review.previewWithExclusions(targets,[],"trash");
  await review.setPreference({id:b.id,recordVersion:1},0,"pinned",null);
  await expect(repo.changeNotes("trash",[a,b].map(n=>({id:n.id,record_version:1})),undefined,getGuard(p)))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect((await repo.entity(a.id))?.record_status).toBe("active");
  expect((await repo.entity(b.id))?.record_status).toBe("active");
  await review.setPreference({id:b.id,recordVersion:1},1,"normal",null);
  const newPreview=await review.previewWithExclusions(targets,[],"archive");
  native.sqlite.prepare("UPDATE memory_collections SET sensitivity='secret' WHERE id=?").run(col.id);
  await expect(repo.changeNotes("archive",[a,b].map(n=>({id:n.id,record_version:1})),undefined,getGuard(newPreview)))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect((await repo.entity(a.id))?.record_version).toBe(1);
  native.sqlite.prepare("UPDATE memory_collections SET sensitivity='standard' WHERE id=?").run(col.id);
  const now=await review.previewWithExclusions(targets,[],"archive");
  await repo.reviseEntity(b.id,1,{body:"Новая версия рецепта"},"Правка");
  await expect(repo.changeNotes("archive",[a,b].map(n=>({id:n.id,record_version:1})),undefined,getGuard(now)))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect((await repo.entity(a.id))?.record_status).toBe("active");
  expect((await repo.entity(b.id))?.record_status).toBe("active");
  expect(native.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("CLEAN-04/SEC-08: excludes private/unclassified documents and refuses forged reviewed action",async()=>{
  const open=await repo.createCollection({name:"Статьи",slug:"open-articles",sensitivity:"standard"});
  const secret=await repo.createCollection({name:"Личные",slug:"secret-articles",sensitivity:"secret"});
  const a=await note("Старая статья",open.id),b=await note("Заключение врача",secret.id);
  const preview=await review.previewWithExclusions([a,b].map(n=>({id:n.id,recordVersion:1})),[],"trash");
  expect(preview.eligibleIds).toEqual([a.id]);
  expect(preview.included.find(row=>row.id===b.id)?.reasons).toContain("private_or_unclassified");
  await expect(repo.changeNotes("trash",[{id:b.id,record_version:1}],undefined,{
    expectedPreferences:[{id:b.id,preferenceVersion:0}],
  })).rejects.toBeInstanceOf(MemoryConflictError);
  await expect(repo.changeNotes("trash",[{id:a.id,record_version:1}],undefined,{
    expectedPreferences:[],
  })).rejects.toThrow("invalid_hygiene_apply_selection");
  expect((await repo.entity(b.id))?.record_status).toBe("active");
});
