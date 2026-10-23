import * as Crypto from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from '../local-memory/storage';
import { SqliteMemoryRepository } from '../local-memory/repository';
import type { ImportFile } from './kinds';
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
export async function writeOriginal(db: Pick<SQLiteDatabase, 'runAsync'>, entityId: string, file: ImportFile, signal?: AbortSignal) {
  if (!/^(file|content):\/\//.test(file.uri)) throw new Error('Для оригинала нужен локальный файл.');
  mediaKind(file);
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
  } finally { handle.close(); }
}
/** Note + original + receipt commit together. Cancellation never leaves a partial note. */
export async function saveMediaNote(profile: string, input: { file?: ImportFile; files?: ImportFile[]; title: string; body: string; extractedText?: string; sensitivity: 'sensitive' | 'standard'; receipt?: string; collectionId?: string; sourceUrl?: string }, signal?: AbortSignal): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    // One canonical list for old single-file clients and future multi-picker UI.
    // Keep the single-file fingerprint identical to older app versions.
    if (input.file && input.files !== undefined) throw new Error('Передайте оригиналы одним способом.');
    const originals = input.files || (input.file ? [input.file] : []);
    if (originals.length > MAX_ORIGINALS_PER_NOTE) throw new Error('Не более 10 вложений в одной заметке.');
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
    const receipt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([input.receipt || 'device-import', contentHash, input.title, input.body, input.extractedText || "", input.sensitivity, input.collectionId || "", input.sourceUrl || ""]));
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
      for (const original of originals) await writeOriginal(tx, entityId, original, signal);
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
