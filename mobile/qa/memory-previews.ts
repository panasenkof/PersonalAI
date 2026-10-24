// The browser cannot decrypt SQLCipher attachments. Keep metadata truthful for
// the browser fixture; native decoding/lifetime is covered by separate tests.
import { localMemoryRepository } from "../src/local-memory/repository";
export async function attachmentsForEntity(profile: string, id: string) {
  const note = await (await localMemoryRepository(profile)).entity(id);
  return typeof note?.payload.source_file === "string"
    ? [{ id: id + "-file", entity_id: id, name: note.payload.source_file, mime: "text/plain", size: 100 }]
    : [];
}
export async function materializeAttachment() { throw new Error("Native thumbnail decoding requires Android."); }
