/** ARCH-6c: canonical collection operations, no second SQL writer.
 * All transactions remain on the same unlocked SQLCipher connection. */
import type { CollectionRecord } from "../types";
import { MemoryAccessError, MemoryConflictError } from "../types";
import { withUnlockedTransaction } from "../transaction";
import { now, uid, TEXT, type SQL, type Row } from "./shared";

export async function collectionNoteCounts(db: SQL): Promise<Record<string, number>> {
    const rows = await db.getAllAsync<{ collection_id: string; total: number }>("SELECT collection_id, COUNT(*) AS total FROM memory_entities WHERE record_status='active' GROUP BY collection_id");
    return Object.fromEntries(rows.map(row => [row.collection_id, row.total]));
  }
export async function listCollections(db: SQL): Promise<CollectionRecord[]> {
    const rows = await db.getAllAsync<Row>(
      "SELECT * FROM memory_collections ORDER BY created_at, id",
    );
    return rows.map(r => ({
      id: String(r.id), name: String(r.name), slug: String(r.slug),
      description: TEXT(r.description), parent_id: TEXT(r.parent_id),
      sensitivity: r.sensitivity as CollectionRecord["sensitivity"],
      created_at: String(r.created_at),
    }));
  }

export async function createCollection(db: SQL, item: { name: string; slug: string; sensitivity?: CollectionRecord["sensitivity"]; parentId?: string | null }): Promise<CollectionRecord> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.slug)) throw new Error("invalid_collection_slug");
    if (!item.name.trim()) throw new Error("invalid_collection_name");
    let result!: CollectionRecord;
    await withUnlockedTransaction(db, async tx => {
      const found = await tx.getFirstAsync<Row>("SELECT id FROM memory_collections WHERE slug=?", [item.slug]);
      if (found) throw new MemoryConflictError("collection_exists");
      const parentId = item.parentId ?? null;
      const parent = parentId ? await tx.getFirstAsync<Row>("SELECT id,sensitivity FROM memory_collections WHERE id=?", [parentId]) : null;
      if (parentId && !parent) throw new MemoryAccessError("collection_parent_not_found");
      const sensitivity = item.sensitivity ?? (parent ? parent.sensitivity as CollectionRecord["sensitivity"] : "unclassified");
      // A child cannot silently weaken the protection of its parent.
      if (parent && sensitivity !== parent.sensitivity) throw new MemoryAccessError("collection_parent_sensitivity");
      const siblings=await tx.getAllAsync<Row>(
        parentId===null
          ? "SELECT name FROM memory_collections WHERE parent_id IS NULL"
          : "SELECT name FROM memory_collections WHERE parent_id=?",parentId===null?[]:[parentId]);
      if(siblings.some(row=>String(row.name).trim().toLocaleLowerCase()===item.name.trim().toLocaleLowerCase()))
        throw new MemoryConflictError("collection_sibling_name_exists");
      const record: CollectionRecord = {
        id: uid(), name: item.name.trim(), slug: item.slug, description: null,
        sensitivity, created_at: now(), parent_id: parentId,
      };
      await tx.runAsync(
        "INSERT INTO memory_collections(id,name,slug,description,sensitivity,created_at,parent_id) VALUES (?,?,?,?,?,?,?)",
        [record.id, record.name, record.slug, null, record.sensitivity, record.created_at, parentId],
      );
      result = record;
    });
    return result;
  }

export async function moveCollection(db: SQL, id: string, parentId: string | null): Promise<void> {
    await withUnlockedTransaction(db, async tx => {
      const source = await tx.getFirstAsync<Row>("SELECT id,sensitivity,parent_id FROM memory_collections WHERE id=?", [id]);
      if (!source) throw new MemoryAccessError("collection_not_found");
      const visited = new Set<string>();
      let cursor = parentId;
      while (cursor !== null) {
        if (cursor === id || visited.has(cursor)) throw new MemoryConflictError("collection_cycle");
        visited.add(cursor);
        const ancestor = await tx.getFirstAsync<Row>("SELECT id,parent_id,sensitivity FROM memory_collections WHERE id=?", [cursor]);
        if (!ancestor) throw new MemoryAccessError("collection_parent_not_found");
        if (ancestor.sensitivity !== source.sensitivity) throw new MemoryAccessError("collection_parent_sensitivity");
        cursor = TEXT(ancestor.parent_id);
      }
      if (TEXT(source.parent_id) === parentId) return;
      await tx.runAsync("UPDATE memory_collections SET parent_id=? WHERE id=?", [parentId,id]);
    });
  }

  /** Canonical destructive writer: never cascade through notes, attachments or descendants.
   * The confirmed card's identity, timestamp and parent are checked in the same
   * transaction, so a stale proposal cannot delete a relocated collection. */
export async function deleteEmptyCollection(db: SQL, id: string, expectedCreatedAt: string,
    expectedParentId: string | null): Promise<void> {
    if (typeof id!=="string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(id) ||
        typeof expectedCreatedAt!=="string" || expectedCreatedAt.length>80 ||
        (expectedParentId!==null &&
         (typeof expectedParentId!=="string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(expectedParentId))))
      throw new Error("invalid_collection_delete_request");
    await withUnlockedTransaction(db, async tx => {
      const row=await tx.getFirstAsync<Row>(
        "SELECT id,slug,parent_id,created_at,sensitivity FROM memory_collections WHERE id=?",[id]);
      if (!row || row.created_at!==expectedCreatedAt ||
          TEXT(row.parent_id)!==expectedParentId)
        throw new MemoryConflictError("stale_collection");
      // Built-in sections are foundations, not user-created folders.
      if (row.sensitivity!=="standard" ||
          ["about","people","projects","preferences","dates","documents","notes","inbox"].includes(String(row.slug)))
        throw new MemoryAccessError("collection_delete_protected");
      const visited=new Set<string>([id]);
      let ancestorId=TEXT(row.parent_id);
      while(ancestorId!==null){
        if(visited.has(ancestorId))throw new MemoryConflictError("collection_cycle");
        visited.add(ancestorId);
        const ancestor=await tx.getFirstAsync<Row>(
          "SELECT id,parent_id,slug,sensitivity FROM memory_collections WHERE id=?",[ancestorId]);
        if(!ancestor||ancestor.sensitivity!=="standard"||
           ["documents","inbox"].includes(String(ancestor.slug)))
          throw new MemoryAccessError("collection_delete_protected");
        ancestorId=TEXT(ancestor.parent_id);
      }
      const nested=await tx.getFirstAsync<{n:number}>(
        "SELECT COUNT(*) AS n FROM memory_collections WHERE parent_id=?",[id]);
      const records=await tx.getFirstAsync<{n:number}>(
        "SELECT COUNT(*) AS n FROM memory_entities WHERE collection_id=?",[id]);
      if (!nested || !records || nested.n>0 || records.n>0)
        throw new MemoryConflictError("collection_not_empty");
      const result=await tx.runAsync(
        "DELETE FROM memory_collections WHERE id=? AND created_at=? AND "+
        (expectedParentId===null ? "parent_id IS NULL" : "parent_id=?"),
        expectedParentId===null ? [id,expectedCreatedAt] : [id,expectedCreatedAt,expectedParentId]);
      if (Number(result.changes)!==1) throw new MemoryConflictError("stale_collection");
    });
  }

