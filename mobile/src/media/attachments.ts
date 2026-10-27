import * as Crypto from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from '../local-memory/storage';
import { MemoryConflictError } from '../local-memory/types';
import { SqliteMemoryRepository } from '../local-memory/repository';
import { appendExtractionInTransaction } from '../local-memory/extractions';
import type { ImportFile } from './kinds';
import type { FileRecognition } from './batch-recognition';
import { mediaKind } from './kinds';

export const MAX_ORIGINAL_BYTES = 80 * 1024 * 1024;
export const MAX_ORIGINALS_PER_NOTE = 10;
export const MAX_TOTAL_ORIGINAL_BYTES = 80 * 1024 * 1024;
const PART_BYTES = 256 * 1024;
export type Attachment = { id: string; entity_id: string; name: string; mime: string; size: number };
const previewDirectory = () => new Directory(Paths.cache, 'persai-previews');
export function clearAttachmentPreviews() {
  for (const dir of [previewDirectory(), new Directory(Paths.cache, 'persai-incoming')]) {
    if (dir.exists) dir.delete();
  }
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Сохранение файла остановлено.');
  if (!localMemorySessionUnlocked()) throw new Error('application_locked');
}
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  const result = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('');
}
function originalKind(file: ImportFile) {
  return file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'document' : mediaKind(file);
}
export async function writeOriginal(db: Pick<SQLiteDatabase, 'runAsync'>, entityId: string, file: ImportFile, signal?: AbortSignal) {
  if (!/^(file|content):\/\//.test(file.uri)) throw new Error('Для оригинала нужен локальный файл.');
  originalKind(file);
  const source = new File(file.uri);
  const handle = source.open(FileMode.ReadOnly);
  try {
    const size = handle.size;
    if (!size || size > MAX_ORIGINAL_BYTES) throw new Error('Выберите непустой файл размером до 80 МБ.');
    const id = Crypto.randomUUID();
    await db.runAsync('INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)',
      [id, entityId, file.name.slice(0, 240), file.mimeType || 'application/octet-stream', size, new Date().toISOString()]);
    let total = 0, ord = 0;
    while (total < size) {
      check(signal);
      const bytes = handle.readBytes(Math.min(PART_BYTES, size - total));
      if (!bytes.length) throw new Error('Не удалось прочитать оригинал целиком.');
      await db.runAsync('INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)', [id, ord++, bytes, await hash(bytes)]);
      total += bytes.length;
    }
    check(signal);
    return id;
  } finally { handle.close(); }
}
/** UTF-16-safe bounded segments; avoids fabricating PDF pages or audio times.
 * <=3000 codepoints keeps UTF-16 .length <=6000 even with astral characters.
 */
function unknownSegments(text: string) {
  const characters = Array.from(text);
  const segments: Array<{ text: string; location: { kind: 'unknown' } }> = [];
  for (let pos = 0; pos < characters.length; pos += 3000) {
    segments.push({ text: characters.slice(pos, pos + 3000).join(''), location: { kind: 'unknown' } });
  }
  return segments;
}
/** The recognition was produced separately for each saved original, before
 * the user edited the combined note. Do not infer page/time or trust filenames
 * alone: indexes and file names must match the ORIGINAL selection order. */
function checkedRecognitions(originals: ImportFile[], values?: FileRecognition[]) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || !originals.length || values.length > originals.length) throw new Error('invalid_recognition_sources');
  const used = new Set<number>();
  let total = 0;
  return values.map(item => {
    if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= originals.length ||
        used.has(item.index) || item.name !== originals[item.index].name ||
        !['success','error'].includes(item.status)) throw new Error('invalid_recognition_sources');
    used.add(item.index);
    if (item.status === 'error') {
      if (item.text !== undefined) throw new Error('invalid_recognition_sources');
      return { index: item.index, status: 'error' as const };
    }
    if (typeof item.text !== 'string' || !item.text.trim()) throw new Error('invalid_recognition_sources');
    const text = item.text.trim();
    total += text.length;
    if (total > 60_000) throw new Error('recognition_source_text_too_large');
    return { index: item.index, status: 'success' as const, text };
  });
}
/** Note + original + receipt commit together. Cancellation never leaves a partial note. */
export async function saveMediaNote(profile: string, input: { file?: ImportFile; files?: ImportFile[]; title: string; body: string; extractedText?: string; recognitions?: FileRecognition[]; sensitivity: 'sensitive' | 'standard'; receipt?: string; collectionId?: string; sourceUrl?: string }, signal?: AbortSignal): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    // One canonical list for old single-file clients and future multi-picker UI.
    // Keep the single-file fingerprint identical to older app versions.
    if (input.file && input.files !== undefined) throw new Error('Передайте оригиналы одним способом.');
    const originals = input.files || (input.file ? [input.file] : []);
    if (originals.length > MAX_ORIGINALS_PER_NOTE) throw new Error('Не более 10 вложений в одной заметке.');
    const verified = checkedRecognitions(originals, input.recognitions);
    const originalHashes: string[] = [];
    let combinedSize = 0;
    // Native MD5 is only a deduplication fingerprint; per-part SHA-256 verifies
    // decrypted originals. File bytes are never loaded into JS all at once.
    for (const original of originals) {
      if (!/^(file|content):\/\//.test(original.uri)) throw new Error('Для оригинала нужен локальный файл.');
      mediaKind(original);
      const source = new File(original.uri);
      if (!source.size || source.size > MAX_ORIGINAL_BYTES) throw new Error('Выберите непустой файл размером до 80 МБ.');
      combinedSize += source.size;
      if (combinedSize > MAX_TOTAL_ORIGINAL_BYTES) throw new Error('Размер вложений вместе не должен превышать 80 МБ.');
      const fingerprint = source.md5;
      if (!fingerprint) throw new Error('Не удалось прочитать оригинал. Выберите файл повторно.');
      originalHashes.push(fingerprint);
    }
    const contentHash: string | string[] | null = originals.length > 1 ? originalHashes : originalHashes[0] || null;
    const receipt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([input.receipt || 'device-import', contentHash, input.title, input.body, input.extractedText || "", input.sensitivity, input.collectionId || "", input.sourceUrl || "", verified?.filter(x => x.status === 'success').map(x => [x.index, x.text]) || null]));
    {
      const old = await db.getFirstAsync<{ entity_id: string }>('SELECT entity_id FROM memory_received_shares WHERE fingerprint=?', [receipt]);
      if (old) return old.entity_id;
    }
    const repo = new SqliteMemoryRepository(db);
    const slug = input.receipt ? 'inbox' : 'notes';
    let col = (await repo.listCollections()).find(c => input.collectionId ? c.id === input.collectionId : c.slug === slug);
    if (input.collectionId && !col) throw new Error("Раздел не найден.");
    if (!col) col = await repo.createCollection({ name: input.receipt ? 'Входящие' : 'Заметки', slug, sensitivity: input.receipt ? 'sensitive' : 'standard' });
    const title = input.title.trim().slice(0, 160) || originals[0]?.name || 'Входящая запись';
    const entity = await repo.createEntity({ collection_id: col.id, domain: 'notes', title,
      payload: { type: 'note', title, ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}), body: input.body.trim(), ...(input.extractedText ? { extracted_text: input.extractedText.trim() } : {}), ...(originals.length ? { source_file: originals[0].name, source_media: mediaKind(originals[0]),
        ...(originals.length > 1 ? { source_files: originals.map(f => f.name), source_media_types: originals.map(mediaKind) } : {}) } : {}) },
      sensitivity: input.sensitivity, source_kind: 'user', source_ref: input.receipt ? 'android-share' : 'device-import',
    }, async (tx, entityId) => {
      const attachmentIds: string[] = [];
      for (const original of originals) attachmentIds.push(await writeOriginal(tx, entityId, original, signal));
      // Use only indexed recognition results that were captured separately
      // for the very same ORIGINAL selection. A failed file has no evidence.
      // The user-edited/joint text in payload remains a distinct summary.
      if (verified) {
        for (const run of verified) {
          if (run.status !== 'success') continue;
          const kind = mediaKind(originals[run.index]);
          await appendExtractionInTransaction(tx, {
            attachmentId: attachmentIds[run.index],
            producerKind: kind === 'audio' ? 'asr' : kind === 'image' ? 'vision' :
              kind === 'text' ? 'text' : 'unknown',
            producerId: 'persai-media-extract', producerRevision: 'source-text-v1',
            status: 'partial', coverage: 'unknown',
            segments: unknownSegments(run.text),
          });
        }
      } else {
        // Backward-compatible single-file fallback: never bind an edited
        // multi-file or joint summary to a made-up original.
        const extracted = input.extractedText?.trim();
        if (attachmentIds.length === 1 && extracted) {
          await appendExtractionInTransaction(tx, {
            attachmentId: attachmentIds[0], producerKind: 'unknown',
            producerId: 'legacy-media-extract', producerRevision: 'unspecified-v1',
            status: 'partial', coverage: 'unknown',
            segments: unknownSegments(extracted),
          });
        }
      }
      check(signal);
      await tx.runAsync('INSERT INTO memory_received_shares(fingerprint,entity_id) VALUES (?,?)', [receipt, entityId]);
    });
    return entity.id;
  });
}
export async function attachmentForEntity(profile: string, entityId: string) {
  return withLocalMemoryDatabase(profile, db => db.getFirstAsync<Attachment>('SELECT * FROM memory_attachments WHERE entity_id=?', [entityId]));
}
/** Only the currently opened attachment is materialised; no original bytes enter LLM payloads. */
export async function materializeAttachment(profile: string, attachment: Attachment, signal?: AbortSignal): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    const actual = await db.getFirstAsync<Attachment>('SELECT * FROM memory_attachments WHERE id=? AND entity_id=?', [attachment.id, attachment.entity_id]);
    if (!actual) throw new Error('Оригинал не найден.');
    if (actual.size <= 0 || actual.size > MAX_ORIGINAL_BYTES) throw new Error('Некорректный размер оригинала.');
    const dir = previewDirectory(); dir.create({ intermediates: true, idempotent: true });
    const extension = actual.name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
    const file = new File(dir, Crypto.randomUUID() + extension); file.create();
    const handle = file.open(FileMode.WriteOnly);
    try {
      let total = 0, ord = 0;
      while (total < actual.size) {
        check(signal);
        const part = await db.getFirstAsync<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }>('SELECT bytes,sha256 FROM memory_attachment_parts WHERE attachment_id=? AND ord=?', [actual.id, ord++]);
        if (!part?.bytes.length || part.bytes.length > PART_BYTES || await hash(part.bytes) !== part.sha256) throw new Error('Оригинал повреждён: проверка целостности не пройдена.');
        handle.writeBytes(part.bytes); total += part.bytes.length;
      }
      if (total !== actual.size) throw new Error('Размер оригинала не совпадает.');
      check(signal);
      return file.uri;
    } catch (e) { handle.close(); if (file.exists) file.delete(); throw e; }
    finally { try { handle.close(); } catch {} }
  });
}

export async function attachmentsForEntity(profile: string, entityId: string): Promise<Attachment[]> {
  return withLocalMemoryDatabase(profile, db => db.getAllAsync<Attachment>('SELECT * FROM memory_attachments WHERE entity_id=? ORDER BY created_at,id', [entityId]));
}

/** Revision, metadata and all originals commit together; no recognition or model upload. */
export async function appendNoteAttachments(profile: string, entityId: string, expectedVersion: number, files: ImportFile[], signal?: AbortSignal) {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    if (!files.length) throw new Error('Выберите файлы для добавления.');
    const repo = new SqliteMemoryRepository(db), note = await repo.entity(entityId);
    if (!note) throw new Error('Запись не найдена.');
    if (note.record_version !== expectedVersion) throw new MemoryConflictError('stale_memory_version');
    if (!['active', 'archived'].includes(note.record_status)) throw new Error('Сначала восстановите запись из корзины.');
    const existing = await db.getAllAsync<Attachment>('SELECT * FROM memory_attachments WHERE entity_id=? ORDER BY created_at,id', [entityId]);
    if (existing.length + files.length > MAX_ORIGINALS_PER_NOTE) throw new Error('Не более 10 вложений в одной заметке, включая сохранённые.');
    let bytes = existing.reduce((sum, item) => sum + item.size, 0);
    const kinds = files.map(file => {
      if (!/^(file|content):\/\//.test(file.uri)) throw new Error('Для оригинала нужен локальный файл.');
      const kind = originalKind(file), size = new File(file.uri).size;
      if (!size || size > MAX_ORIGINAL_BYTES) throw new Error('Выберите непустой файл размером до 80 МБ.');
      bytes += size; return kind;
    });
    if (bytes > MAX_TOTAL_ORIGINAL_BYTES) throw new Error('Размер всех вложений заметки вместе не должен превышать 80 МБ.');
    const previousKinds = existing.map(item => { try { return originalKind({ uri: '', name: item.name, mimeType: item.mime }); } catch { return 'document'; } });
    const payload = { ...note.payload, source_file: note.payload.source_file || existing[0]?.name || files[0].name,
      source_media: note.payload.source_media || previousKinds[0] || kinds[0],
      source_files: [...existing.map(item => item.name), ...files.map(item => item.name)], source_media_types: [...previousKinds, ...kinds] };
    return repo.reviseEntity(entityId, expectedVersion, payload, `Добавлены вложения: ${files.length}`, undefined, false, async (tx, id) => {
      check(signal);
      for (const file of files) await writeOriginal(tx, id, file, signal);
      const totals = await tx.getFirstAsync<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM memory_attachments WHERE entity_id=?', [id]);
      if (!totals || totals.count > MAX_ORIGINALS_PER_NOTE || totals.bytes > MAX_TOTAL_ORIGINAL_BYTES) throw new Error('Лимит вложений: 10 файлов и 80 МБ на заметку.');
      check(signal);
    });
  });
}
