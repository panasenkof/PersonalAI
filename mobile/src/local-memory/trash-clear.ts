import type { SQLiteDatabase } from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import type { NoteSelection } from "./note-actions";

type ReadSql = Pick<SQLiteDatabase, "execAsync" | "getAllAsync" | "getFirstAsync">;
export type TrashPurgeSnapshot = {
  /** Never expose record bodies, titles, file names or source quotes in this inventory. */
  items: NoteSelection[];
  originalCount: number;
  affectedRelationCount: number;
};

/** One frozen set of IDs and CAS versions; no OFFSET pagination against a
 * changing trash and no accidental inclusion of other domains/profiles. */
export async function readTrashPurgeSnapshot(db: ReadSql): Promise<TrashPurgeSnapshot> {
  let snapshot: TrashPurgeSnapshot | null = null;
  await withUnlockedTransaction(db, async tx => {
    const rows = await tx.getAllAsync<{ id: string; record_version: number }>(
      "SELECT id,record_version FROM memory_entities " +
      "WHERE domain='notes' AND record_status='trashed' ORDER BY created_at,id");
    const files = await tx.getFirstAsync<{ total: number }>(
      "SELECT COUNT(*) AS total FROM memory_attachments a " +
      "JOIN memory_entities e ON e.id=a.entity_id " +
      "WHERE e.domain='notes' AND e.record_status='trashed'");
    const relations = await tx.getFirstAsync<{ total: number }>(
      "SELECT COUNT(*) AS total FROM memory_relations r WHERE EXISTS " +
      "(SELECT 1 FROM memory_entities e WHERE e.domain='notes' AND e.record_status='trashed' " +
      "AND (e.id=r.source_entity_id OR e.id=r.target_entity_id))");
    snapshot = {
      items: rows.map(row => ({ id: row.id, record_version: row.record_version })),
      originalCount: files?.total ?? 0,
      affectedRelationCount: relations?.total ?? 0,
    };
  });
  if (!snapshot) throw new Error("trash_preview_missing");
  return snapshot;
}

/** The canonical purgeNotes writer is capped at 100 per transaction.
 * Every chunk is drawn exclusively from the user's confirmed snapshot;
 * do not issue fresh searches or OFFSET while deleting. */
export function trashPurgeBatches(items: readonly NoteSelection[]): NoteSelection[][] {
  if (new Set(items.map(item => item.id)).size !== items.length ||
      items.some(item => typeof item.id !== "string" || !item.id ||
        !Number.isSafeInteger(item.record_version) || item.record_version < 1))
    throw new Error("trash_preview_invalid");
  const batches: NoteSelection[][] = [];
  for (let offset = 0; offset < items.length; offset += 100) {
    batches.push(items.slice(offset, offset + 100).map(item => ({ ...item })));
  }
  return batches;
}

export function trashPurgeCountLabel(n: number): string {
  const mod100 = n % 100, mod10 = n % 10;
  return n + " " + (mod100 >= 11 && mod100 <= 14 ? "записей" :
    mod10 === 1 ? "запись" : mod10 >= 2 && mod10 <= 4 ? "записи" : "записей");
}
