import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { withUnlockedTransaction } from './transaction';
import { indexEntity, memoryText } from './search-index';
import { MemoryConflictError } from './types';

type SQL = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync' | 'execAsync'>;
type Row = Record<string, any>;
export type NoteSelection = { id: string; record_version: number };
export type NoteAction = 'move' | 'trash' | 'restore' | 'merge' | 'archive' | 'unarchive';
export function mergeText(notes: { title: string | null; payload: Record<string, unknown> }[]): string {
  return notes.map(n => `── ${n.title || 'Без названия'} ──\n${memoryText(n.payload)}`).join('\n\n');
}
async function snapshot(db: SQL, id: string): Promise<Row> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM memory_entities WHERE id=?', [id]);
  if (!row) throw new Error('Запись не найдена.');
  return { ...row, attachmentIds: (await db.getAllAsync<{ id: string }>('SELECT id FROM memory_attachments WHERE entity_id=?', [id])).map(a => a.id) };
}
async function write(db: SQL, before: Row, after: Row, reason: string) {
  const timestamp = new Date().toISOString();
  after.record_version = before.record_version + 1; after.updated_at = timestamp;
  await db.runAsync('UPDATE memory_entities SET collection_id=?,payload_json=?,title=?,sensitivity=?,record_status=?,record_version=?,updated_at=? WHERE id=? AND record_version=?',
    [after.collection_id, after.payload_json, after.title, after.sensitivity, after.record_status, after.record_version, timestamp, before.id, before.record_version]);
  await db.runAsync('INSERT INTO memory_revisions(id,record_type,entity_id,observation_id,version,reason,actor_kind,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [Crypto.randomUUID(), 'entity', before.id, null, after.record_version, reason, 'user', JSON.stringify(before), JSON.stringify(after), timestamp]);
  await indexEntity(db, before.id, timestamp);
}
/** One atomic operation; metadata and originals remain recoverable. */
export async function changeNotes(db: SQL, action: NoteAction, selection: NoteSelection[], collectionId?: string): Promise<string> {
  if (!selection.length || selection.length > 100 || new Set(selection.map(n => n.id)).size !== selection.length) throw new Error('Выберите от 1 до 100 разных записей.');
  const batch = 'notes:' + action + ':' + Crypto.randomUUID();
  await withUnlockedTransaction(db, async tx => {
    const rows: Row[] = [];
    for (const selected of selection) {
      const row = await snapshot(tx, selected.id);
      if (row.record_version !== selected.record_version) throw new MemoryConflictError('stale_memory_version');
      if (action === 'restore' ? row.record_status !== 'trashed' : action === 'unarchive' ? row.record_status !== 'archived' : ['merge', 'archive'].includes(action) ? row.record_status !== 'active' : !['active', 'archived'].includes(row.record_status)) throw new Error('Статус записи изменился. Обновите список.');
      rows.push(row);
    }
    if (action === 'move' && (!collectionId || !await tx.getFirstAsync('SELECT id FROM memory_collections WHERE id=?', [collectionId]))) throw new Error('Выберите раздел.');
    const levels = await Promise.all(rows.map(r => tx.getFirstAsync<Row>('SELECT sensitivity FROM memory_collections WHERE id=?', [r.collection_id])));
    const effective = rows.map((r, i) => [r.sensitivity, levels[i]?.sensitivity]);
    const mergedSensitivity = effective.some(v => v.includes('secret') || v.includes('unclassified')) ? 'secret' : effective.some(v => v.includes('sensitive')) ? 'sensitive' : 'standard';
    const combined = action === 'merge' ? mergeText(rows.map(r => ({ title: r.title, payload: JSON.parse(r.payload_json) }))) : '';
    if (action === 'merge' && (rows.length < 2 || combined.length > 60_000)) throw new Error('Для объединения нужны 2–100 записей общим объёмом до 60 000 символов.');
    for (const [i, before] of rows.entries()) {
      const after: Row = { ...before, batch_participants: rows.map(r => r.id) };
      const payload = JSON.parse(before.payload_json);
      if (action === 'trash') { after.record_status = 'trashed'; payload.pre_trash_status = before.record_status; payload.trashed_at = new Date().toISOString(); }
      if (action === 'restore') { after.record_status = payload.pre_trash_status === 'archived' ? 'archived' : 'active'; delete payload.trashed_at; delete payload.pre_trash_status; }
      if (action === 'archive') after.record_status = 'archived';
      if (action === 'unarchive') after.record_status = 'active';
      if (action === 'move') {
        after.collection_id = collectionId;
        if (levels[i]?.sensitivity === 'secret' || levels[i]?.sensitivity === 'unclassified') after.sensitivity = 'secret';
        else if (levels[i]?.sensitivity === 'sensitive' && after.sensitivity !== 'secret') after.sensitivity = 'sensitive';
      }
      if (action === 'merge') {
        if (i === 0) {
          payload.body = combined; payload.extracted_text = '';
          payload.merged_sources = rows.map(r => ({ id: r.id, title: r.title, source_ref: r.source_ref, payload: JSON.parse(r.payload_json), valid_from: r.valid_from, valid_until: r.valid_until }));
          after.sensitivity = mergedSensitivity;
        } else {
          after.record_status = 'superseded'; payload.merged_into = rows[0].id;
          await tx.runAsync('UPDATE memory_attachments SET entity_id=? WHERE entity_id=?', [rows[0].id, before.id]);
        }
      }
      after.payload_json = JSON.stringify(payload);
      await write(tx, before, after, batch);
    }
  });
  return batch;
}
export async function undoNotes(db: SQL, batch: string): Promise<void> {
  if (!/^notes:(move|trash|restore|merge|archive|unarchive):/.test(batch)) throw new Error('Неизвестная операция.');
  await withUnlockedTransaction(db, async tx => {
    const revisions = await tx.getAllAsync<Row>('SELECT before_json,after_json FROM memory_revisions WHERE reason=? ORDER BY created_at,id', [batch]);
    if (!revisions.length) throw new Error('Операция не найдена.');
    const participants = JSON.parse(revisions[0].after_json).batch_participants;
    if (!Array.isArray(participants) || participants.length !== revisions.length) throw new Error('Часть записей удалена навсегда; полная отмена недоступна.');
    // Check every version before touching any row. Later edits must never be lost.
    for (const revision of revisions) {
      const expected = JSON.parse(revision.after_json);
      const current = await snapshot(tx, expected.id);
      if (current.record_version !== expected.record_version) throw new MemoryConflictError('stale_memory_version');
    }
    for (const revision of revisions) {
      const before = JSON.parse(revision.before_json), current = await snapshot(tx, before.id);
      for (const id of before.attachmentIds || []) await tx.runAsync('UPDATE memory_attachments SET entity_id=? WHERE id=?', [before.id, id]);
      await write(tx, current, { ...before }, 'Отмена ' + batch);
    }
  });
}

/** Irreversible, explicit second confirmation in the UI; never operates on active notes. */
export async function purgeNotes(db: SQL, selection: NoteSelection[]): Promise<void> {
  if (!selection.length || selection.length > 100) throw new Error('Выберите от 1 до 100 записей.');
  await withUnlockedTransaction(db, async tx => {
    for (const selected of selection) {
      const current = await snapshot(tx, selected.id);
      if (current.record_version !== selected.record_version || current.record_status !== 'trashed') throw new MemoryConflictError('stale_memory_version');
    }
    for (const selected of selection) {
      await tx.runAsync('DELETE FROM memory_search_fts WHERE entity_id=?', [selected.id]);
      await tx.runAsync('DELETE FROM memory_entities WHERE id=?', [selected.id]);
    }
  });
}

export function noteUndoLabel(token: string): string {
  const labels: Record<string, string> = { move: 'Отменить перенос', trash: 'Отменить удаление', restore: 'Отменить восстановление', merge: 'Отменить объединение', archive: 'Отменить архивирование', unarchive: 'Отменить возврат из архива' };
  return labels[token.split(':')[1]] || 'Отменить операцию с записями';
}
