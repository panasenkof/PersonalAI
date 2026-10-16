/** The assistant's only memory-writing tool: it proposes one record, which is
 * saved only after the user confirms it. Pure: no storage imports. */
import { PROPOSABLE_SECTIONS, isSectionSlug, sectionGuide } from "../local-memory/sections";
import type { SectionSlug } from "../local-memory/sections";
import { isMemoryKind } from "../local-memory/search-index";
import type { MemoryKind } from "../local-memory/search-index";

/** `section` is a built-in section slug; unknown or missing means "notes".
 * `kind` is the record type, `person` the name of who the fact is about and
 * `date` the day it happened or happens (YYYY-MM-DD). */
export type NoteProposal = { title: string; body: string; section?: SectionSlug; kind?: ProposableKind; person?: string; date?: string };

/** «Документ» is never proposed: documents are entered by the user only. */
export const PROPOSABLE_KINDS = ["fact", "person", "event", "preference", "note"] as const;
export type ProposableKind = typeof PROPOSABLE_KINDS[number];
export const KIND_NAMES: Record<MemoryKind, string> = {
  fact: "Факт", person: "Человек", event: "Событие", preference: "Предпочтение", document: "Документ", note: "Заметка",
};
export const FACT_TOOL_NAME = "draft_memory_fact";
export const FACT_TOOL_DESCRIPTION = "Предложить пользователю одну запись в памяти — один факт, человек, событие или предпочтение; " +
  "никогда не сохраняет автоматически, только после подтверждения пользователя.";
/** Strict function schema: every field is required, absent values are null. */
export const FACT_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    title: { type: "string", description: "Коротко, о чём запись" },
    body: { type: "string", description: "Сам факт полным предложением" },
    section: { type: "string", enum: PROPOSABLE_SECTIONS, description: "Раздел памяти для записи" },
    kind: { type: "string", enum: PROPOSABLE_KINDS, description: "fact — факт о пользователе; person — запись о человеке; event — событие или дата; preference — что нравится или как отвечать; note — остальное" },
    person: { type: ["string", "null"], description: "Имя человека, о котором факт, если он не о самом пользователе; иначе null" },
    date: { type: ["string", "null"], description: "Дата события в виде ГГГГ-ММ-ДД, если она есть; иначе null" },
  },
  required: ["title", "body", "section", "kind", "person", "date"], additionalProperties: false,
};

const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().startsWith(value);

/** Arguments of `draft_memory_fact` (or the older `draft_local_note`) from a
 * model; anything unexpected is dropped, never trusted. */
export function factProposal(args: Record<string, unknown>): NoteProposal {
  const text = (value: unknown, cap: number) => typeof value === "string" ? value.slice(0, cap).trim() : "";
  const title = text(args.title, 160), body = text(args.body, 4000);
  if (!title && !body) throw new Error("empty_note");
  const person = text(args.person, 80).replace(/\s+/g, " ");
  return {
    title, body,
    ...(isSectionSlug(args.section) ? { section: args.section } : {}),
    ...(isMemoryKind(args.kind) && (PROPOSABLE_KINDS as readonly string[]).includes(args.kind) ? { kind: args.kind as ProposableKind } : {}),
    ...(person && person.toLowerCase() !== "null" ? { person } : {}),
    ...(validDate(args.date) ? { date: args.date } : {}),
  };
}

/** What the system prompt says about the tool's fields. */
export const FACT_GUIDE = "При вызове " + FACT_TOOL_NAME + " выбери section: " + sectionGuide() + ". " +
  "Укажи kind; если факт о другом человеке — его имя в person (например, «Аня»), дату события — в date. ";
