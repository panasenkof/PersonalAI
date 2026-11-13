/** ARCH-6c: existing SQLCipher misc operations.
 * No new connection, transaction, or log: original journal and snapshot
 * validation stay byte-for-byte inside the same repository boundary.
 */
import { listTemporalStateCandidatesAtDate, type TemporalAtDateQuery } from "../temporal-store";
import { withUnlockedTransaction } from "../transaction";
import type { SQL } from "./shared";

export async function temporalCandidatesAtDate(db: SQL, query: TemporalAtDateQuery) {
    let result!: Awaited<ReturnType<typeof listTemporalStateCandidatesAtDate>>;
    await withUnlockedTransaction(db, async tx => {
      result = await listTemporalStateCandidatesAtDate(tx, query);
    });
    return result;
  }

export async function trashNoteCount(db: SQL): Promise<number> {
    const row = await db.getFirstAsync<{ total: number }>(
      "SELECT COUNT(*) AS total FROM memory_entities WHERE domain='notes' AND record_status='trashed'");
    return row?.total ?? 0;
  }
export async function lastNoteOperation(db: SQL): Promise<string> {
    const row = await db.getFirstAsync<{ reason: string; after_json: string }>(
      "SELECT reason,after_json FROM memory_revisions " +
      "WHERE reason LIKE 'notes:%' OR reason LIKE 'Отмена notes:%' " +
      "ORDER BY created_at DESC,rowid DESC LIMIT 1");
    if (!row?.reason.startsWith("notes:")) return "";
    try {
      const latest = JSON.parse(row.after_json) as {
        batch_participants?: unknown; record_version?: unknown;
      };
      const ids = latest.batch_participants;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
          ids.some(id => typeof id !== "string" || !id) ||
          new Set(ids).size !== ids.length) return "";
      // A purge cascades revision rows. An incomplete batch journal is not
      // undoable, even if some other record still has its old revision.
      const journal = await db.getAllAsync<{ after_json: string }>(
        "SELECT after_json FROM memory_revisions WHERE reason=?", [row.reason]);
      if (journal.length !== ids.length) return "";
      const expected = new Map<string, number>();
      for (const revision of journal) {
        const after = JSON.parse(revision.after_json) as {
          id?: unknown; record_version?: unknown;
        };
        if (typeof after.id !== "string" ||
            !Number.isSafeInteger(after.record_version) || expected.has(after.id)) return "";
        expected.set(after.id, Number(after.record_version));
      }
      if (ids.some(id => !expected.has(id))) return "";
      const entities = await db.getAllAsync<{ id: string; record_version: number }>(
        "SELECT id,record_version FROM memory_entities WHERE id IN (" +
        ids.map(() => "?").join(",") + ")", ids);
      // Also protects against a restore/edit after the last operation and
      // against references whose original note has since been hard-purged.
      return entities.length === ids.length &&
        entities.every(entity => expected.get(entity.id) === entity.record_version)
        ? row.reason : "";
    } catch {
      // Malformed/outdated or partially purged history is never offered as Undo.
      return "";
    }
  }

