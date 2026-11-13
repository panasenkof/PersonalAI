import * as Crypto from 'expo-crypto';
import type { SQLiteDatabase } from 'expo-sqlite';
import { withUnlockedTransaction } from './transaction';
import { localMemorySessionUnlocked } from './storage';
import { indexEntity, memoryText } from './search-index';
import { MemoryConflictError } from './types';
import { BULK_PURGE_NEEDS_REVIEW_SQL } from './bulk-purge-eligibility';
import { noteTagsFromPayload, checkedNoteTags, MAX_NOTE_TAGS } from './note-tags';

type SQL = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync' | 'execAsync'>;
type Row = Record<string, any>;
export type NoteSelection = { id: string; record_version: number };
export type NoteAction = 'move' | 'trash' | 'restore' | 'merge' | 'archive' | 'unarchive';
/** 9T2: gate in canonical write transaction, not a new writer. */
export type ChatMoveGuard = {noteId:string;fromCollectionId:string;toCollectionId:string};
/** Optional reviewed-cleanup guard, executed by this SAME canonical writer. */
export type NoteHygieneGuard = { expectedPreferences: Array<{ id:string; preferenceVersion:number }> };
export function mergeText(notes: { title: string | null; payload: Record<string, unknown> }[]): string {
  return notes.map(n => `── ${n.title || 'Без названия'} ──\n${memoryText(n.payload)}`).join('\n\n');
}
async function snapshot(db: SQL, id: string, forMerge = false): Promise<Row> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM memory_entities WHERE id=?', [id]);
  if (!row) throw new Error('Запись не найдена.');
  const attachmentIds = (await db.getAllAsync<{ id: string }>(
    'SELECT id FROM memory_attachments WHERE entity_id=? ORDER BY id', [id])).map(a => a.id);
  if (!forMerge) return { ...row, attachmentIds };
  // The Android Share receipts are canonical user-owned references. Their
  // original mapping joins the SAME versioned revision as moved attachments.
  const shareFingerprints = (await db.getAllAsync<{ fingerprint: string }>(
    'SELECT fingerprint FROM memory_received_shares WHERE entity_id=? ORDER BY fingerprint', [id]))
    .map(r => r.fingerprint);
  return { ...row, attachmentIds, shareFingerprints };
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
export async function changeNotes(db: SQL, action: NoteAction, selection: NoteSelection[], collectionId?: string, hygiene?: NoteHygieneGuard, moveGuard?: ChatMoveGuard): Promise<string> {
  if(moveGuard && (action!=="move" || selection.length!==1 ||
     selection[0].id!==moveGuard.noteId || collectionId!==moveGuard.toCollectionId ||
     moveGuard.fromCollectionId===moveGuard.toCollectionId))
    throw new MemoryConflictError("invalid_confirmed_move");
  if(hygiene){
    if(!['archive','trash'].includes(action) || !Array.isArray(hygiene.expectedPreferences) ||
       hygiene.expectedPreferences.length!==selection.length ||
       new Set(hygiene.expectedPreferences.map(p=>p.id)).size!==selection.length ||
       hygiene.expectedPreferences.some(p=>!selection.some(s=>s.id===p.id) ||
         !Number.isSafeInteger(p.preferenceVersion)||p.preferenceVersion<0))
      throw new Error('invalid_hygiene_apply_selection');
  }
  if (!selection.length || selection.length > 100 || new Set(selection.map(n => n.id)).size !== selection.length) throw new Error('Выберите от 1 до 100 разных записей.');
  const batch = 'notes:' + action + ':' + Crypto.randomUUID();
  await withUnlockedTransaction(db, async tx => {
    if((hygiene || moveGuard) && !localMemorySessionUnlocked())
      throw new MemoryConflictError('application_locked');
    const rows: Row[] = [];
    for (const selected of selection) {
      const row = await snapshot(tx, selected.id, action === 'merge');
      if (row.record_version !== selected.record_version) throw new MemoryConflictError('stale_memory_version');
      if (action === 'restore' ? row.record_status !== 'trashed' : action === 'unarchive' ? row.record_status !== 'archived' : ['merge', 'archive'].includes(action) ? row.record_status !== 'active' : !['active', 'archived'].includes(row.record_status)) throw new Error('Статус записи изменился. Обновите список.');
      rows.push(row);
    }
    if(hygiene){
      // Same BEGIN IMMEDIATE as source writes: a late pin, defer, collection
      // privacy change or record revision invalidates the WHOLE batch.
      for(const row of rows){
        const expected=hygiene.expectedPreferences.find(p=>p.id===row.id)!;
        const guard=await tx.getFirstAsync<{
          version:number|null;guard:string|null;skip_until:string|null;
          record_sensitivity:string;collection_sensitivity:string;
        }>(`SELECT p.version,p.guard,p.skip_until,
              e.sensitivity AS record_sensitivity,c.sensitivity AS collection_sensitivity
            FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id
            LEFT JOIN memory_cleanup_preferences p ON p.entity_id=e.id WHERE e.id=?`,[row.id]);
        if(!guard || (guard.version??0)!==expected.preferenceVersion ||
           guard.guard==='pinned'||guard.guard==='never_suggest' ||
           (guard.skip_until && Date.parse(guard.skip_until)>Date.now()) ||
           guard.collection_sensitivity!=='standard' ||
           !['standard','inherit'].includes(guard.record_sensitivity))
          throw new MemoryConflictError('hygiene_review_changed_repeat_preview');
      }
    }
    if (action === 'move' && (!collectionId || !await tx.getFirstAsync('SELECT id FROM memory_collections WHERE id=?', [collectionId]))) throw new Error('Выберите раздел.');
    if(moveGuard){
      const note=rows[0];
      const sections=await tx.getAllAsync<Row>(
        "SELECT id,sensitivity FROM memory_collections WHERE id IN (?,?)",
        [moveGuard.fromCollectionId,moveGuard.toCollectionId]);
      if(note.id!==moveGuard.noteId || note.domain!=="notes" ||
         note.record_status!=="active" ||
         !["standard","inherit"].includes(note.sensitivity) ||
         note.collection_id!==moveGuard.fromCollectionId ||
         sections.length!==2 || sections.some(row=>row.sensitivity!=="standard") ||
         !sections.some(row=>row.id===moveGuard.fromCollectionId) ||
         !sections.some(row=>row.id===moveGuard.toCollectionId))
        throw new MemoryConflictError("move_review_changed_repeat_preview");
    }
    const levels = await Promise.all(rows.map(r => tx.getFirstAsync<Row>('SELECT sensitivity FROM memory_collections WHERE id=?', [r.collection_id])));
    const effective = rows.map((r, i) => [r.sensitivity, levels[i]?.sensitivity]);
    const mergedSensitivity = effective.some(v => v.includes('secret') || v.includes('unclassified')) ? 'secret' : effective.some(v => v.includes('sensitive')) ? 'sensitive' : 'standard';
    const combined = action === 'merge' ? mergeText(rows.map(r => ({ title: r.title, payload: JSON.parse(r.payload_json) }))) : '';
    if (action === 'merge') {
      if (rows.length < 2 || combined.length > 60_000)
        throw new Error('Для объединения нужны 2–100 записей общим объёмом до 60 000 символов.');
      if (rows.some(r => r.domain !== 'notes'))
        throw new MemoryConflictError('merge_only_notes');
      // A superseded source loses its active search/identity. Never silently
      // strand personal relations, observations, temporal claims or evidence
      // under that now-hidden identity. Remapping those requires independent
      // user review, not automatic merge or an alternative relation writer.
      const hasSourceDependencies = `
        SELECT 1 AS linked FROM memory_entities e WHERE e.id=? AND (
          EXISTS(SELECT 1 FROM memory_observations o WHERE o.entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_aliases a WHERE a.entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_index_terms t WHERE t.entity_id=e.id AND t.source='user')
          OR EXISTS(SELECT 1 FROM memory_cleanup_preferences p
             WHERE p.entity_id=e.id AND p.guard IN ('pinned','never_suggest'))
          OR EXISTS(SELECT 1 FROM memory_relations r WHERE r.source_entity_id=e.id OR r.target_entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_relation_evidence w WHERE w.evidence_entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_review_proposals p
             WHERE p.source_entity_id=e.id OR p.target_entity_id=e.id OR p.evidence_entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_temporal_claims c WHERE c.entity_id=e.id OR c.subject_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_temporal_evidence v WHERE v.entity_id=e.id)
          OR EXISTS(SELECT 1 FROM memory_profile_self x WHERE x.person_id=e.id)
        ) LIMIT 1`;
      for (const source of rows.slice(1)) {
        if (await tx.getFirstAsync(hasSourceDependencies, [source.id]))
          throw new MemoryConflictError('merge_source_has_links_review_required');
      }
      const allTags = [...new Set(rows.flatMap(r =>
        noteTagsFromPayload(JSON.parse(r.payload_json).tags)))].sort();
      if (allTags.length > MAX_NOTE_TAGS)
        throw new MemoryConflictError('merge_too_many_tags_review_required');
    }
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
          // Preserve the true source for every original, even when its
          // attachment owner changes for the merged note. Never manufacture
          // a new source/version/date for Telegram or OCR evidence.
          payload.merged_sources = rows.map(r => ({
            id: r.id, title: r.title, source_kind: r.source_kind,
            source_ref: r.source_ref, collection_id: r.collection_id,
            record_version: r.record_version, attachment_ids: r.attachmentIds,
            payload: JSON.parse(r.payload_json), valid_from: r.valid_from, valid_until: r.valid_until,
          }));
          const tags = [...new Set(rows.flatMap(r =>
            noteTagsFromPayload(JSON.parse(r.payload_json).tags)))].sort();
          if (tags.length) payload.tags = tags;
          else delete payload.tags;
          after.sensitivity = mergedSensitivity;
        } else {
          after.record_status = 'superseded'; payload.merged_into = rows[0].id;
          await tx.runAsync('UPDATE memory_attachments SET entity_id=? WHERE entity_id=?', [rows[0].id, before.id]);
          // Replay of a previously imported Share must open the active merged
          // note; a superseded note is not a readable destination.
          await tx.runAsync('UPDATE memory_received_shares SET entity_id=? WHERE entity_id=?',
            [rows[0].id, before.id]);
        }
      }
      after.payload_json = JSON.stringify(payload);
      if((hygiene || moveGuard) && !localMemorySessionUnlocked())
      throw new MemoryConflictError('application_locked');
      await write(tx, before, after, batch);
    }
    if (action === 'merge') {
      // The first note was indexed before later originals were moved. Index
      // its final attachment filenames/extractions from the committed owner
      // using the existing indexer in this SAME transaction.
      await indexEntity(tx, rows[0].id);
    }
  });
  return batch;
}
/** S9-1c: the SAME SQLCipher snapshot/write/revision/FTS transaction used by
 * changeNotes('move'). No second database writer or undo journal.
 * This function is callable ONLY after the chat card's explicit confirmation.
 * Versions changed after the preview are skipped; ACL/target changes fail closed.
 */
export type InboxTriageWriteRow = {
  noteId: string; expectedVersion: number;
  targetSectionSlug: string; tags: string[];
};
export type InboxTriageWriteReceipt = {
  batch: string; applied: string[]; skipped: string[];
};
export async function applyInboxTriageNotes(
  db: SQL, selected: InboxTriageWriteRow[],
): Promise<InboxTriageWriteReceipt> {
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 10 ||
      new Set(selected.map(row=>row.noteId)).size !== selected.length)
    throw new MemoryConflictError('invalid_inbox_triage_selection');
  for (const row of selected) {
    if (!row || typeof row.noteId !== 'string' ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(row.noteId) ||
        !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 1 ||
        typeof row.targetSectionSlug !== 'string' ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(row.targetSectionSlug) ||
        !Array.isArray(row.tags) || row.tags.length > 5)
      throw new MemoryConflictError('invalid_inbox_triage_item');
    checkedNoteTags(row.tags);
  }
  if (!localMemorySessionUnlocked())
    throw new MemoryConflictError('application_locked');
  const batch='notes:move:'+Crypto.randomUUID();
  const applied: string[]=[];
  const skipped: string[]=[];
  await withUnlockedTransaction(db,async tx=>{
    if (!localMemorySessionUnlocked())
      throw new MemoryConflictError('application_locked');
    const collections=await tx.getAllAsync<{
      id:string;slug:string;sensitivity:string;parent_id:string|null;
    }>('SELECT id,slug,sensitivity,parent_id FROM memory_collections');
    const byId=new Map(collections.map(c=>[c.id,c]));
    const bySlug=new Map(collections.map(c=>[c.slug,c]));
    const inbox=bySlug.get('inbox');
    if (!inbox || inbox.sensitivity!=='sensitive')
      throw new MemoryConflictError('inbox_acl_changed');
    const destinations=new Map<string,string>();
    for (const row of selected) {
      const dest=bySlug.get(row.targetSectionSlug);
      if (!dest || dest.slug==='inbox' || dest.slug==='documents')
        throw new MemoryConflictError('inbox_target_unavailable');
      const seen=new Set<string>();
      let ancestor:typeof dest|undefined=dest;
      while(ancestor){
        if(seen.has(ancestor.id) || ancestor.sensitivity!=='standard' ||
           ancestor.slug==='inbox' || ancestor.slug==='documents')
          throw new MemoryConflictError('inbox_target_acl_changed');
        seen.add(ancestor.id);
        if(ancestor.parent_id && !byId.has(ancestor.parent_id))
          throw new MemoryConflictError('inbox_target_parent_missing');
        ancestor=ancestor.parent_id?byId.get(ancestor.parent_id):undefined;
      }
      destinations.set(row.noteId,dest.id);
    }
    const ready:Array<{before:Row;after:Row}>=[];
    for (const selectedRow of selected) {
      const before=await snapshot(tx,selectedRow.noteId);
      if(before.record_version!==selectedRow.expectedVersion){
        skipped.push(selectedRow.noteId);continue;
      }
      // Never move secret notes, non-note records, trashed/archived notes or
      // a note that moved away from Inbox since the user's preview.
      if(before.domain!=='notes' || before.record_status!=='active' ||
         before.collection_id!==inbox.id ||
         !['inherit','standard','sensitive'].includes(before.sensitivity))
        throw new MemoryConflictError('inbox_note_acl_changed');
      const payload=JSON.parse(before.payload_json);
      const newTags=checkedNoteTags(selectedRow.tags);
      // Preserve the user's existing tags unless they exceed the canonical
      // tag budget. Never silently discard manually assigned labels.
      const merged=[...new Set([...noteTagsFromPayload(payload.tags),...newTags])].sort();
      if(merged.length>MAX_NOTE_TAGS)
        throw new MemoryConflictError('inbox_triage_too_many_tags');
      if(merged.length)payload.tags=merged;
      else delete payload.tags;
      ready.push({before,after:{...before,
        collection_id:destinations.get(selectedRow.noteId),
        sensitivity:'standard',payload_json:JSON.stringify(payload),
      }});
    }
    const participants=ready.map(entry=>entry.before.id);
    for(const entry of ready){
      if(!localMemorySessionUnlocked())
        throw new MemoryConflictError('application_locked');
      await write(tx,entry.before,{
        ...entry.after,batch_participants:participants,
      },batch);
      applied.push(entry.before.id);
    }
  });
  // undoNotes already supports the notes:move batch journal and checks every
  // participant's later record_version in one transaction before replay.
  return {batch,applied,skipped};
}

export async function undoNotes(db: SQL, batch: string, moveGuard?: ChatMoveGuard): Promise<void> {
  if(moveGuard && (!/^notes:move:/.test(batch) ||
      moveGuard.fromCollectionId===moveGuard.toCollectionId))
    throw new MemoryConflictError("invalid_move_undo");
  if (!/^notes:(move|trash|restore|merge|archive|unarchive):/.test(batch)) throw new Error('Неизвестная операция.');
  await withUnlockedTransaction(db, async tx => {
    const revisions = await tx.getAllAsync<Row>('SELECT before_json,after_json FROM memory_revisions WHERE reason=? ORDER BY created_at,id', [batch]);
    if (!revisions.length) throw new Error('Операция не найдена.');
    if(moveGuard){
      if(!localMemorySessionUnlocked() || revisions.length!==1)
        throw new MemoryConflictError("move_undo_locked_or_ambiguous");
      const before=JSON.parse(revisions[0].before_json);
      const after=JSON.parse(revisions[0].after_json);
      const sections=await tx.getAllAsync<Row>(
        "SELECT id,sensitivity FROM memory_collections WHERE id IN (?,?)",
        [moveGuard.fromCollectionId,moveGuard.toCollectionId]);
      if(before.id!==moveGuard.noteId || after.id!==moveGuard.noteId ||
         before.collection_id!==moveGuard.fromCollectionId ||
         after.collection_id!==moveGuard.toCollectionId ||
         before.domain!=="notes" || after.domain!=="notes" ||
         before.record_status!=="active" || after.record_status!=="active" ||
         !["standard","inherit"].includes(before.sensitivity) ||
         !["standard","inherit"].includes(after.sensitivity) ||
         sections.length!==2 || sections.some(row=>row.sensitivity!=="standard"))
        throw new MemoryConflictError("move_undo_review_changed");
    }
    const participants = JSON.parse(revisions[0].after_json).batch_participants;
    if (!Array.isArray(participants) || participants.length !== revisions.length) throw new Error('Часть записей удалена навсегда; полная отмена недоступна.');
    // Check every version before touching any row. Later edits must never be lost.
    for (const revision of revisions) {
      const expected = JSON.parse(revision.after_json);
      const current = await snapshot(tx, expected.id);
      if (current.record_version !== expected.record_version ||
          (moveGuard && (!localMemorySessionUnlocked() || current.collection_id!==moveGuard.toCollectionId ||
            current.record_status!=="active" || !["standard","inherit"].includes(current.sensitivity))))
        throw new MemoryConflictError('stale_memory_version');
    }
    const isMerge = batch.startsWith('notes:merge:');
    if (isMerge) {
      const primary = JSON.parse(revisions[0].after_json).batch_participants?.[0];
      if (typeof primary !== 'string') throw new MemoryConflictError('merge_undo_source_changed');
      const beforeStates = revisions.map(r => JSON.parse(r.before_json) as Row);
      // Older merged revisions did not snapshot Android Share receipts and
      // did not rebind them. They already point to the original source, so
      // restore their attachments without rewriting those legacy receipts.
      // A partial/malformed mix of old and new journal shapes must fail closed.
      const legacy = beforeStates.every(before => before.shareFingerprints === undefined);
      const newFormat = beforeStates.every(before => Array.isArray(before.shareFingerprints));
      const target = await tx.getFirstAsync<{payload_json:string}>(
        'SELECT payload_json FROM memory_entities WHERE id=?', [primary]);
      const origins = target ? JSON.parse(target.payload_json).merged_sources : null;
      if ((!legacy && !newFormat) ||
          (legacy && Array.isArray(origins) && origins.some((origin:Row) =>
            origin && Object.prototype.hasOwnProperty.call(origin, 'attachment_ids'))))
        throw new MemoryConflictError('merge_undo_source_changed');
      // Neither old attachments nor Share fingerprints carry an entity CAS
      // counter: check all of them inside BEGIN IMMEDIATE before the first
      // ownership update. Missing/moved records abort the ENTIRE undo.
      for (const before of beforeStates) {
        if (!Array.isArray(before.attachmentIds))
          throw new MemoryConflictError('merge_undo_source_changed');
        for (const id of before.attachmentIds) {
          const current = await tx.getFirstAsync<{entity_id:string}>(
            'SELECT entity_id FROM memory_attachments WHERE id=?', [id]);
          if (!current || current.entity_id !== primary)
            throw new MemoryConflictError('merge_undo_source_changed');
        }
        if (newFormat) for (const fingerprint of before.shareFingerprints) {
          const current = await tx.getFirstAsync<{entity_id:string}>(
            'SELECT entity_id FROM memory_received_shares WHERE fingerprint=?', [fingerprint]);
          if (!current || current.entity_id !== primary)
            throw new MemoryConflictError('merge_undo_source_changed');
        }
      }
    }
    for (const revision of revisions) {
      const before = JSON.parse(revision.before_json), current = await snapshot(tx, before.id);
      for (const id of before.attachmentIds || [])
        await tx.runAsync('UPDATE memory_attachments SET entity_id=? WHERE id=?', [before.id, id]);
      if (isMerge && Array.isArray(before.shareFingerprints)) {
        for (const fingerprint of before.shareFingerprints)
          await tx.runAsync('UPDATE memory_received_shares SET entity_id=? WHERE fingerprint=?',
            [before.id, fingerprint]);
      }
      await write(tx, current, { ...before }, 'Отмена ' + batch);
    }
    if (isMerge) {
      // Undo journal ordering is by timestamp/UUID, not participant order.
      // Rebuild the primary only AFTER all source originals returned home.
      const primary = JSON.parse(revisions[0].after_json).batch_participants[0];
      await indexEntity(tx, primary);
    }
  });
}

/** Irreversible, explicit second confirmation in the UI; never operates on active notes. */
export async function purgeNotes(db: SQL, selection: NoteSelection[], options?: { protectReferences?: boolean }): Promise<void> {
  if (!selection.length || selection.length > 100 || new Set(selection.map(s=>s.id)).size !== selection.length ||
      selection.some(s=>!s.id || !Number.isSafeInteger(s.record_version) || s.record_version < 1))
    throw new Error('Выберите от 1 до 100 разных записей.');
  await withUnlockedTransaction(db, async tx => {
    for (const selected of selection) {
      const current = await snapshot(tx, selected.id);
      if (current.record_version !== selected.record_version || current.record_status !== 'trashed' || current.domain !== 'notes')
        throw new MemoryConflictError('stale_memory_version');
      if (options?.protectReferences) {
        // Preview eligibility can change without incrementing record_version
        // when another record links to this source. Recheck atomically within
        // the SAME canonical writer, before deleting ANY item in this batch.
        const linked = await tx.getFirstAsync<{ id: string }>(
          "SELECT e.id FROM memory_entities e WHERE e.id=? AND (" +
          BULK_PURGE_NEEDS_REVIEW_SQL + ")", [selected.id]);
        if (linked) throw new MemoryConflictError('trash_references_changed_repeat_preview');
      }
    }
    for (const selected of selection) {
      // SQLCipher v13's immutable review history contains undo -> retract
      // references with ON DELETE RESTRICT. Cascading entity -> relation ->
      // witness -> review rows in an arbitrary order can fail FK validation.
      // On EXPLICIT irreversible purge only, remove dependent undo actions
      // before their predecessor actions, in the same rollback-safe transaction.
      // Archiving/trashing/ordinary edits NEVER erase history or proof.
      const affectedWitnesses = "SELECT w.id FROM memory_relation_evidence w " +
        "JOIN memory_relations r ON r.id=w.relation_id " +
        "WHERE r.source_entity_id=? OR r.target_entity_id=? OR w.evidence_entity_id=?";
      const selectedIds = [selected.id,selected.id,selected.id];
      const affectedProposals = "SELECT id FROM memory_review_proposals " +
        "WHERE source_entity_id=? OR target_entity_id=? OR evidence_entity_id=?";
      // v15 keeps the SAME immutable journal for all relation-candidate
      // actions. Its undo FK must be released before an entity cascade.
      await tx.runAsync(
        "DELETE FROM memory_review_actions WHERE action='undo' AND (" +
        "relation_evidence_id IN (" + affectedWitnesses + ") OR " +
        "review_proposal_id IN (" + affectedProposals + "))",
        [...selectedIds,...selectedIds]);
      await tx.runAsync(
        "DELETE FROM memory_review_actions WHERE " +
        "relation_evidence_id IN (" + affectedWitnesses + ") OR " +
        "review_proposal_id IN (" + affectedProposals + ")",
        [...selectedIds,...selectedIds]);
      await tx.runAsync('DELETE FROM memory_search_fts WHERE entity_id=?', [selected.id]);
      await tx.runAsync('DELETE FROM memory_entities WHERE id=?', [selected.id]);
    }
  });
}

export function noteUndoLabel(token: string): string {
  const labels: Record<string, string> = { move: 'Отменить перенос', trash: 'Отменить удаление', restore: 'Отменить восстановление', merge: 'Отменить объединение', archive: 'Отменить архивирование', unarchive: 'Отменить возврат из архива' };
  return labels[token.split(':')[1]] || 'Отменить операцию с записями';
}

/** Show the single batch journal as readable history, never raw UUID tokens. */
export function noteHistoryLabel(reason: string): string {
  const match = /^(Отмена )?notes:(move|trash|restore|merge|archive|unarchive):/.exec(reason);
  if (!match) return reason;
  const labels: Record<string, string> = {
    move: "Перенос в другой раздел",
    trash: "Перемещение в корзину",
    restore: "Восстановление из корзины",
    merge: "Объединение записей",
    archive: "Перенос в архив",
    unarchive: "Возврат из архива",
  };
  const label = labels[match[2]];
  return match[1] ? "Отмена: " + label.toLowerCase() : label;
}
