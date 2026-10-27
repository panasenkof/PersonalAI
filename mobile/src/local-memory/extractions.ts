/** V9 on-device extraction evidence. These tables are source data, not a
 * disposable vector/FTS index. Every location must be explicitly supplied by
 * an extractor; UNKNOWN is preferred over invented PDF pages or timecodes.
 */
import * as Crypto from "expo-crypto";
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import { withLocalMemoryDatabase } from "./storage";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
const VALID_SHA = /^[0-9a-f]{64}$/;
export type SourceLocation =
  | { kind: "unknown" }
  | { kind: "page"; page: number }
  | { kind: "time"; startMs: number; endMs: number }
  | { kind: "char"; start: number; end: number };
export type ExtractionSegmentInput = { text: string; location: SourceLocation };
export type ExtractionRunInput = {
  attachmentId: string;
  producerKind: "manual" | "text" | "ocr" | "asr" | "vision" | "pdf" | "unknown";
  producerId: string; producerRevision: string;
  status: "complete" | "partial" | "failed";
  coverage: "full" | "partial" | "unknown";
  language?: string | null;
  segments: ExtractionSegmentInput[];
};
export type ExtractionEvidence = {
  extractionId: string; attachmentId: string; sourceVersion: string;
  producerKind: ExtractionRunInput["producerKind"]; producerId: string;
  producerRevision: string; status: ExtractionRunInput["status"];
  coverage: ExtractionRunInput["coverage"]; language: string | null;
  createdAt: string;
  segments: Array<{ id: string; ord: number; text: string; location: SourceLocation }>;
};

type AttachmentRow = { id: string; size: number };
type PartRow = { ord: number; n: number; sha256: string };
/** A source revision over the encrypted part-hash manifest (not a verified
 * full-file digest): safe to compare within the same SQLCipher lease.
 */
export async function fingerprintExtractionSource(db: SQL, attachmentId: string): Promise<string> {
  const attachment = await db.getFirstAsync<AttachmentRow>(
    "SELECT id,size FROM memory_attachments WHERE id=?", [attachmentId]);
  if (!attachment || !Number.isSafeInteger(attachment.size) || attachment.size<=0) {
    throw new Error("extraction_original_missing");
  }
  const parts = await db.getAllAsync<PartRow>(
    "SELECT ord,length(bytes) AS n,sha256 FROM memory_attachment_parts WHERE attachment_id=? ORDER BY ord",
    [attachmentId]);
  if (!parts.length || parts.length>4096) throw new Error("extraction_original_parts_missing");
  let total=0;
  for(let i=0;i<parts.length;i++){
    const p=parts[i];
    if(p.ord!==i || !Number.isSafeInteger(p.n) || p.n<=0 || p.n>256*1024 ||
       !VALID_SHA.test(p.sha256)) throw new Error("extraction_original_parts_invalid");
    total+=p.n;
  }
  if(total!==attachment.size)throw new Error("extraction_original_size_mismatch");
  // SHA-256 over canonical part-hash manifest: a stable immutable SOURCE
  // REVISION, not an independently verified complete-file hash. The existing
  // materializeAttachment() separately rechecks *actual* bytes against parts.
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([attachment.size,parts.map(p=>[p.ord,p.n,p.sha256])]));
}
const validLocation=(loc: SourceLocation): void=>{
  switch(loc?.kind){
    case "unknown": return;
    case "page":
      if(Number.isSafeInteger(loc.page)&&loc.page>0)return;break;
    case "time":
      if(Number.isSafeInteger(loc.startMs)&&Number.isSafeInteger(loc.endMs)&&
         loc.startMs>=0&&loc.endMs>loc.startMs)return;break;
    case "char":
      if(Number.isSafeInteger(loc.start)&&Number.isSafeInteger(loc.end)&&
         loc.start>=0&&loc.end>loc.start)return;break;
  }
  throw new Error("invalid_extraction_location");
};
function checked(input: ExtractionRunInput){
  const validKinds=["manual","text","ocr","asr","vision","pdf","unknown"];
  if(!input.attachmentId || !validKinds.includes(input.producerKind) ||
      !input.producerId?.trim() || input.producerId.length>120 ||
      !input.producerRevision?.trim() || input.producerRevision.length>120 ||
      !["complete","partial","failed"].includes(input.status) ||
      !["full","partial","unknown"].includes(input.coverage) ||
      !Array.isArray(input.segments) || input.segments.length>128 ||
      (input.status==="failed"&&input.segments.length!==0) ||
      (input.status==="complete"&&input.segments.length===0) ||
      (input.status==="failed"&&input.coverage!=="unknown") ||
      (input.language!=null && (input.language.length>32 || !/^[a-zA-Z0-9-]+$/.test(input.language)))) {
    throw new Error("invalid_extraction_metadata");
  }
  for(const segment of input.segments){
    if(typeof segment.text!=="string" || !segment.text.trim() ||
       segment.text.length>6000)throw new Error("invalid_extraction_segment");
    validLocation(segment.location);
  }
}
/** Complete transaction: no orphan runs, no synthetic coordinates, no
 * overwriting previous attempts. Source attachments must already be saved.
 */
/** Call only within an already-open SQLCipher BEGIN IMMEDIATE transaction,
 * e.g. while saving original + note + receipt together. */
export async function appendExtractionInTransaction(db: SQL,input:ExtractionRunInput):Promise<string>{
  checked(input);
  const id=Crypto.randomUUID(), timestamp=new Date().toISOString();
  const revision=await fingerprintExtractionSource(db,input.attachmentId);
    await db.runAsync(
      `INSERT INTO memory_extractions
        (id,attachment_id,source_version,producer_kind,producer_id,producer_revision,language,coverage,status,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [id,input.attachmentId,revision,input.producerKind,input.producerId.trim(),
       input.producerRevision.trim(),input.language||null,input.coverage,input.status,timestamp]);
    for(let i=0;i<input.segments.length;i++){
      const segment=input.segments[i],loc=segment.location;
      await db.runAsync(
        `INSERT INTO memory_extraction_segments
         (id,extraction_id,ord,text,location_kind,page,start_ms,end_ms,char_start,char_end)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        [Crypto.randomUUID(),id,i,segment.text,loc.kind,
         loc.kind==="page"?loc.page:null,loc.kind==="time"?loc.startMs:null,
         loc.kind==="time"?loc.endMs:null,loc.kind==="char"?loc.start:null,
         loc.kind==="char"?loc.end:null]);
    }
  return id;
}
/** Atomic standalone call for a source already committed to the profile. */
export async function saveExtractionRun(db:SQL,input:ExtractionRunInput):Promise<string>{
  let id="";
  await withUnlockedTransaction(db,async tx=>{id=await appendExtractionInTransaction(tx,input);});
  return id;
}
/** Read-only, explicit attachment + entity scope. No mass export and no
 * automatic disclosure to the cloud assistant or another signed-in profile.
 */
export async function extractionEvidence(db: SQL, entityId: string, attachmentId: string, limit=20): Promise<ExtractionEvidence[]> {
  const cap=Math.max(1,Math.min(50,Math.trunc(limit)||20));
  const owner=await db.getFirstAsync<{id:string}>(
    "SELECT id FROM memory_attachments WHERE id=? AND entity_id=?", [attachmentId,entityId]);
  if(!owner)return [];
  const rows=await db.getAllAsync<{
    id:string;attachment_id:string;source_version:string;producer_kind:ExtractionRunInput["producerKind"];
    producer_id:string;producer_revision:string;language:string|null;
    coverage:ExtractionRunInput["coverage"];status:ExtractionRunInput["status"];created_at:string;
  }>("SELECT * FROM memory_extractions WHERE attachment_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
    [attachmentId,cap]);
  const actual=rows.length?await fingerprintExtractionSource(db,attachmentId):null;
  const out:ExtractionEvidence[]=[];
  for(const row of rows){
    // Version mismatches do not become evidence of current original bytes.
    if(row.source_version!==actual)continue;
    const segments=await db.getAllAsync<{
      id:string;ord:number;text:string;location_kind:SourceLocation["kind"];
      page:number|null;start_ms:number|null;end_ms:number|null;
      char_start:number|null;char_end:number|null;
    }>("SELECT * FROM memory_extraction_segments WHERE extraction_id=? ORDER BY ord LIMIT 129",[row.id]);
    if(segments.length>128)throw new Error("extraction_segments_oversize");
    out.push({
      extractionId:row.id,attachmentId:row.attachment_id,sourceVersion:row.source_version,
      producerKind:row.producer_kind,producerId:row.producer_id,producerRevision:row.producer_revision,
      language:row.language,status:row.status,coverage:row.coverage,createdAt:row.created_at,
      segments:segments.map(s=>({
        id:s.id,ord:s.ord,text:s.text,
        location:s.location_kind==="page"?{kind:"page",page:s.page!}:
          s.location_kind==="time"?{kind:"time",startMs:s.start_ms!,endMs:s.end_ms!}:
          s.location_kind==="char"?{kind:"char",start:s.char_start!,end:s.char_end!}:{kind:"unknown"},
      })),
    });
  }
  return out;
}
export const saveLocalExtractionRun=(profile:string,input:ExtractionRunInput)=>
  withLocalMemoryDatabase(profile,db=>saveExtractionRun(db,input));
export const localExtractionEvidence=(profile:string,entityId:string,attachmentId:string,limit=20)=>
  withLocalMemoryDatabase(profile,db=>extractionEvidence(db,entityId,attachmentId,limit));
