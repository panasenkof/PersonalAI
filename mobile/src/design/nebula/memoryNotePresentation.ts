import type { EntityRecord } from "../../local-memory/types";

/** Small-screen previews never discard the full stored note or extracted text. */
export function memoryNotePreview(note: Pick<EntityRecord, "payload">): string {
  const body = note.payload?.body;
  const extracted = note.payload?.extracted_text;
  const source = typeof body === "string" && body.trim() ? body :
    typeof extracted === "string" ? extracted : "";
  return source.replace(/\s+/g, " ").trim();
}

/** Treat an invalid legacy timestamp as an absent date rather than showing "Invalid Date". */
export function memoryNoteDate(timestamp: string): string {
  const date = Date.parse(timestamp);
  return Number.isFinite(date) ? new Date(date).toLocaleDateString() : "";
}

/** Metadata only: never decrypt attachments or load remote previews while listing notes. */
export function memoryNoteType(note: Pick<EntityRecord, "payload" | "kind">): { label: string; icon: "image" | "music" | "video" | "file-text" | "link" | "user" | "calendar" | "heart" | "edit-3" } {
  if (typeof note.payload.source_file === "string" && note.payload.source_file.trim()) {
    switch (note.payload.source_media) {
      case "image": return { label: "Фото", icon: "image" };
      case "audio": return { label: "Аудио", icon: "music" };
      case "video": return { label: "Видео", icon: "video" };
      default: return { label: "Файл", icon: "file-text" };
    }
  }
  if (typeof note.payload.source_url === "string" && note.payload.source_url.trim()) return { label: "Ссылка", icon: "link" };
  switch (note.kind) {
    case "person": return { label: "Человек", icon: "user" };
    case "event": return { label: "Событие", icon: "calendar" };
    case "preference": return { label: "Предпочтение", icon: "heart" };
    case "document": return { label: "Документ", icon: "file-text" };
    default: return { label: "Заметка", icon: "edit-3" };
  }
}

export function memoryNoteHasPhoto(note: Pick<EntityRecord, "payload">): boolean {
  return note.payload.source_media === "image" ||
    (Array.isArray(note.payload.source_media_types) && note.payload.source_media_types.includes("image"));
}
