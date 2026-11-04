import type { SQLiteDatabase } from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import type { NoteSelection } from "./note-actions";
import { BULK_PURGE_NEEDS_REVIEW_SQL } from "./bulk-purge-eligibility";

type ReadSql = Pick<SQLiteDatabase, "execAsync" | "getAllAsync" | "getFirstAsync">;
export type TrashPurgeSnapshot = {
  /** Never expose record bodies, titles, file names or source quotes in this inventory. */
  items: NoteSelection[];
  totalCount: number;
  protectedCount: number;
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
    // Notes tied to saved relations, proposed relations or temporal facts
    // require individual review instead of destructive global cleanup.
    const blocked = await tx.getAllAsync<{ id: string }>(
      "SELECT e.id FROM memory_entities e WHERE e.domain='notes' " +
      "AND e.record_status='trashed' AND (" + BULK_PURGE_NEEDS_REVIEW_SQL + ")");
    const blockedIds = new Set(blocked.map(row => row.id));
    const included = rows.filter(row => !blockedIds.has(row.id));
    const includedIds = new Set(included.map(row => row.id));
    const files = await tx.getAllAsync<{ entity_id: string; total: number }>(
      "SELECT a.entity_id,COUNT(*) AS total FROM memory_attachments a " +
      "JOIN memory_entities e ON e.id=a.entity_id " +
      "WHERE e.domain='notes' AND e.record_status='trashed' GROUP BY a.entity_id");
    const relations = await tx.getFirstAsync<{ total: number }>(
      "SELECT COUNT(*) AS total FROM memory_relations r WHERE EXISTS " +
      "(SELECT 1 FROM memory_entities e WHERE e.domain='notes' AND e.record_status='trashed' " +
      "AND (e.id=r.source_entity_id OR e.id=r.target_entity_id))");
    snapshot = {
      items: included.map(row => ({ id: row.id, record_version: row.record_version })),
      totalCount: rows.length,
      protectedCount: blockedIds.size,
      originalCount: files.filter(file => includedIds.has(file.entity_id))
        .reduce((total,file) => total + file.total,0),
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

/** A one-way runner: never searches for new items, never auto-retries a failed
 * transaction. The UI must take a NEW reviewed snapshot after interruption. */
export async function purgeConfirmedTrash(
  items: readonly NoteSelection[],
  writer: (batch: NoteSelection[]) => Promise<void>,
  stillAllowed: () => boolean,
  onProgress?: (count: number) => void,
): Promise<{ total: number; confirmed: number; error: unknown | null }> {
  const batches = trashPurgeBatches(items);
  let confirmed = 0;
  try {
    for (const batch of batches) {
      if (!stillAllowed()) throw new Error("trash_purge_session_changed");
      await writer(batch);
      confirmed += batch.length;
      onProgress?.(confirmed);
    }
    return { total: items.length, confirmed, error: null };
  } catch (error) {
    // An interrupted call might have committed just before the bridge failed:
    // do not claim the current batch succeeded or retry it without inspection.
    return { total: items.length, confirmed, error };
  }
}
