// Browser metadata only; real encrypted bytes are covered by SQLite tests.
import { localMemoryRepository } from "../src/local-memory/repository";
import type { ImportFile } from "../src/media/kinds";
export const MAX_ORIGINALS_PER_NOTE = 10;
export async function attachmentsForEntity(profile: string, id: string) {
  const note = await (await localMemoryRepository(profile)).entity(id);
  const names = note?.payload.source_files || (note?.payload.source_file ? [note.payload.source_file] : []);
  return (names as string[]).map((name, i) => ({id:id + "-file-" + i, entity_id:id, name, mime:"text/plain", size:100}));
}
export async function appendNoteAttachments(profile: string, id: string, version: number, files: ImportFile[], signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Сохранение файла остановлено.");
  const repo = await localMemoryRepository(profile), note = (await repo.entity(id))!;
  const previous = await attachmentsForEntity(profile, id);
  return repo.reviseEntity(id, version, {...note.payload, source_file:note.payload.source_file || files[0].name,
    source_files:[...previous.map(f => f.name), ...files.map(f => f.name)]}, "Добавлены вложения");
}
export async function materializeAttachment() { throw new Error("Native thumbnail decoding requires Android."); }
