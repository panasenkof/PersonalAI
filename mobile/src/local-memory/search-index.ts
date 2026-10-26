/** Derived search data of a record: its text split into chunks and one row per
 * chunk in `memory_search_fts`. It is always rebuilt from the record, its names
 * and index words, in the same transaction as the change, so search never
 * shows a stale version. Backups carry the records; the index is rebuilt. */
import type * as SQLite from "expo-sqlite";
import { foldText } from "./query";
import { CURRENT_MODEL_TERMS } from "./enrichment-policy";

type SQL = Pick<SQLite.SQLiteDatabase, "getAllAsync" | "getFirstAsync" | "runAsync">;
type Row = Record<string, unknown>;

export const MEMORY_KINDS = ["fact", "person", "event", "preference", "document", "note"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export const isMemoryKind = (value: unknown): value is MemoryKind =>
  typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);

/** A new record's type when none is given, from its section. */
export function defaultKind(sectionSlug: string | null | undefined): MemoryKind {
  switch (sectionSlug) {
    case "people": return "person";
    case "dates": return "event";
    case "preferences": return "preference";
    case "documents": return "document";
    case "about": return "fact";
    default: return "note";
  }
}

/** About a screen of text: big enough to keep a thought whole, small enough
 * that five chunks fit in the model's context. */
export const CHUNK_LIMIT = 700;

/** Paragraphs are kept together up to the limit; a longer paragraph is split
 * at sentence ends, and only a sentence longer than the limit is cut. */
export function chunkText(text: string, limit = CHUNK_LIMIT): string[] {
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= limit) { pieces.push(paragraph); continue; }
    for (const sentence of paragraph.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g) || [paragraph]) {
      for (let i = 0; i < sentence.length; i += limit) pieces.push(sentence.slice(i, i + limit).trim());
    }
  }
  const chunks: string[] = [];
  for (const piece of pieces.filter(Boolean)) {
    const last = chunks.length - 1;
    if (last >= 0 && chunks[last].length + piece.length + 2 <= limit) chunks[last] += "\n\n" + piece;
    else chunks.push(piece);
  }
  return chunks;
}

/** Change detection only (FNV-1a, 32 bits, plus the length); not a security hash. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0") + ":" + text.length.toString(16);
}

/** «  Маша  Петрова » → «маша петрова»; «ё» counts as «е». */
export const normalizeAlias = (alias: string): string =>
  foldText(alias.normalize("NFC")).toLowerCase().replace(/\s+/g, " ").trim();

const chunkId = (entityId: string, ord: number) => entityId + ":" + ord;

/** Both user notes and extracted file content participate in retrieval. */
export function memoryText(payload: Record<string, unknown>): string {
  return [payload.body, payload.extracted_text, typeof payload.source_url === "string" ? "Источник: " + payload.source_url : ""].filter((v): v is string => typeof v === "string" && Boolean(v.trim())).join("\n\n");
}

/** Rebuilds the chunks and search rows of one record. Vectors of chunks whose
 * text changed are dropped (memory_vectors cascades) and rebuilt later. */
export async function indexEntity(db: SQL, entityId: string, timestamp = new Date().toISOString()): Promise<void> {
  const entity = await db.getFirstAsync<Row>("SELECT title, payload_json FROM memory_entities WHERE id=?", [entityId]);
  await db.runAsync("DELETE FROM memory_search_fts WHERE entity_id=?", [entityId]);
  if (!entity) { await db.runAsync("DELETE FROM memory_chunks WHERE entity_id=?", [entityId]); return; }
  let body = "";
  try { const payload = JSON.parse(String(entity.payload_json)); body = memoryText(payload); }
  catch { /* an unreadable payload is still found by its title */ }
  const title = foldText(String(entity.title ?? ""));
  const texts = chunkText(body);
  if (!texts.length) texts.push("");
  const old = new Map((await db.getAllAsync<Row>("SELECT id, content_hash FROM memory_chunks WHERE entity_id=?", [entityId]))
    .map(r => [String(r.id), String(r.content_hash)]));
  for (const [ord, text] of texts.entries()) {
    const id = chunkId(entityId, ord), hash = contentHash(text);
    if (old.get(id) !== hash) {
      if (old.has(id)) await db.runAsync("DELETE FROM memory_chunks WHERE id=?", [id]);
      await db.runAsync("INSERT INTO memory_chunks(id,entity_id,ord,text,content_hash,created_at) VALUES (?,?,?,?,?,?)",
        [id, entityId, ord, text, hash, timestamp]);
    }
    old.delete(id);
  }
  for (const id of old.keys()) await db.runAsync("DELETE FROM memory_chunks WHERE id=?", [id]);
  const terms = (await db.getAllAsync<Row>(
    `SELECT t.terms FROM memory_index_terms t JOIN memory_entities e ON e.id=t.entity_id
     JOIN memory_collections c ON c.id=e.collection_id
     WHERE t.entity_id=? AND (t.source NOT LIKE 'model:%' OR ${CURRENT_MODEL_TERMS}) ORDER BY t.source`, [entityId]))
    .map(r => String(r.terms)).join(" ");
  const aliases = (await db.getAllAsync<Row>("SELECT alias FROM memory_aliases WHERE entity_id=? ORDER BY normalized", [entityId]))
    .map(r => String(r.alias)).join("; ");
  for (const [ord, text] of texts.entries()) {
    await db.runAsync("INSERT INTO memory_search_fts(entity_id,chunk_id,title,body,terms,aliases) VALUES (?,?,?,?,?,?)",
      [entityId, chunkId(entityId, ord), title, foldText(text), foldText(terms), foldText(aliases)]);
  }
}

/** Indexes every record: the v3 upgrade and a restored backup. */
export async function reindexAll(db: SQL): Promise<number> {
  const rows = await db.getAllAsync<Row>("SELECT id FROM memory_entities ORDER BY created_at, id");
  const timestamp = new Date().toISOString();
  for (const row of rows) await indexEntity(db, String(row.id), timestamp);
  return rows.length;
}
