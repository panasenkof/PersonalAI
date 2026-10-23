import { localMemoryRepository } from "../src/local-memory/repository";
import { mediaKind } from "../src/media/kinds";
import type { ImportFile } from "../src/media/kinds";

// Browser adapter must expose the real module’s UI contract.
export const MAX_ORIGINALS_PER_NOTE = 10;
export const MAX_TOTAL_ORIGINAL_BYTES = 80 * 1024 * 1024;

/**
 * Browser-only replacement for native SQLCipher original-file persistence.
 *
 * The real saveMediaNote writes an Expo File into SQLCipher, which a browser
 * fixture cannot do. Keep the UI flow real (pick -> extract -> save -> list),
 * backed by the QA repository. Native persistence is tested separately.
 */
export async function saveMediaNote(
  profile: string,
  input: {
    file?: ImportFile;
    files?: ImportFile[];
    extractedText?: string;
    collectionId?: string;
    title: string;
    body: string;
    sensitivity: "sensitive" | "standard";
  },
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Сохранение файла остановлено.");
  const originals = input.files ?? (input.file ? [input.file] : []);
  if (originals.length > MAX_ORIGINALS_PER_NOTE || originals.reduce((size, f) => size + (f.size || 0), 0) > MAX_TOTAL_ORIGINAL_BYTES) throw new Error("Превышен лимит вложений.");
  const kind = originals[0] ? mediaKind(originals[0]) : undefined;
  const repo = await localMemoryRepository(profile);
  let collection = (await repo.listCollections()).find((item: { slug: string }) => item.slug === "notes");
  if (!collection) collection = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  if (signal?.aborted) throw new Error("Сохранение файла остановлено.");
  const title = input.title.trim().slice(0, 160) || originals[0]?.name || "Материал";
  const entity = await repo.createEntity({
    collection_id: collection.id,
    domain: "notes",
    title,
    payload: { type: "note", title, body: input.body.trim(), extracted_text: input.extractedText || "", source_file: originals[0]?.name, source_media: kind, ...(originals.length > 1 ? { source_files: originals.map(f => f.name) } : {}) },
    sensitivity: input.sensitivity,
    source_kind: "user",
    source_ref: "device-import",
  });
  return entity.id;
}
