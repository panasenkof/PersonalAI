/** Cloud-visible *metadata* catalogue. The native SQLCipher lease is owned by
 * the caller; standard active notes only. FTS query is an exact phrase, not
 * an unbounded semantic claim about every matching record. */
import type * as SQLite from "expo-sqlite";
import { ftsPhrase } from "./query";

export type AllowedListOptions = {
  collectionId?: string; query?: string; limit?: number;
  beforeUpdatedAt?: string; beforeId?: string;
};
type Db = Pick<SQLite.SQLiteDatabase, "getAllAsync" | "getFirstAsync">;
type Row = { id: string; record_version: number; title: string | null;
  updated_at: string; collection_name: string };
type Filter = { where: string; params: (string | number)[] };
const MATCH_SQL = "EXISTS (SELECT 1 FROM memory_search_fts WHERE " +
  "memory_search_fts.entity_id=e.id AND memory_search_fts MATCH ?)";

function filters(options: AllowedListOptions, cursor: boolean): Filter {
  if (options.collectionId !== undefined &&
      (!/^[a-z0-9-]{1,128}$/i.test(options.collectionId))) throw new Error("invalid_catalog_collection");
  const term = (options.query || "").trim();
  if (term.length > 200) throw new Error("invalid_catalog_query");
  const where = ["e.record_status='active'", "e.domain='notes'", "c.sensitivity='standard'",
    "e.sensitivity IN ('standard','inherit')"];
  const params: (string | number)[] = [];
  if (options.collectionId) { where.push("e.collection_id=?"); params.push(options.collectionId); }
  if (term) { where.push(MATCH_SQL); params.push(ftsPhrase(term)); }
  if (cursor && (options.beforeUpdatedAt !== undefined || options.beforeId !== undefined)) {
    if (!options.beforeUpdatedAt || !/^\d{4}-\d{2}-\d{2}T/.test(options.beforeUpdatedAt) ||
        options.beforeUpdatedAt.length > 40 || !options.beforeId ||
        options.beforeId.length > 128) throw new Error("invalid_catalog_cursor");
    where.push("(e.updated_at < ? OR (e.updated_at = ? AND e.id < ?))");
    params.push(options.beforeUpdatedAt, options.beforeUpdatedAt, options.beforeId);
  }
  return { where: where.join(" AND "), params };
}
const FROM = "FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id";

/** This count is *exact FTS phrase* and only the permitted scope, never all
 * private or semantically related notes. User-facing metadata says so. */
export async function countAllowedNotes(db: Db, options: Pick<AllowedListOptions, "collectionId" | "query"> = {}) {
  const q = filters(options, false);
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT count(*) AS n " + FROM + " WHERE " + q.where, q.params);
  if (!row || !Number.isSafeInteger(row.n) || row.n < 0) throw new Error("invalid_catalog_count");
  return { count: row.n, scope: "standard_active_notes", matchMode: options.query ? "exact_fts_phrase" : "all_allowed" };
}

export async function listAllowedNotes(db: Db, options: AllowedListOptions = {}) {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid_catalog_limit");
  const q = filters(options, true);
  const rows = await db.getAllAsync<Row>(
    "SELECT e.id,e.record_version,e.title,e.updated_at,c.name AS collection_name " +
    FROM + " WHERE " + q.where + " ORDER BY e.updated_at DESC,e.id DESC LIMIT ?",
    [...q.params, limit + 1],
  );
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    records: visible.map(row => ({ id: row.id, version: row.record_version,
      title: row.title || "", section: row.collection_name, updatedAt: row.updated_at })),
    hasMore: rows.length > limit,
    ...(rows.length > limit && last ? { nextCursor: { beforeUpdatedAt: last.updated_at, beforeId: last.id } } : {}),
    scope: "standard_active_notes",
    matchMode: options.query ? "exact_fts_phrase" : "all_allowed",
    // Never conflate a paged metadata list with a full content read.
    contentIncluded: false,
  };
}
