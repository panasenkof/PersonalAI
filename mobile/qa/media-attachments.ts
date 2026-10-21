import { localMemoryRepository } from "../src/local-memory/repository";
import { mediaKind } from "../src/media/kinds";
import type { ImportFile } from "../src/media/kinds";

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
    extractedText?: string;
    collectionId?: string;
    title: string;
    body: string;
    sensitivity: "sensitive" | "standard";
  },
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Сохранение файла остановлено.");
  const kind = input.file ? mediaKind(input.file) : undefined;
  const repo = await localMemoryRepository(profile);
  let collection = (await repo.listCollections()).find((item: { slug: string }) => item.slug === "notes");
  if (!collection) collection = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
  if (signal?.aborted) throw new Error("Сохранение файла остановлено.");
  const title = input.title.trim().slice(0, 160) || input.file?.name || "Материал";
  const entity = await repo.createEntity({
    collection_id: collection.id,
    domain: "notes",
    title,
    payload: { type: "note", title, body: input.body.trim(), extracted_text: input.extractedText || "", source_file: input.file?.name, source_media: kind },
    sensitivity: input.sensitivity,
    source_kind: "user",
    source_ref: "device-import",
  });
  return entity.id;
}
