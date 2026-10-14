import { localMemoryRepository } from "../local-memory/repository";
import type { EntityRecord, MemoryRepository } from "../local-memory/types";
import { ensureSections, isSectionSlug } from "../local-memory/sections";
import type { SectionSlug } from "../local-memory/sections";

/** `section` is the name of the memory section the note lives in. */
export type MemorySnippet = { id: string; title: string; body: string; section?: string };
/** `section` is a built-in section slug; unknown or missing means "notes". */
export type NoteProposal = { title: string; body: string; section?: SectionSlug };

export async function searchApprovedNotes(
  profile: string,
  query: string,
  repository?: MemoryRepository,
): Promise<MemorySnippet[]> {
  const q = query.trim().slice(0, 120);
  if (q.length < 2) return [];
  const db = repository || await localMemoryRepository(profile);
  const collections = await db.listCollections();
  // Only explicitly standard collections may leave the device. Never share
  // unclassified, sensitive or secret content through cloud-model tools.
  const standards = new Set(collections.filter(c => c.sensitivity === "standard").map(c => c.id));
  const stop = new Set(["что", "как", "где", "мне", "меня", "мой", "мои", "моих", "для", "это", "найди", "пожалуйста", "расскажи", "помоги", "интернет", "интернете"]);
  const words = q.toLowerCase().split(/[\s,.;!?]+/u).filter(s => s.length >= 3 && !stop.has(s));
  const aboutMe = /(?:помнишь|знаешь).*(?:обо? мне|про меня)/iu.test(q);
  const terms = aboutMe ? [""] : [q, ...words.slice(0, 6)];
  const seen = new Set<string>();
  const snippets: MemorySnippet[] = [];
  for (const term of terms) {
    // searchNotes uses safe, parameterized FTS and returns device-local data.
    const matches: EntityRecord[] = await db.searchNotes(term, 8);
    for (const note of matches) {
      if (seen.has(note.id) || !standards.has(note.collection_id) ||
          note.record_status !== "active" ||
          !["standard", "inherit"].includes(note.sensitivity)) continue;
      seen.add(note.id);
      const section = collections.find(c => c.id === note.collection_id)?.name;
      snippets.push({
        id: note.id,
        title: String(note.title || "").slice(0, 160),
        body: String(note.payload.body || "").slice(0, 900),
        ...(section ? { section: section.slice(0, 60) } : {}),
      });
      if (snippets.length >= 5) return snippets;
    }
  }
  return snippets;
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
