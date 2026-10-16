/** The assistant's only memory-writing tool: it proposes one record, which is
 * saved only after the user confirms it. Pure: no storage imports. */
import { SECTIONS, sectionBySlug } from "../local-memory/sections";
import { isMemoryKind } from "../local-memory/search-index";
import type { MemoryKind } from "../local-memory/search-index";
import type { CollectionRecord } from "../local-memory/types";

/** `section` is the slug of an existing section (built-in or the user's own);
 * `newSection` is the name of a section the user asked for that does not exist
 * yet — it is created only when the user saves the proposal. `kind` is the
 * record type, `person` who the fact is about, `date` the day (YYYY-MM-DD). */
export type NoteProposal = {
  title: string; body: string; section?: string; newSection?: string;
  kind?: ProposableKind; person?: string; date?: string;
};
/** A section the assistant may propose a record for. */
export type MemorySection = { slug: string; name: string; hint?: string; own?: boolean };

/** «Документ» is never proposed: documents are entered by the user only. */
export const PROPOSABLE_KINDS = ["fact", "person", "event", "preference", "note"] as const;
export type ProposableKind = typeof PROPOSABLE_KINDS[number];
export const KIND_NAMES: Record<MemoryKind, string> = {
  fact: "Факт", person: "Человек", event: "Событие", preference: "Предпочтение", document: "Документ", note: "Заметка",
};
export const FACT_TOOL_NAME = "draft_memory_fact";
export const FACT_TOOL_DESCRIPTION = "Предложить пользователю одну запись в памяти — один факт, человек, событие или предпочтение; " +
  "никогда не сохраняет автоматически, только после подтверждения пользователя.";

/** Built-in sections without «Документы»: used before the user's list is known. */
export const DEFAULT_SECTIONS: MemorySection[] = SECTIONS.filter(s => s.slug !== "documents")
  .map(s => ({ slug: s.slug, name: s.name, hint: s.hint }));
/** Sections a proposal may go to: built-in and the user's own, ordinary or
 * personal, but never «Документы» and never secret or unclassified ones. */
export function proposableSections(collections: CollectionRecord[]): MemorySection[] {
  return collections.filter(c => c.slug !== "documents" && (c.sensitivity === "standard" || c.sensitivity === "sensitive"))
    .map(c => {
      const builtin = sectionBySlug(c.slug);
      return { slug: c.slug, name: c.name.slice(0, 60), ...(builtin ? { hint: builtin.hint } : { own: true, ...(c.description ? { hint: c.description.slice(0, 120) } : {}) }) };
    });
}

const NAME = /[«»"'„“”]/g;
const normalizeName = (value: string) => value.replace(NAME, "").replace(/ё/g, "е").replace(/Ё/g, "Е").replace(/\s+/g, " ").trim().toLowerCase();
/** The model may answer with a slug or a name; both find the section. */
export function findSection(value: string, sections: MemorySection[]): MemorySection | undefined {
  const key = normalizeName(value);
  return key ? sections.find(s => s.slug === value.trim() || normalizeName(s.name) === key) : undefined;
}
const isDocuments = (value: string) => ["documents", "документы", "документ"].includes(normalizeName(value));

/** Strict function schema: every field is required, absent values are null.
 * `section` is free text, so a section the user names can be proposed even if
 * it does not exist yet; the list of existing ones is in the description. */
export function factToolParameters(sections: MemorySection[] = DEFAULT_SECTIONS) {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "Коротко, о чём запись" },
      body: { type: "string", description: "Сам факт полным предложением" },
      section: { type: "string", description: "Название раздела памяти. Существующие: " + sections.map(s => "«" + s.name + "»").join(", ") +
        ". Если пользователь просит раздел, которого нет, — его название; приложение предложит создать" },
      kind: { type: "string", enum: PROPOSABLE_KINDS, description: "fact — факт о пользователе; person — запись о человеке; event — событие или дата; preference — что нравится или как отвечать; note — остальное" },
      person: { type: ["string", "null"], description: "Имя человека, о котором факт, если он не о самом пользователе; иначе null" },
      date: { type: ["string", "null"], description: "Дата события в виде ГГГГ-ММ-ДД, если она есть; иначе null" },
    },
    required: ["title", "body", "section", "kind", "person", "date"], additionalProperties: false,
  };
}
export const FACT_TOOL_PARAMETERS = factToolParameters();

/** What the system prompt says about the sections and the tool's fields. */
export function factGuide(sections: MemorySection[] = DEFAULT_SECTIONS): string {
  return "Разделы памяти пользователя: " + sections.map(s => "«" + s.name + "»" + (s.own ? " (создан пользователем)" : "") + (s.hint ? " — " + s.hint : "")).join("; ") + ". " +
    "При вызове " + FACT_TOOL_NAME + " укажи в section название раздела. Если пользователь назвал раздел — используй именно его, " +
    "в том числе созданный им самим; если такого раздела нет, укажи название, которое назвал пользователь, — приложение предложит создать раздел. " +
    "Укажи kind; если факт о другом человеке — его имя в person (например, «Аня»), дату события — в date. ";
}
export const FACT_GUIDE = factGuide();

const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().startsWith(value);
const text = (value: unknown, cap: number) => typeof value === "string" ? value.slice(0, cap).trim() : "";
function optional(args: Record<string, unknown>) {
  const person = text(args.person, 80).replace(/\s+/g, " ");
  return {
    ...(isMemoryKind(args.kind) && (PROPOSABLE_KINDS as readonly string[]).includes(args.kind) ? { kind: args.kind as ProposableKind } : {}),
    ...(person && person.toLowerCase() !== "null" ? { person } : {}),
    ...(validDate(args.date) ? { date: args.date } : {}),
  };
}

/** Arguments of `draft_memory_fact` (or the older `draft_local_note`) from a
 * model; anything unexpected is dropped, never trusted. «Документы» are never
 * a target, even if a model names them. */
export function factProposal(args: Record<string, unknown>, sections: MemorySection[] = DEFAULT_SECTIONS): NoteProposal {
  const title = text(args.title, 160), body = text(args.body, 4000);
  if (!title && !body) throw new Error("empty_note");
  const requested = text(args.section, 80);
  const found = requested && !isDocuments(requested) ? findSection(requested, sections) : undefined;
  const fresh = requested && !found && !isDocuments(requested) && !/^null$/i.test(requested) ? requested.replace(NAME, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { title, body, ...(found ? { section: found.slug } : fresh ? { newSection: fresh } : {}), ...optional(args) };
}

/** A proposal saved in a conversation: the section was resolved when it was
 * made, so it is only re-validated, never looked up again. */
export function restoredProposal(value: Record<string, unknown>): Omit<NoteProposal, "title" | "body"> {
  const section = typeof value.section === "string" && /^[a-z0-9-]{1,80}$/.test(value.section) && value.section !== "documents" ? value.section : undefined;
  const newSection = text(value.newSection, 60);
  return { ...(section ? { section } : {}), ...(newSection ? { newSection } : {}), ...optional(value) };
}
