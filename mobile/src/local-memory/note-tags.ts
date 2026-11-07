/** Explicit, user-owned labels for a canonical note. Not an LLM classifier.
 * Stored ONLY in memory_entities.payload_json, derived into the existing FTS.
 * The encrypted database export includes payload_json; restore rebuilds FTS.
 */
export const MAX_NOTE_TAGS = 12;
export const MAX_NOTE_TAG_LENGTH = 32;
const VALID_TAG = /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u;

function canonicalTag(raw: string): string {
  return raw.trim().replace(/^#/, "").normalize("NFC").toLocaleLowerCase("ru-RU");
}

/** UI entry: comma or whitespace separated #labels. Never inspect note text
 * or URLs to infer tags; saving anything requires the usual Save action.
 */
export function parseNoteTagsInput(value: string): string[] {
  if (!value.trim()) return [];
  const pieces = value.split(/[\s,;]+/u).filter(Boolean);
  if (pieces.length > MAX_NOTE_TAGS)
    throw new Error("Не более 12 тегов на заметку.");
  const tags = pieces.map(canonicalTag);
  if (tags.some(t => !t || t.length > MAX_NOTE_TAG_LENGTH || !VALID_TAG.test(t)))
    throw new Error("Тег: до 32 букв или цифр, допустимы _ и -. Укажите теги через пробел или запятую.");
  return [...new Set(tags)].sort();
}

/** Host-side validation for calls from any importer, not only the UI. */
export function checkedNoteTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTE_TAGS ||
      value.some(x => typeof x !== "string" || !x || x.length > MAX_NOTE_TAG_LENGTH + 1))
    throw new Error("Неверные теги заметки.");
  const normalized = value.map(x => canonicalTag(x as string));
  if (normalized.some(t => !t || t.length > MAX_NOTE_TAG_LENGTH || !VALID_TAG.test(t)))
    throw new Error("Неверные теги заметки.");
  return [...new Set(normalized)].sort();
}

/** Malformed legacy/user-restored data must never be fed into FTS. */
export function noteTagsFromPayload(value: unknown): string[] {
  try { return checkedNoteTags(value); }
  catch { return []; }
}

/** For the user-owned draft, not for hidden runtime classification. */
export function noteTagsDraft(value: unknown): string {
  return noteTagsFromPayload(value).map(t => "#" + t).join(" ");
}
