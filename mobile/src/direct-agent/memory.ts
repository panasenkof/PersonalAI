import { localMemoryRepository } from "../local-memory/repository";
import type { EntityRecord, MemoryRepository } from "../local-memory/types";
import { ensureSections, isSectionSlug } from "../local-memory/sections";
import type { SectionSlug } from "../local-memory/sections";

/** `section` is the name of the memory section the note lives in. */
export type MemorySnippet = { id: string; title: string; body: string; section?: string };
/** `section` is a built-in section slug; unknown or missing means "notes". */
export type NoteProposal = { title: string; body: string; section?: SectionSlug };

const STOP_WORDS = new Set(["что", "как", "где", "когда", "кто", "чем", "мне", "меня", "мой", "моя", "моё", "мои", "моих", "моей", "моего",
  "для", "это", "эта", "этот", "эти", "найди", "найти", "пожалуйста", "расскажи", "напомни", "помоги", "подскажи", "скажи", "знаешь", "помнишь",
  "интернет", "интернете", "есть", "был", "была", "было", "про", "при", "или", "его", "её", "них", "там", "тут", "так", "уже", "ещё", "еще", "мы", "вы", "ты"]);
// Longest first, so «ами» is removed before «и».
const RU_ENDINGS = ["иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ость", "ах", "ях", "ам", "ям", "ов", "ев", "ей", "ой", "ий", "ый",
  "ая", "яя", "ое", "ее", "ые", "ие", "ую", "юю", "ом", "ем", "ть", "ся", "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й"];

/** A word without its Russian ending, for prefix search («машину» → «машин»). */
export function wordStem(word: string): string {
  const w = word.toLowerCase();
  if (!/[а-яё]/.test(w)) return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
  for (const ending of RU_ENDINGS) {
    if (w.endsWith(ending) && w.length - ending.length >= 3) return w.slice(0, -ending.length);
  }
  return w;
}

/** Searches every way available, most specific first: the whole phrase, each
 * keyword, then each keyword's stem so other word forms match. Notes found by
 * more of these searches rank higher. Only active notes in standard sections
 * may leave the device. */
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
  const words = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(s => s.length >= 3 && !STOP_WORDS.has(s)))].slice(0, 6);
  const aboutMe = /(?:помнишь|знаешь|расскажи).*(?:обо? мне|про меня)|кто я\b/iu.test(q);
  const searches: Array<{ term: string; prefix: boolean; weight: number }> = aboutMe
    ? [{ term: "", prefix: false, weight: 1 }]
    : [
        { term: q, prefix: false, weight: 4 },
        ...words.map(w => ({ term: w, prefix: false, weight: 2 })),
        ...words.map(w => ({ term: wordStem(w), prefix: true, weight: 1 })).filter(s => s.term.length >= 3),
      ];
  const scored = new Map<string, { note: EntityRecord; score: number; order: number }>();
  for (const search of searches) {
    // searchNotes uses safe, parameterized FTS and returns device-local data.
    const matches: EntityRecord[] = await db.searchNotes(search.term, 8, 0, search.prefix ? { prefix: true } : undefined);
    for (const note of matches) {
      if (!standards.has(note.collection_id) || note.record_status !== "active" ||
          !["standard", "inherit"].includes(note.sensitivity)) continue;
      const found = scored.get(note.id);
      if (found) found.score += search.weight;
      else scored.set(note.id, { note, score: search.weight, order: scored.size });
    }
  }
  return [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 5).map(({ note }) => {
    const section = collections.find(c => c.id === note.collection_id)?.name;
    return {
      id: note.id,
      title: String(note.title || "").slice(0, 160),
      body: String(note.payload.body || "").slice(0, 900),
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
