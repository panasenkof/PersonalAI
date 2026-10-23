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
