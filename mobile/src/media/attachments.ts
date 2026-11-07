import { replaceFileText } from "./batch-recognition";
import * as Crypto from 'expo-crypto';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { VerifiedOriginalLocator, EntityRecord } from '../local-memory/types';
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from '../local-memory/storage';
import { MemoryConflictError } from '../local-memory/types';
import { SqliteMemoryRepository } from '../local-memory/repository';
import { appendExtractionInTransaction, fingerprintExtractionSource } from '../local-memory/extractions';
import type { ExtractionSegmentInput } from '../local-memory/extractions';
import type { ImportFile } from './kinds';
import type { FileRecognition } from './batch-recognition';
import { mediaKind } from './kinds';
import { sharedLinkPreview } from './messenger-share-links';
import { validSourceCoverage, validTelegramTextObservation, type SourceCoverage, type TelegramTextObservation } from './source-provenance';

export const MAX_ORIGINAL_BYTES = 80 * 1024 * 1024;
export const MAX_ORIGINALS_PER_NOTE = 10;
export const MAX_TOTAL_ORIGINAL_BYTES = 80 * 1024 * 1024;
const PART_BYTES = 256 * 1024;
export type Attachment = { id: string; entity_id: string; name: string; mime: string; size: number };
export type ShareReplay = { entityId: string; recordStatus: 'active' | 'archived' | 'trashed' };
/** This is a notification only: the canonical saveMediaNote writer remains the only note writer. */
export type ShareReplayCallback = (replay: ShareReplay) => void;
const previewDirectory = () => new Directory(Paths.cache, 'persai-previews');
export function clearAttachmentPreviews() {
  for (const dir of [previewDirectory(), new Directory(Paths.cache, 'persai-incoming'),
    new Directory(Paths.cache, 'persai-pdf-page-previews')]) {
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
/** Snapshot content with bounded 256 KiB reads, independent of ephemeral Android URI.
 * Fingerprints are SHA-256 of the ordered SHA-256 part digests and byte count.
 * writeOriginal rechecks the snapshot before the DB transaction commits.
 */
async function incomingOriginalDigest(file: ImportFile, signal?: AbortSignal): Promise<string> {
  const handle = new File(file.uri).open(FileMode.ReadOnly);
  try {
    const size = handle.size;
    if (!size || size > MAX_ORIGINAL_BYTES) throw new Error('Выберите непустой файл размером до 80 МБ.');
    const parts: string[] = [];
    let read = 0;
    while (read < size) {
      check(signal);
      const bytes = handle.readBytes(Math.min(PART_BYTES, size - read));
      if (!bytes.length) throw new Error('Не удалось прочитать оригинал целиком.');
      parts.push(await hash(bytes));
      read += bytes.length;
    }
    check(signal);
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([size, parts]));
  } finally { handle.close(); }
}
function originalKind(file: ImportFile) {
  return file.mimeType === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'document' : mediaKind(file);
}
export async function writeOriginal(db: Pick<SQLiteDatabase, 'runAsync'>, entityId: string, file: ImportFile, signal?: AbortSignal, expectedShareDigest?: string) {
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
    const shareParts: string[] = [];
    while (total < size) {
      check(signal);
      const bytes = handle.readBytes(Math.min(PART_BYTES, size - total));
      if (!bytes.length) throw new Error('Не удалось прочитать оригинал целиком.');
      const partHash = await hash(bytes);
      if (expectedShareDigest) shareParts.push(partHash);
      await db.runAsync('INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)', [id, ord++, bytes, partHash]);
      total += bytes.length;
    }
    check(signal);
    if (expectedShareDigest) {
      const actual = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
        JSON.stringify([size, shareParts]));
      if (actual !== expectedShareDigest) throw new Error('Оригинал изменился при сохранении. Поделитесь им ещё раз.');
    }
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
    // Only offline OCR is allowed to produce PDF page evidence; image-only
    // modes cannot be forged for audio/documents.
    if (item.imageMode !== undefined &&
      !((mediaKind(originals[item.index]) === 'image' &&
         ['describe','document-text','offline-ocr'].includes(item.imageMode)) ||
        (mediaKind(originals[item.index]) === 'document' && item.imageMode === 'offline-ocr')))
      throw new Error('invalid_image_recognition_mode');
    if (item.asrProducerId !== undefined &&
        (mediaKind(originals[item.index]) !== 'audio' ||
         !['local-whisper','openai:gpt-transcribe','openai:whisper-1','openai:gpt-4o-transcribe','openai:gpt-4o-mini-transcribe'].includes(item.asrProducerId)))
      throw new Error('invalid_asr_producer');
    total += text.length;
    if (total > 60_000) throw new Error('recognition_source_text_too_large');
    // Timestamp ranges are accepted only for audio and only when a processor
    // supplied ALL of them. They mark source intervals, not word-level proof.
    const segments = item.segments;
    if (segments !== undefined) {
      const sourceKind=mediaKind(originals[item.index]);
      if (!['audio','document'].includes(sourceKind) ||
          !Array.isArray(segments) || !segments.length || segments.length > 128) {
        throw new Error('invalid_recognition_segments');
      }
      let previousEnd = 0, totalSegmentChars = 0;
      for (const part of segments) {
        const loc = part?.location;
        const validTime = sourceKind === 'audio' && loc?.kind === 'time' &&
          Number.isSafeInteger(loc.startMs) && Number.isSafeInteger(loc.endMs) &&
          loc.startMs >= previousEnd && loc.endMs > loc.startMs &&
          loc.endMs <= 24 * 60 * 60 * 1000;
        const validPage = sourceKind === 'document' && loc?.kind === 'page' &&
          Number.isSafeInteger(loc.page) && loc.page >= 1 && loc.page <= 128 &&
          loc.page >= previousEnd;
        if (typeof part?.text !== 'string' || !part.text.trim() || part.text.length > 6000 ||
            (!validTime && !validPage)) {
          throw new Error('invalid_recognition_segments');
        }
        previousEnd = loc.kind === 'time' ? loc.endMs : loc.page;
        totalSegmentChars += part.text.length;
      }
      if (totalSegmentChars > 60_000) throw new Error('invalid_recognition_segments');
    }
    // Source page count is metadata, not authority to invent a locator.
    // Only the trusted document extraction's reported pages may be persisted.
    const pdf = item.pdfCoverage;
    if (pdf !== undefined) {
      const sourceKind = mediaKind(originals[item.index]);
      const actualPages = new Set(segments?.filter(part => part.location.kind === 'page')
        .map(part => part.location.kind === 'page' ? part.location.page : 0));
      const reported = pdf.totalPageCount;
      if (sourceKind !== 'document' || !segments?.length ||
          !actualPages.size || pdf.coverage !== 'partial' ||
          !Number.isSafeInteger(pdf.extractedPageCount) ||
          pdf.extractedPageCount !== actualPages.size ||
          (reported !== null && (!Number.isSafeInteger(reported) || reported < 1 || reported > 128)) ||
          (reported !== null && [...actualPages].some(page => page > reported)) ||
          !Array.isArray(pdf.missingPages) ||
          (reported === null && pdf.missingPages.length !== 0)) throw new Error('invalid_pdf_page_coverage');
      const expectedMissing = reported === null ? [] : Array.from({length:reported},(_,i)=>i+1)
        .filter(page=>!actualPages.has(page));
      if (pdf.missingPages.length !== expectedMissing.length ||
          pdf.missingPages.some((page,i)=>page !== expectedMissing[i])) throw new Error('invalid_pdf_page_coverage');
    }
    return { index: item.index, status: 'success' as const, text,
      ...(segments ? { segments } : {}),
      ...(pdf ? { pdfCoverage: pdf } : {}),
      ...(item.imageMode ? { imageMode: item.imageMode } : {}),
      ...(item.asrProducerId ? { asrProducerId: item.asrProducerId } : {}) };
  });
}
/** Note + original + receipt commit together. Cancellation never leaves a partial note. */
export async function saveMediaNote(profile: string, input: { file?: ImportFile; files?: ImportFile[]; title: string; body: string; extractedText?: string; recognitions?: FileRecognition[]; sensitivity: 'sensitive' | 'standard'; receipt?: string; onReplay?: ShareReplayCallback; allowSeparateCopy?: boolean; collectionId?: string; sourceUrl?: string; sourceCoverage?: SourceCoverage; telegramObservation?: TelegramTextObservation; publicationClaim?: {date:string;evidence:'html_meta';sourceAttribute:'article:published_time'|'datePublished'} }, signal?: AbortSignal): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    if (input.publicationClaim) {
      const claim=input.publicationClaim;
      const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(claim.date);
      if (!input.sourceUrl || !/^https:\/\//.test(input.sourceUrl) ||
          claim.evidence!=="html_meta" ||
          !["article:published_time","datePublished"].includes(claim.sourceAttribute) || !m)
        throw new Error("invalid_source_publication_claim");
      const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
      const date=new Date(Date.UTC(year,month-1,day));
      if(year<1000 || date.getUTCFullYear()!==year ||
         date.getUTCMonth()!==month-1 || date.getUTCDate()!==day)
        throw new Error("invalid_source_publication_claim");
    }
    if (input.telegramObservation &&
        (!validTelegramTextObservation(input.sourceUrl,input.sourceCoverage,input.telegramObservation) ||
          !input.extractedText?.trim())) throw new Error("invalid_source_observation");
    if (input.sourceCoverage) {
      if (!input.sourceUrl || !validSourceCoverage(input.sourceCoverage))
        throw new Error("invalid_source_coverage");
      if (input.sourceCoverage === "telegram_post_text_only") {
        const link = sharedLinkPreview({shareType:"url",value:input.sourceUrl});
        if (link?.platform !== "telegram" || link.kind !== "public_post_candidate")
          throw new Error("invalid_source_coverage");
      }
    }
    // One canonical list for old single-file clients and future multi-picker UI.
    // Keep the single-file fingerprint identical to older app versions.
    if (input.file && input.files !== undefined) throw new Error('Передайте оригиналы одним способом.');
    const originals = input.files || (input.file ? [input.file] : []);
    if (originals.length > MAX_ORIGINALS_PER_NOTE) throw new Error('Не более 10 вложений в одной заметке.');
    const verified = checkedRecognitions(originals, input.recognitions);
    const originalHashes: string[] = [];
    const receivedDigests: string[] = [];
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
      if (input.receipt) receivedDigests.push(await incomingOriginalDigest(original, signal));
    }
    const contentHash: string | string[] | null = originals.length > 1 ? originalHashes : originalHashes[0] || null;
    const pdfCoverage = verified?.flatMap(x => x.status === 'success' && x.pdfCoverage
      ? [{ index: x.index, total_page_count: x.pdfCoverage.totalPageCount,
        extracted_page_count: x.pdfCoverage.extractedPageCount,
        missing_pages: x.pdfCoverage.missingPages }]
      : []);
    const recognitionSignature = verified ? verified.filter(x => x.status === 'success').map(x =>
      [x.index, x.text, x.segments || null, x.pdfCoverage || null, x.imageMode || null,
        ...(x.asrProducerId ? [x.asrProducerId] : [])]) : null;
    // The old key is still checked so identical imports saved before MSG-6.B
    // remain idempotent. Only Android Share gets a new content-derived key.
    const legacyReceipt = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
      JSON.stringify([input.receipt || 'device-import', contentHash, input.title, input.body,
        input.extractedText || "", input.sensitivity, input.collectionId || "", input.sourceUrl || "",
        ...(recognitionSignature ? [recognitionSignature] : [])]));
    const preview = input.receipt && input.sourceUrl ?
      sharedLinkPreview({ shareType: 'url', value: input.sourceUrl }) : null;
    const postKey = preview?.platform === 'telegram' &&
      preview.kind === 'public_post_candidate' && preview.messageKey
      ? 'telegram:' + preview.messageKey.toLowerCase() : null;
    // URL aliases identify the same syntactic public Telegram message, NOT
    // verified post content. Keep authored captions and original provenance.
    const onlyPostUrl = Boolean(postKey && input.sourceUrl &&
      input.body.trim() === input.sourceUrl.trim());
    const normalizedBody = onlyPostUrl ? postKey : input.body;
    const inferredFileTitle = originals.length === 1 && !input.body.trim() &&
      input.title.trim() === originals[0].name.slice(0, 160);
    const normalizedTitle = onlyPostUrl && (input.title === 'Ссылка' ||
      input.title === input.body.trim()) ? 'telegram-link' :
      inferredFileTitle ? 'incoming-file-untitled' : input.title;
    const receivedReceipt = input.receipt
      ? await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([
          'android-share-content-v2', receivedDigests, originals.map(mediaKind),
          normalizedTitle, normalizedBody,
          input.extractedText || "", input.sensitivity, input.collectionId || "",
          postKey || input.sourceUrl || "", recognitionSignature,
        ]))
      : legacyReceipt;
    async function replayIfFound(): Promise<string | null> {
      const old = await db.getFirstAsync<{ entity_id: string; record_status: ShareReplay['recordStatus'] }>(
        'SELECT r.entity_id,e.record_status FROM memory_received_shares r ' +
        'JOIN memory_entities e ON e.id=r.entity_id ' +
        'WHERE r.fingerprint IN (?,?) ORDER BY CASE WHEN r.fingerprint=? THEN 0 ELSE 1 END LIMIT 1',
        [receivedReceipt, legacyReceipt, receivedReceipt]);
      if (!old) return null;
      check(signal);
      input.onReplay?.({ entityId: old.entity_id, recordStatus: old.record_status });
      return old.entity_id;
    }
    // Never silently suppress intentional separate copies of the same media
    // (e.g. a photo sent in two different chats). This flag is set only after
    // the user's additional explicit confirmation in the import UI.
    const repeated = input.allowSeparateCopy ? null : await replayIfFound();
    if (repeated) return repeated;
    const receipt = input.allowSeparateCopy && input.receipt
      ? await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
          JSON.stringify([receivedReceipt, 'confirmed-separate-copy', Crypto.randomUUID()]))
      : receivedReceipt;
    const repo = new SqliteMemoryRepository(db);
    const slug = input.receipt ? 'inbox' : 'notes';
    let col = (await repo.listCollections()).find(c => input.collectionId ? c.id === input.collectionId : c.slug === slug);
    if (input.collectionId && !col) throw new Error("Раздел не найден.");
    if (!col) col = await repo.createCollection({ name: input.receipt ? 'Входящие' : 'Заметки', slug, sensitivity: input.receipt ? 'sensitive' : 'standard' });
    const title = input.title.trim().slice(0, 160) || originals[0]?.name || 'Входящая запись';
    let entity: EntityRecord;
    try {
      entity = await repo.createEntity({ collection_id: col.id, domain: 'notes', title,
      payload: { type: 'note', title,  ...(input.sourceUrl ? { source_url: input.sourceUrl } : {}), ...(input.sourceCoverage ? { source_text_coverage: input.sourceCoverage } : {}), ...(input.telegramObservation ? {source_observation:input.telegramObservation} : {}), ...(input.publicationClaim ? { source_publication_date:input.publicationClaim.date, source_publication_evidence:input.publicationClaim.evidence, source_publication_attribute:input.publicationClaim.sourceAttribute } : {}), ...(pdfCoverage?.length ? { source_pdf_coverage: pdfCoverage } : {}), body: input.body.trim(), ...(input.extractedText ? { extracted_text: input.extractedText.trim() } : {}), ...(originals.length ? { source_file: originals[0].name, source_media: mediaKind(originals[0]),
        ...(originals.length > 1 ? { source_files: originals.map(f => f.name), source_media_types: originals.map(mediaKind) } : {}) } : {}) },
      sensitivity: input.sensitivity, source_kind: 'user', source_ref: input.receipt ? 'android-share' : 'device-import',
    }, async (tx, entityId) => {
      const attachmentIds: string[] = [];
      for (const [index, original] of originals.entries()) attachmentIds.push(await writeOriginal(tx, entityId, original, signal, receivedDigests[index]));
      // Use only indexed recognition results that were captured separately
      // for the very same ORIGINAL selection. A failed file has no evidence.
      // The user-edited/joint text in payload remains a distinct summary.
      if (verified) {
        for (const run of verified) {
          if (run.status !== 'success') continue;
          const kind = mediaKind(originals[run.index]);
          await appendExtractionInTransaction(tx, {
            attachmentId: attachmentIds[run.index],
            producerKind: kind === 'audio' ? 'asr' : kind === 'document' ? 'pdf' :
              kind === 'image' ? 'vision' : kind === 'text' ? 'text' : 'unknown',
            producerId: kind === 'audio' && run.asrProducerId ? run.asrProducerId :
              kind === 'document' && run.imageMode === 'offline-ocr' ? 'android-tesseract-5-rus' :
              kind === 'image' && run.imageMode === 'offline-ocr' ? 'android-tesseract-5-rus' :
              run.segments && kind === 'document' ? 'android-pdf-text' :
              run.segments ? 'openai-whisper-1' : 'persai-media-extract',
            producerRevision: kind === 'audio' && run.asrProducerId ? 'file-asr-v1' :
              kind === 'document' && run.imageMode === 'offline-ocr' ? 'native-page-and-russian-ocr-v1' :
              kind === 'image' && run.imageMode === 'offline-ocr' ? 'local-tesseract-rus-v1' :
              run.segments && kind === 'document' ? 'native-page-v1' :
              run.segments ? 'official-segment-time-v1' :
              kind === 'image' && run.imageMode === 'document-text' ? 'provider-photo-document-text-v1' : 'source-text-v1',
            status: 'partial', coverage: run.pdfCoverage ? 'partial' : 'unknown',
            segments: run.segments || unknownSegments(run.text),
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
    } catch (error) {
      // A concurrent identical Share may win the unique receipt insert.
      // createEntity already rolled back its complete transaction. Never
      // leave a partially written note or report an unexplained failure.
      if (input.receipt && !input.allowSeparateCopy) {
        const winner = await replayIfFound();
        if (winner) return winner;
      }
      throw error;
    }
    return entity.id;
  });
}
export async function attachmentForEntity(profile: string, entityId: string) {
  return withLocalMemoryDatabase(profile, db => db.getFirstAsync<Attachment>('SELECT * FROM memory_attachments WHERE entity_id=?', [entityId]));
}
/** Only the currently opened attachment is materialised; no original bytes enter LLM payloads. */
/** Only one original materializer. A locator from confirmed relation search
 * must be rechecked at USE time, not trusted because it appeared on an older
 * search card. Local manual note views still honor their normal profile scope.
 */
export async function materializeAttachment(
  profile: string, attachment: Attachment, signal?: AbortSignal,
  verified?: VerifiedOriginalLocator,
): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    check(signal);
    if(verified && (attachment.id!==verified.attachmentId ||
       attachment.entity_id!==verified.recordId ||
       !Number.isSafeInteger(verified.recordVersion) || verified.recordVersion<1 ||
       verified.metadataOnly!==true))
      throw new Error('memory_source_not_available_or_stale');
    const actual = await db.getFirstAsync<Attachment>(
      'SELECT a.* FROM memory_attachments a JOIN memory_entities e ON e.id=a.entity_id '+
      'JOIN memory_collections c ON c.id=e.collection_id '+
      'WHERE a.id=? AND a.entity_id=?'+
      (verified ? " AND e.record_status='active' AND e.record_version=? "+
       "AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'" : ''),
      verified ? [attachment.id,attachment.entity_id,verified.recordVersion] :
        [attachment.id,attachment.entity_id]);
    if(!actual || (verified && (
      actual.name!==verified.name || actual.mime!==verified.mime ||
      actual.size!==verified.size)))
      throw new Error(verified?'memory_source_not_available_or_stale':'Оригинал не найден.');
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
      if(verified){
        // A separate edit or sensitivity change made during decryption must
        // discard the preview before control returns to the caller.
        const current=await db.getFirstAsync<{id:string}>(
          "SELECT a.id FROM memory_attachments a "+
          "JOIN memory_entities e ON e.id=a.entity_id "+
          "JOIN memory_collections c ON c.id=e.collection_id "+
          "WHERE a.id=? AND e.id=? AND e.record_status='active' "+
          "AND e.record_version=? AND e.sensitivity IN ('standard','inherit') "+
          "AND c.sensitivity='standard' AND a.name=? AND a.mime=? AND a.size=?",
          [verified.attachmentId,verified.recordId,verified.recordVersion,
           verified.name,verified.mime,verified.size]);
        if(!current)throw new Error('memory_source_not_available_or_stale');
      }
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

/** Re-recognition reuses the existing entity writer and extraction evidence.
 * A candidate is volatile UI state until a separate explicit acceptance.
 * NEVER overwrite an original, user body/comment, or other attachments.
 */
export async function savedOriginalRevision(profile: string, attachment: Attachment): Promise<string> {
  return withLocalMemoryDatabase(profile, async db => {
    const current = await db.getFirstAsync<{id:string}>(
      "SELECT a.id FROM memory_attachments a JOIN memory_entities e ON e.id=a.entity_id "+
      "WHERE a.id=? AND a.entity_id=? AND e.record_status='active'",
      [attachment.id,attachment.entity_id]);
    if (!current) throw new MemoryConflictError('stale_memory_version');
    return fingerprintExtractionSource(db, attachment.id);
  });
}

export async function applyRecognitionCandidate(repo: SqliteMemoryRepository, input: {
  note: EntityRecord; attachment: Attachment; expectedSourceVersion: string;
  text: string; producerId: string; producerRevision: string;
  segments?: ExtractionSegmentInput[];
}): Promise<EntityRecord> {
  const { note, attachment } = input;
  if (note.domain !== "notes" || note.record_status !== "active" ||
      attachment.entity_id !== note.id || !input.expectedSourceVersion ||
      !input.text.trim() || input.text.length > 60_000) throw new Error("invalid_recognition_candidate");
  const kind = mediaKind({uri:"file:///original",name:attachment.name,mimeType:attachment.mime});
  const segments = input.segments ?? unknownSegments(input.text);
  if (segments.length > 128 || !segments.length) throw new Error("invalid_recognition_segments");
  const names = Array.isArray(note.payload.source_files) ? note.payload.source_files.map(String) : [attachment.name];
  const index = names.indexOf(attachment.name);
  if (index < 0 || index !== names.lastIndexOf(attachment.name))
    throw new Error("Не удалось однозначно определить файл. Текущий текст сохранён.");
  const payload = {...note.payload, extracted_text: replaceFileText(String(note.payload.extracted_text || ""), names, index, input.text.trim())};
  return repo.reviseEntity(note.id,note.record_version,payload,"Повторное распознавание оригинала",
    undefined,false,async (tx,entityId) => {
      const current = await tx.getFirstAsync<{id:string;record_status:string}>(
        "SELECT a.id,e.record_status FROM memory_attachments a "+
        "JOIN memory_entities e ON e.id=a.entity_id "+
        "WHERE a.id=? AND a.entity_id=? AND e.id=?",
        [attachment.id,entityId,note.id]);
      if (!current || current.record_status !== "active" ||
          await fingerprintExtractionSource(tx,attachment.id) !== input.expectedSourceVersion)
        throw new MemoryConflictError("stale_memory_version");
      await appendExtractionInTransaction(tx,{
        attachmentId:attachment.id,
        producerKind:kind === "audio"?"asr":kind==="document"?"pdf":
          kind==="image"?(input.producerId === "android-tesseract-5-rus"?"ocr":"vision"):kind==="text"?"text":"vision",
        producerId:input.producerId,producerRevision:input.producerRevision,
        status:"partial",coverage:"unknown",segments,
      });
    });
}
