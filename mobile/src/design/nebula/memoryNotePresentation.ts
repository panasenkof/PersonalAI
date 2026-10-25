import { parseMarkdown } from "../../components/markdown-parse";
import type { EntityRecord } from "../../local-memory/types";

/** Small-screen previews never discard the full stored note or extracted text. */
export function memoryNotePreview(note: Pick<EntityRecord, "payload">): string {
  const body = note.payload?.body;
  const extracted = note.payload?.extracted_text;
  const source = typeof body === "string" && body.trim() ? body :
    typeof extracted === "string" ? extracted : "";
  return memoryPlainText(source);
}

/** Treat an invalid legacy timestamp as an absent date rather than showing "Invalid Date". */
export function memoryNoteDate(timestamp: string): string {
  const date = Date.parse(timestamp);
  return Number.isFinite(date) ? new Date(date).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" }) : "";
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

export function memoryPlainText(source: string): string {
  return parseMarkdown(source).map(b => "spans" in b ? b.spans.map(s => s.text).join("") : b.kind === "code" ? b.text : "").join(" ").replace(/\s+/g, " ").trim();
}
/** Presentation only; never replace the stored title or source filename. */
export function memoryDisplayTitle(note: Pick<EntityRecord, "title" | "payload">): string {
  const title = note.title?.trim() || "";
  const file = typeof note.payload.source_file === "string" ? note.payload.source_file : "";
  if (!title || title === file || (!file && /\.(jpg|jpeg|png|heic|webp|m4a|mp3|pdf|txt|docx|mp4)$/i.test(title))) {
    const body = typeof note.payload.body === "string" && note.payload.body.trim() ? note.payload.body : typeof note.payload.extracted_text === "string" ? note.payload.extracted_text : "";
    const first = memoryPlainText(body.split("\n").find(line => line.trim()) || "");
    if (first) return first.slice(0, 160);
    if (title) return title.replace(/\.[^.]+$/, "").replace(/_+/g, " ");
  }
  return memoryPlainText(title) || "Без названия";
}
