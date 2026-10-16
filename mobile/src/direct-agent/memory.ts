import { localMemoryRepository } from "../local-memory/repository";
import type { MemoryRepository } from "../local-memory/types";
import { ensureSections, isSectionSlug } from "../local-memory/sections";
import type { SectionSlug } from "../local-memory/sections";

/** `section` is the name of the memory section the note lives in. */
export type MemorySnippet = { id: string; title: string; body: string; section?: string };
/** `section` is a built-in section slug; unknown or missing means "notes". */
export type NoteProposal = { title: string; body: string; section?: SectionSlug };

/** A word without its Russian ending; the search itself lives in local-memory/query. */
export { wordStem } from "../local-memory/query";

/** Searches every way available, most specific first: the whole phrase, each
 * keyword, then each keyword's stem so other word forms match, over titles,
 * text, index words and names. Records found by more of these searches rank
 * higher. Only active records in standard sections may leave the device; a
 * long record sends the chunk that matched, not its beginning. */
export async function searchApprovedNotes(
  profile: string,
  query: string,
  repository?: MemoryRepository,
): Promise<MemorySnippet[]> {
  if (query.trim().length < 2) return [];
  const db = repository || await localMemoryRepository(profile);
  const collections = await db.listCollections();
  // Only explicitly standard collections may leave the device. Never share
  // unclassified, sensitive or secret content through cloud-model tools.
  const standards = collections.filter(c => c.sensitivity === "standard").map(c => c.id);
  if (!standards.length) return [];
  const hits = await db.searchMemory(query, { collectionIds: standards, sensitivities: ["standard", "inherit"], limit: 5 });
  return hits.filter(({ entity }) => standards.includes(entity.collection_id) && entity.record_status === "active" &&
    ["standard", "inherit"].includes(entity.sensitivity)).map(({ entity, chunk }) => {
    const section = collections.find(c => c.id === entity.collection_id)?.name;
    const body = String(entity.payload.body || "");
    return {
      id: entity.id,
      title: String(entity.title || "").slice(0, 160),
      body: (body.length <= 900 || !chunk ? body : chunk).slice(0, 900),
      ...(section ? { section: section.slice(0, 60) } : {}),
    };
  });
}

export async function saveApprovedNote(
  profile: string, proposal: NoteProposal, repository?: MemoryRepository,
): Promise<string> {
  const title = proposal.title.trim().slice(0, 160);
  const body = proposal.body.trim().slice(0, 4000);
  if (!title && !body) throw new Error("Пустую заметку сохранить нельзя");
  const db = repository || await localMemoryRepository(profile);
  const all = await ensureSections(db);
  const slug = isSectionSlug(proposal.section) ? proposal.section : "notes";
  const col = all.find(c => c.slug === slug) || all.find(c => c.slug === "notes");
  if (!col) throw new Error("Раздел для заметки не найден");
  // A proposal may land in a personal section (e.g. documents) but never in a
  // secret or unclassified one: those are only filled by the user directly.
  if (col.sensitivity !== "standard" && col.sensitivity !== "sensitive") throw new Error("Раздел «" + col.name + "» ограничен по доступу");
  const saved = await db.createEntity({
    collection_id: col.id, domain: "notes", title,
    payload: { type: "note", title, body },
    sensitivity: col.sensitivity, source_kind: "user", source_ref: "device-approved-agent",
  });
  return saved.id;
}
