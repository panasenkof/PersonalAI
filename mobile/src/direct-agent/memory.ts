import { localMemoryRepository } from "../local-memory/repository";
import type { MemoryRepository } from "../local-memory/types";
import { ensureSections, orderCollections } from "../local-memory/sections";
import { VECTOR_MODEL } from "../local-memory/vectors";
import { normalizeAlias as normalizeName } from "../local-memory/search-index";
import { DEFAULT_SECTIONS, PROPOSABLE_KINDS, findSection, proposableSections } from "./fact-tool";
import type { MemorySection, NoteProposal } from "./fact-tool";

/** `section` is the name of the memory section the note lives in. */
export type MemorySnippet = { id: string; title: string; body: string; section?: string };
export { FACT_TOOL_NAME, KIND_NAMES, PROPOSABLE_KINDS, factProposal } from "./fact-tool";
export type { MemorySection, NoteProposal, ProposableKind } from "./fact-tool";

/** The user's sections the assistant may propose records for, including the
 * ones the user created. Read-only: a built-in section that does not exist yet
 * is listed anyway and created only when a record is saved into it. */
export async function proposableMemorySections(profile: string, repository?: MemoryRepository): Promise<MemorySection[]> {
  const db = repository || await localMemoryRepository(profile);
  const collections = orderCollections(await db.listCollections());
  const existing = proposableSections(collections);
  const missing = DEFAULT_SECTIONS.filter(d => !collections.some(c => c.slug === d.slug));
  const builtin = (slug: string) => DEFAULT_SECTIONS.findIndex(d => d.slug === slug);
  return [...existing, ...missing].sort((a, b) => (builtin(a.slug) < 0 ? 99 : builtin(a.slug)) - (builtin(b.slug) < 0 ? 99 : builtin(b.slug)));
}

/** A word without its Russian ending; the search itself lives in local-memory/query. */
export { wordStem } from "../local-memory/query";

/** Searches every way available, most specific first: the whole phrase, each
 * keyword, then each keyword's stem so other word forms match, over titles,
 * text, index words and names. Records found by more of these searches rank
 * higher. Only active records in standard sections may leave the device; a
 * long record sends the chunk that matched, not its beginning. */
export type QueryEmbedder = (text: string) => Promise<Float32Array | null>;
/** On the phone the question is also compared by meaning, when the model is downloaded. */
const deviceEmbedder: QueryEmbedder = text => (require("../media/embedder") as typeof import("../media/embedder")).embedQuery(text);

export async function searchApprovedNotes(
  profile: string,
  query: string,
  repository?: MemoryRepository,
  embed: QueryEmbedder | undefined = repository ? undefined : deviceEmbedder,
): Promise<MemorySnippet[]> {
  if (query.trim().length < 2) return [];
  const db = repository || await localMemoryRepository(profile);
  const collections = await db.listCollections();
  // Only explicitly standard collections may leave the device. Never share
  // unclassified, sensitive or secret content through cloud-model tools.
  const standards = collections.filter(c => c.sensitivity === "standard").map(c => c.id);
  if (!standards.length) return [];
  const values = embed ? await embed(query.trim().slice(0, 500)).catch(() => null) : null;
  const hits = await db.searchMemory(query, { collectionIds: standards, sensitivities: ["standard", "inherit"], limit: 5,
    ...(values ? { vector: { model: VECTOR_MODEL, values } } : {}) });
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
  let col = proposal.section ? all.find(c => c.slug === proposal.section) : undefined;
  const requested = proposal.newSection?.trim().slice(0, 60);
  if (!col && requested) {
    // The user confirmed a section that did not exist when it was proposed;
    // it may have been created since, so look it up by name first.
    const existing = findSection(requested, all.map(c => ({ slug: c.slug, name: c.name })));
    col = existing ? all.find(c => c.slug === existing.slug) :
      await db.createCollection({ name: requested, slug: "section-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), sensitivity: "standard" });
  }
  col ||= all.find(c => c.slug === "notes");
  if (!col) throw new Error("Раздел для заметки не найден");
  // A proposal may land in a personal section (e.g. documents) but never in a
  // secret or unclassified one: those are only filled by the user directly.
  if (col.sensitivity !== "standard" && col.sensitivity !== "sensitive") throw new Error("Раздел «" + col.name + "» ограничен по доступу");
  const kind = proposal.kind && (PROPOSABLE_KINDS as readonly string[]).includes(proposal.kind) ? proposal.kind : undefined;
  const saved = await db.createEntity({
    collection_id: col.id, domain: "notes", title,
    payload: { type: "note", title, body, ...(proposal.date ? { date: proposal.date } : {}) },
    sensitivity: col.sensitivity, source_kind: "user", source_ref: "device-approved-agent",
    ...(kind ? { kind } : {}),
    ...(proposal.date ? { valid_from: proposal.date } : {}),
  });
  const person = proposal.person?.trim();
  // A fact about someone is linked to that person's record; a person seen for
  // the first time gets a record in «Люди», saved with the same confirmation.
  if (person && kind !== "person") {
    let target = (await db.entitiesByAlias(person, "person"))[0];
    if (!target) {
      const people = all.find(c => c.slug === "people");
      if (people) target = await db.createEntity({ collection_id: people.id, domain: "notes", title: person.slice(0, 160),
        payload: { type: "note", title: person.slice(0, 160), body: "" }, sensitivity: people.sensitivity === "standard" ? "standard" : "inherit",
        source_kind: "user", source_ref: "device-approved-agent", kind: "person" });
    }
    if (target && target.id !== saved.id) await db.linkEntities(saved.id, target.id, "about");
  } else if (person && kind === "person") {
    if (normalizeName(person) !== normalizeName(title)) await db.setAliases(saved.id, [person]);
  }
  return saved.id;
}
