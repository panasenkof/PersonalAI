import { memoryDisplayTitle } from "../design/nebula/memoryNotePresentation";
import { localMemoryRepository, SqliteMemoryRepository } from "../local-memory/repository";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import type { MemoryRepository } from "../local-memory/types";
import { ensureSections, orderCollections } from "../local-memory/sections";
import { VECTOR_MODEL } from "../local-memory/vectors";
import { memoryText, normalizeAlias as normalizeName } from "../local-memory/search-index";
import { DEFAULT_SECTIONS, MAX_NOTE_BODY_CHARS, PROPOSABLE_KINDS, findSection, proposableSections } from "./fact-tool";
import type { MemorySection, NoteProposal } from "./fact-tool";

/** `section` is the name of the memory section the note lives in. */
export type MemorySnippet = { id: string; title: string; body: string; section?: string; version?: number; excerptOnly?: boolean; totalChars?: number };
/** Return complete ordinary notes when possible, but bound the total data sent to an external LLM. */
const FULL_NOTE_CHARS = 12_000;
const MAX_CONTEXT_NOTE_CHARS = 24_000;
const EXCERPT_CHARS = 900;
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
  const allowed = hits.filter(({ entity }) => standards.includes(entity.collection_id) && entity.record_status === "active" &&
    ["standard", "inherit"].includes(entity.sensitivity));
  let remaining = MAX_CONTEXT_NOTE_CHARS;
  return allowed.map(({ entity, chunk }, index) => {
    const section = collections.find(c => c.id === entity.collection_id)?.name;
    const body = memoryText(entity.payload);
    // Reserve room for the matching excerpt of every later result, even if the
    // first notes are long. Never present an excerpt as the complete stored note.
    const available = Math.max(0, remaining - (allowed.length - index - 1) * EXCERPT_CHARS);
    const complete = body.length <= FULL_NOTE_CHARS && body.length <= available;
    const text = complete ? body : (chunk || body).slice(0, Math.min(EXCERPT_CHARS, available));
    remaining -= text.length;
    return {
      id: entity.id,
      ...(typeof entity.record_version === "number" ? { version: entity.record_version } : {}),
      title: memoryDisplayTitle(entity).slice(0, 160),
      body: text,
      ...(complete ? {} : { excerptOnly: true, totalChars: body.length }),
      ...(section ? { section: section.slice(0, 60) } : {}),
    };
  });
}

export type ReadMemoryEvidence = {
  id: string; revision: number; title: string; content: string;
  offset: number; totalChars: number; hasMore: boolean; nextOffset?: number;
  source: { recordId: string; sourceRef: string | null; location: "unknown" };
  /** Proven byte-free locator in the record-text projection (NOT PDF page). */
  evidence: { recordId: string; recordVersion: number; startChar: number; endChar: number;
    coverage: "excerpt" | "complete"; originalPage: null; originalTime: null };
};

/** Read a stable, bounded range of an allowed note. Runs on one SQLCipher lease,
 * independently checks scope/lock and refuses stale version from a search hit. */
export async function readApprovedNote(
  profile: string, id: string, expectedVersion: number, offset = 0, requestedChars = 4000,
  repository?: MemoryRepository,
): Promise<ReadMemoryEvidence> {
  if (!id || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 2_000_000 ||
      !Number.isSafeInteger(requestedChars) || requestedChars < 1) {
    throw new Error("invalid_memory_read_request");
  }
  const read = async (db: MemoryRepository): Promise<ReadMemoryEvidence> => {
    const entity = await db.entity(id);
    if (!entity || entity.record_status !== "active" || entity.domain !== "notes" ||
        !["standard", "inherit"].includes(entity.sensitivity)) {
      throw new Error("memory_read_not_available");
    }
    const collection = (await db.listCollections()).find(c => c.id === entity.collection_id);
    if (!collection || collection.sensitivity !== "standard") throw new Error("memory_read_not_available");
    if (entity.record_version !== expectedVersion) throw new Error("stale_memory_version");
    const body = memoryText(entity.payload);
    if (offset > body.length) throw new Error("invalid_memory_read_range");
    const count = Math.min(6000, requestedChars);
    const content = body.slice(offset, offset + count);
    const nextOffset = offset + content.length;
    return {
      id: entity.id, revision: entity.record_version,
      title: memoryDisplayTitle(entity).slice(0, 160),
      content, offset, totalChars: body.length, hasMore: nextOffset < body.length,
      ...(nextOffset < body.length ? { nextOffset } : {}),
      source: { recordId: entity.id, sourceRef: entity.source_ref, location: "unknown" },
      evidence: { recordId: entity.id, recordVersion: entity.record_version,
        startChar: offset, endChar: nextOffset,
        coverage: offset === 0 && nextOffset >= body.length ? "complete" : "excerpt",
        originalPage: null, originalTime: null },
    };
  };
  if (repository) return read(repository);
  return withLocalMemoryDatabase(profile, db => read(new SqliteMemoryRepository(db)));
}

export async function saveApprovedNote(
  profile: string, proposal: NoteProposal, repository?: MemoryRepository,
): Promise<string> {
  const title = proposal.title.trim().slice(0, 160);
  const body = proposal.body.trim();
  if (body.length > MAX_NOTE_BODY_CHARS) throw new Error("Заметка слишком длинная (максимум 60 000 символов). Разделите её на части.");
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
