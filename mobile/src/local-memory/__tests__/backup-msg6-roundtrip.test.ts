/**
 * MSG-6 backup regression: execute the production RESTORE path against actual
 * SQLite v18 tables and bytes, not a SQL-string mock.
 *
 * The fixture is a local plaintext SQLite *test double* for an already decrypted
 * SQLCipher archive. Expo file copy and ATTACH KEY transport are mocked; this
 * test proves SQL row/byte/undo/search fidelity, NOT encryption, SAF permissions,
 * real-device SQLCipher export, or a full native backup->restore drill.
 */
import * as Crypto from "expo-crypto";
import * as FS from "expo-file-system/legacy";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, withLocalMemoryDatabase } from "../storage";
import { SqliteMemoryRepository } from "../repository";
import { restoreEncryptedBackup } from "../backup";

let mockSequence = 0;
jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "msg6-fixture-" + (++mockSequence)),
  getRandomBytes: jest.fn(() => new Uint8Array(32)),
}));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///test-cache/", copyAsync: jest.fn(),
  deleteAsync: jest.fn(), getInfoAsync: jest.fn(),
  getFreeDiskStorageAsync: jest.fn(),
}));
jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn(), shareAsync: jest.fn(),
}));
let mockActiveDb: SqliteAdapter;
jest.mock("../storage", () => ({
  ...jest.requireActual("../storage"),
  withLocalMemoryDatabase: jest.fn(async (_id: string, action: (db: unknown) => Promise<unknown>) =>
    action(mockActiveDb)),
}));

/** Only the native encryption/URI attach transport is substituted. All SQL
 * integrity queries, row copies, transactions and FTS work in SQLite itself. */
class SqliteAdapter {
  readonly db: DatabaseSync;
  readonly archivePath: string;
  constructor(db: DatabaseSync, archivePath = "") {
    this.db = db; this.archivePath = archivePath;
  }
  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    if (sql === "ATTACH DATABASE ? AS pia_import KEY ?") {
      if (!this.archivePath) throw new Error("no_archive_fixture");
      this.db.prepare("ATTACH DATABASE ? AS pia_import").run(this.archivePath);
      return { changes: 0 };
    }
    const done = this.db.prepare(sql).run(...(params as any[]));
    return { changes: Number(done.changes) };
  }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...(params as any[])) as T) ?? null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as any[])) as T[];
  }
}

const recoveryCode = "ab".repeat(32);
const observedText = "Снимок текста Telegram о спутниках для заметки";
const observedSha = createHash("sha256").update(observedText).digest("hex");
const bytes = Buffer.from([0x00, 0xff, 0x12, 0x87, 0x42, 0x00, 0x34]);
const partSha = createHash("sha256").update(bytes).digest("hex");
const issuedAt = "2026-11-08T08:00:00.000Z";
const importFingerprint = "msg6-backup-share-fingerprint-42";
type Snapshot = { primaryId: string; sourceId: string; sectionId: string;
  undoToken: string; archiveMainPayload: string; sourcePayload: string };
let directory = "", archivePath = "", destination: DatabaseSync | null = null;
let saved: Snapshot;

/** A v18 fixture with the same encrypted-manifest columns/counts used by
 * shareEncryptedBackup. The test itself does not assert SQLCipher encryption. */
function writeCurrentManifest(db: DatabaseSync) {
  const tables: Record<string, string> = {
    entities:"memory_entities", collections:"memory_collections",
    observations:"memory_observations", attachments:"memory_attachments",
    attachment_parts:"memory_attachment_parts", receipts:"memory_received_shares",
    chats:"direct_conversations", temporal_claims:"memory_temporal_claims",
    temporal_evidence:"memory_temporal_evidence",
    temporal_proposals:"memory_temporal_proposals",
    temporal_decisions:"memory_temporal_decisions",
    relation_links:"memory_relations", relation_evidence:"memory_relation_evidence",
    review_actions:"memory_review_actions", review_proposals:"memory_review_proposals",
    profile_self_binding:"memory_profile_self",
  };
  const fields = ["format_version","schema_version",...Object.keys(tables)];
  db.exec("CREATE TABLE persai_backup_manifest (" +
    fields.map(field=>field + " INTEGER NOT NULL").join(",") + ")");
  const counts = Object.values(tables).map(table =>
    Number((db.prepare("SELECT count(*) AS n FROM " + table).get() as {n:number}).n));
  db.prepare("INSERT INTO persai_backup_manifest (" + fields.join(",") +
    ") VALUES (" + fields.map(()=>"?").join(",") + ")").run(8,18,...counts);
}

beforeEach(async () => {
  mockSequence=0;
  directory=mkdtempSync(join(tmpdir(),"persai-msg6-restore-"));
  archivePath=join(directory,"msg6-fixture.db");
  const archive = new DatabaseSync(archivePath);
  archive.exec(SCHEMA_SQL);
  archive.exec("PRAGMA foreign_keys=ON; PRAGMA user_version=18");
  try {
    const original = new SqliteAdapter(archive);
    const repo = new SqliteMemoryRepository(original as never);
    const col = await repo.createCollection({name:"Входящие",slug:"inbox",sensitivity:"standard"});
    const primary = await repo.createEntity({
      collection_id:col.id,domain:"notes",title:"Обзор из разных источников",
      payload:{body:"Первый материал о космосе",tags:["обзор"]},
    });
    const source = await repo.createEntity({
      collection_id:col.id,domain:"notes",title:"Пост Telegram",
      payload:{body:observedText,tags:["космос"],
        source_url:"https://t.me/public_news/42",
        source_text_coverage:"telegram_post_text_only",
        source_observation:{messageKey:"public_news/42",textSha256:observedSha,
          textLength:observedText.length,evidence:"telegram_html_data_post_v1"}},
      source_ref:"android-share",
    });
    await original.runAsync(
      "INSERT INTO memory_received_shares(fingerprint,entity_id) VALUES (?,?)",
      [importFingerprint,source.id]);
    await original.runAsync(
      "INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
      ["original-pdf-msg6",source.id,"OriginalTelegramDocument.pdf","application/pdf",bytes.length,issuedAt]);
    await original.runAsync(
      "INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
      ["original-pdf-msg6",0,bytes,partSha]);
    const undoToken=await repo.changeNotes("merge",[primary,source]);
    saved={
      primaryId:primary.id,sourceId:source.id,sectionId:col.id,undoToken,
      archiveMainPayload:(archive.prepare("SELECT payload_json FROM memory_entities WHERE id=?")
        .get(primary.id) as {payload_json:string}).payload_json,
      sourcePayload:(archive.prepare("SELECT payload_json FROM memory_entities WHERE id=?")
        .get(source.id) as {payload_json:string}).payload_json,
    };
    // An extraction is user-owned evidence associated with the original, not
    // a derived search chunk; it must survive the exact same restored byte owner.
    await original.runAsync(
      "INSERT INTO memory_extractions(id,attachment_id,source_version,producer_kind,producer_id," +
      "producer_revision,language,coverage,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ["pdf-run-msg6","original-pdf-msg6",partSha,"pdf","pdf-reader","1","ru","partial","complete",issuedAt]);
    await original.runAsync(
      "INSERT INTO memory_extraction_segments(id,extraction_id,ord,text,location_kind,page) VALUES (?,?,?,?,?,?)",
      ["pdf-seg-msg6","pdf-run-msg6",0,"Подтверждённый фрагмент PDF","page",1]);
    archive.exec("PRAGMA foreign_key_check");
    writeCurrentManifest(archive);
  } finally {
    archive.close();
  }
  destination = new DatabaseSync(":memory:");
  destination.exec(SCHEMA_SQL);
  destination.exec("PRAGMA foreign_keys=ON");
  mockActiveDb=new SqliteAdapter(destination,archivePath);
  (FS.getFreeDiskStorageAsync as jest.Mock).mockResolvedValue(8*1024*1024*1024);
  (FS.getInfoAsync as jest.Mock).mockResolvedValue({exists:true,isDirectory:false,size:4096});
  (FS.copyAsync as jest.Mock).mockResolvedValue(undefined);
  (FS.deleteAsync as jest.Mock).mockResolvedValue(undefined);
});

afterEach(()=>{
  destination?.close(); destination=null;
  if(directory) rmSync(directory,{recursive:true,force:true});
  directory=""; archivePath="";
  jest.clearAllMocks();
});

test("MSG-6/BKP: real v18 SQL restore preserves Share, merged source, tags, binary parts and evidence; Undo works",async()=>{
  const result=await restoreEncryptedBackup("guest","file:///synthetic-archive.db",recoveryCode);
  expect(result).toEqual({collections:1,entities:2,observations:0});
  expect(withLocalMemoryDatabase).toHaveBeenCalledTimes(1);
  const main=destination!;
  const get=(query:string,...params:unknown[])=>main.prepare(query).get(...(params as any[]));
  const merged=get("SELECT payload_json,record_status FROM memory_entities WHERE id=?",saved.primaryId) as
    {payload_json:string;record_status:string};
  const hidden=get("SELECT payload_json,record_status FROM memory_entities WHERE id=?",saved.sourceId) as
    {payload_json:string;record_status:string};
  expect(merged.record_status).toBe("active");
  expect(hidden.record_status).toBe("superseded");
  expect(merged.payload_json).toBe(saved.archiveMainPayload);
  expect(hidden.payload_json).toBe(saved.sourcePayload);
  const mergedJson=JSON.parse(merged.payload_json);
  expect(mergedJson.tags).toEqual(["космос","обзор"]);
  expect(JSON.stringify(mergedJson.merged_sources)).toContain("https://t.me/public_news/42");
  expect(JSON.stringify(mergedJson.merged_sources)).toContain(observedSha);
  expect(JSON.stringify(mergedJson.merged_sources)).toContain("original-pdf-msg6");
  expect((get("SELECT entity_id FROM memory_received_shares WHERE fingerprint=?",
    importFingerprint) as {entity_id:string}).entity_id).toBe(saved.primaryId);
  const original=get("SELECT entity_id,name FROM memory_attachments WHERE id='original-pdf-msg6'") as
    {entity_id:string;name:string};
  expect(original).toEqual({entity_id:saved.primaryId,name:"OriginalTelegramDocument.pdf"});
  const restoredPart=get("SELECT bytes,sha256 FROM memory_attachment_parts WHERE attachment_id='original-pdf-msg6'") as
    {bytes:Uint8Array;sha256:string};
  expect(Buffer.from(restoredPart.bytes)).toEqual(bytes);
  expect(restoredPart.sha256).toBe(partSha);
  expect((get("SELECT text,page FROM memory_extraction_segments WHERE id='pdf-seg-msg6'") as
    {text:string;page:number})).toEqual({text:"Подтверждённый фрагмент PDF",page:1});
  const repo=new SqliteMemoryRepository(mockActiveDb as never);
  expect((await repo.searchNotes("",50,0,{tag:"космос"})).map(row=>row.id)).toContain(saved.primaryId);
  expect((await repo.searchNotes("OriginalTelegramDocument")).map(row=>row.id))
    .toContain(saved.primaryId);
  // Extracted PDF segments have their own existing FTS projection, not the
  // note title/body FTS. The restore INSERT trigger must rebuild that index.
  // That existing FTS index normalizes Russian ё to е before matching.
  const extractedHits=main.prepare(
    "SELECT segment_id FROM memory_extraction_fts WHERE body MATCH 'Подтвержденный'").all();
  expect(extractedHits).toEqual([{segment_id:"pdf-seg-msg6"}]);
  await repo.undoNotes(saved.undoToken);
  const restoredSource=await repo.entity(saved.sourceId);
  expect(restoredSource?.record_status).toBe("active");
  expect(restoredSource?.payload.source_url).toBe("https://t.me/public_news/42");
  expect((restoredSource?.payload.source_observation as {textSha256:string}).textSha256).toBe(observedSha);
  expect((get("SELECT entity_id FROM memory_received_shares WHERE fingerprint=?",
    importFingerprint) as {entity_id:string}).entity_id).toBe(saved.sourceId);
  expect((get("SELECT entity_id FROM memory_attachments WHERE id='original-pdf-msg6'") as
    {entity_id:string}).entity_id).toBe(saved.sourceId);
  expect((await repo.searchNotes("OriginalTelegramDocument")).map(row=>row.id))
    .toEqual([saved.sourceId]);
  expect((await repo.searchNotes("",50,0,{tag:"космос"})).map(row=>row.id))
    .toEqual([saved.sourceId]);
  expect((main.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
});

test("MSG-6/BKP: a corrupted Share owner aborts before inserting memory",async()=>{
  // A damaged source can have matching manifest row counts, but cannot pass
  // SQLite foreign key integrity. Neither note nor original may be restored.
  const corrupt = new DatabaseSync(archivePath);
  corrupt.exec("PRAGMA foreign_keys=OFF");
  corrupt.prepare("UPDATE memory_received_shares SET entity_id=? WHERE fingerprint=?")
    .run("missing-entity-id",importFingerprint);
  corrupt.close();
  await expect(restoreEncryptedBackup("guest","file:///synthetic-bad.db",recoveryCode))
    .rejects.toThrow("invalid_backup_references");
  expect((destination!.prepare("SELECT count(*) AS n FROM memory_entities").get() as {n:number}).n)
    .toBe(0);
  expect((destination!.prepare("SELECT count(*) AS n FROM memory_attachments").get() as {n:number}).n)
    .toBe(0);
  expect((destination!.prepare("SELECT count(*) AS n FROM memory_received_shares").get() as {n:number}).n)
    .toBe(0);
});