/**
 * №60б/45.1/77.1: provenance-aware, *scoped* source retrieval for the agent.
 * This is not cross-corpus OCR search. First find a permitted note, then list
 * the attached extraction segments, then read only the requested source.
 * Sensitive/unclassified sections NEVER enter an external model tool.
 */
import type * as SQLite from "expo-sqlite";
import { withLocalMemoryDatabase } from "./storage";
import { fingerprintExtractionSource } from "./extractions";
import { withUnlockedTransaction } from "./transaction";
import type { SourceLocation } from "./extractions";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync" | "getAllAsync" | "runAsync" | "execAsync">;
type Row = Record<string, unknown>;
const MAX_IDS = 128;
const checkedId = (id: string): string => {
  if (typeof id !== "string" || !id || id.length > MAX_IDS || /[\u0000-\u001f]/.test(id))
    throw new Error("invalid_source_id");
  return id;
};
const checkedVersion = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 1) throw new Error("invalid_source_version");
  return v;
};
const location = (row: Row): SourceLocation => {
  switch (row.location_kind) {
    case "page": return { kind: "page", page: Number(row.page) };
    case "time": return { kind: "time", startMs: Number(row.start_ms), endMs: Number(row.end_ms) };
    case "char": return { kind: "char", start: Number(row.char_start), end: Number(row.char_end) };
    default: return { kind: "unknown" };
  }
};

/** This check is mandatory even for an ID supplied by a previous tool output:
 * status, domain, record version AND BOTH record & collection sensitivity.
 */
async function requireAllowed(db: SQL, recordId: string, version: number): Promise<void> {
  const authorized = await db.getFirstAsync<{ id: string }>(
    `SELECT e.id FROM memory_entities e
       JOIN memory_collections c ON c.id=e.collection_id
      WHERE e.id=? AND e.record_version=? AND e.domain='notes'
        AND e.record_status='active' AND e.sensitivity IN ('standard','inherit')
        AND c.sensitivity='standard'`,
    [recordId, version]);
  if (!authorized) throw new Error("memory_source_not_available_or_stale");
}
const evidenceLocation = (row: Row) => ({
  location: location(row),
  locationConfidence: "producer_reported" as const,
  sourceCheck: "part_manifest_revision" as const,
});

/** Returns ONLY metadata and tiny previews. Source version is recomputed from
 * the saved original's encrypted part manifest, and mismatches are excluded.
 * The fixed SQL cap prevents a badly reprocessed note monopolizing the UI.
 */
export async function listApprovedSourceSegments(
  db: SQL, recordId: string, version: number, limit = 15,
) {
  checkedId(recordId); checkedVersion(version);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error("invalid_source_list_limit");
  let result: Record<string, unknown> = {};
  await withUnlockedTransaction(db, async tx => {
    await requireAllowed(tx, recordId, version);
    const cap = 150;
    const rows = await tx.getAllAsync<Row>(
      `SELECT a.id AS attachment_id,a.name AS attachment_name,a.mime AS attachment_mime,
              r.id AS extraction_id,r.source_version,r.producer_kind,r.producer_id,
              r.producer_revision,r.status,r.coverage,r.created_at,
              s.id AS segment_id,s.ord,s.location_kind,s.page,s.start_ms,s.end_ms,
              s.char_start,s.char_end,substr(s.text,1,220) AS preview,
              length(s.text) AS total_chars
         FROM memory_extraction_segments s
         JOIN memory_extractions r ON r.id=s.extraction_id
         JOIN memory_attachments a ON a.id=r.attachment_id
        WHERE a.entity_id=? AND r.status IN ('complete','partial')
        ORDER BY r.created_at DESC,r.id DESC,s.ord ASC LIMIT ?`,
      [recordId, cap + 1]);
    const matched: Record<string, unknown>[] = [];
    const current = new Map<string, string | null>();
    for (const row of rows) {
      const attachmentId = String(row.attachment_id);
      if (!current.has(attachmentId)) {
        const version = await fingerprintExtractionSource(tx, attachmentId).catch(() => null);
        current.set(attachmentId, version);
      }
      if (current.get(attachmentId) !== row.source_version) continue;
      matched.push({
        attachmentId, attachmentName: String(row.attachment_name).slice(0, 240),
        mime: String(row.attachment_mime), extractionId: String(row.extraction_id),
        segmentId: String(row.segment_id), sourceVersion: String(row.source_version),
        producerKind: String(row.producer_kind), producerId: String(row.producer_id),
        producerRevision: String(row.producer_revision), status: String(row.status),
        coverage: String(row.coverage), ordinal: Number(row.ord),
        preview: String(row.preview), totalChars: Number(row.total_chars),
        ...evidenceLocation(row),
      });
      if (matched.length > limit) break;
    }
    result = {
      recordId, recordVersion: version,
      segments: matched.slice(0, limit),
      hasMore: matched.length > limit || rows.length > cap,
      metadataOnly: true, scope: "standard_active_notes",
      // Do not claim exhaustive coverage if historical attempts exceed cap.
      scanLimit: cap,
    };
  });
  return result;
}

/** Exact source read: note-version + attachment + run + segment must ALL agree.
 * Re-verifies original manifest immediately before the bounded text is returned.
 */
export async function readApprovedSourceSegment(
  db: SQL, recordId: string, version: number,
  attachmentId: string, extractionId: string, segmentId: string,
  offset = 0, budget = 3000,
) {
  [recordId, attachmentId, extractionId, segmentId].forEach(checkedId);
  checkedVersion(version);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 6000 ||
      !Number.isSafeInteger(budget) || budget < 1 || budget > 4000)
    throw new Error("invalid_source_read_range");
  let result: Record<string, unknown> | null = null;
  await withUnlockedTransaction(db, async tx => {
    await requireAllowed(tx, recordId, version);
    const row = await tx.getFirstAsync<Row>(
      `SELECT a.id AS attachment_id,a.name AS attachment_name,a.mime AS attachment_mime,
              r.id AS extraction_id,r.source_version,r.producer_kind,r.producer_id,
              r.producer_revision,r.status,r.coverage,s.id AS segment_id,s.text,
              s.location_kind,s.page,s.start_ms,s.end_ms,s.char_start,s.char_end
         FROM memory_extraction_segments s
         JOIN memory_extractions r ON r.id=s.extraction_id
         JOIN memory_attachments a ON a.id=r.attachment_id
        WHERE a.entity_id=? AND a.id=? AND r.id=? AND s.id=?
          AND r.status IN ('complete','partial') LIMIT 1`,
      [recordId, attachmentId, extractionId, segmentId]);
    if (!row) throw new Error("source_segment_not_found");
    const actual = await fingerprintExtractionSource(tx, attachmentId);
    if (actual !== row.source_version) throw new Error("stale_extraction_source_version");
    const text = String(row.text);
    if (offset > text.length) throw new Error("invalid_source_read_range");
    const excerpt = text.slice(offset, offset + budget);
    const next = offset + excerpt.length;
    result = {
      recordId, recordVersion: version,
      attachmentId, attachmentName: String(row.attachment_name).slice(0, 240),
      extractionId, segmentId, sourceVersion: actual,
      producerKind: String(row.producer_kind), producerId: String(row.producer_id),
      producerRevision: String(row.producer_revision),
      status: String(row.status), coverage: String(row.coverage),
      content: excerpt, offset, totalChars: text.length,
      hasMore: next < text.length, ...(next < text.length ? { nextOffset: next } : {}),
      ...evidenceLocation(row),
    };
  });
  return result!;
}

export const listLocalApprovedSourceSegments = (
  profile: string, recordId: string, version: number, limit = 15,
) => withLocalMemoryDatabase(profile, db => listApprovedSourceSegments(db, recordId, version, limit));
export const readLocalApprovedSourceSegment = (
  profile: string, recordId: string, version: number, attachmentId: string,
  extractionId: string, segmentId: string, offset = 0, budget = 3000,
) => withLocalMemoryDatabase(profile, db => readApprovedSourceSegment(
  db, recordId, version, attachmentId, extractionId, segmentId, offset, budget));
