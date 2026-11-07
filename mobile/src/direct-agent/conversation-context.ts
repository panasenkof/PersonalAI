import type { MemorySection } from "./fact-tool";

/** A semantic label for the dialogue, NOT the ACL of any memory record. */
export type ConversationContext = { topic: string; sectionSlug: string | null; pinned: boolean };
/** Pending LLM proposal: never a memory move or a confirmed source fact. */
export type ContextCandidate = { topic: string; sectionSlug: string | null; reason: string };
/** Immutable snapshot attached to the answer that caused a change. */
export type ContextChange = {
  topic: string; sectionSlug: string | null; previousTopic: string | null;
  previousSectionSlug: string | null; sectionName: string | null;
  previousSectionName: string | null; reason: string; at: string;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const safeTopic = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 2 && v.length <= 80 &&
  v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const safeSlug = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && SLUG.test(v) && v !== "documents");
const safeReason = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 2 && v.length <= 180 &&
  v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);

export function parseConversationContext(v: unknown): ConversationContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  return safeTopic(c.topic) && safeSlug(c.sectionSlug) &&
    typeof c.pinned === "boolean"
    ? { topic: c.topic, sectionSlug: c.sectionSlug, pinned: c.pinned } : undefined;
}

export function parseContextChange(v: unknown): ContextChange | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  if (!safeTopic(c.topic) || !safeSlug(c.sectionSlug) ||
      !(c.previousTopic === null || safeTopic(c.previousTopic)) ||
      !safeSlug(c.previousSectionSlug) ||
      !(c.sectionName === null || (typeof c.sectionName === "string" && c.sectionName.length <= 80)) ||
      !(c.previousSectionName === null || (typeof c.previousSectionName === "string" && c.previousSectionName.length <= 80)) ||
      !safeReason(c.reason) || typeof c.at !== "string" ||
      c.at.length > 40 || !Number.isFinite(Date.parse(c.at))) return undefined;
  return c as ContextChange;
}

export function validateContextCandidate(
  args: Record<string, unknown>, sections: readonly MemorySection[],
  previous?: ConversationContext,
): { candidate: ContextCandidate } | { error: string } {
  if (Object.keys(args).length !== 3 ||
    Object.keys(args).some(k => !["topic", "sectionSlug", "reason"].includes(k)) ||
    !safeTopic(args.topic) || !safeSlug(args.sectionSlug) ||
    !safeReason(args.reason)) return { error: "invalid_conversation_context" };
  const slug = args.sectionSlug as string | null;
  if (slug !== null && !sections.some(s => s.slug === slug && s.slug !== "documents"))
    return { error: "unknown_conversation_section" };
  if (previous?.pinned && slug !== previous.sectionSlug)
    return { error: "conversation_section_pinned" };
  return {candidate:{topic:args.topic as string,sectionSlug:slug,reason:args.reason as string}};
}

export function applyContextCandidate(
  previous: ConversationContext | undefined, candidate: ContextCandidate,
  sections: readonly MemorySection[], at: string,
): {context: ConversationContext; change?: ContextChange} | {error:string} {
  const checked = validateContextCandidate(candidate, sections, previous);
  if ("error" in checked) return {error:checked.error};
  const context: ConversationContext = {
    topic:candidate.topic,sectionSlug:candidate.sectionSlug,pinned:previous?.pinned || false,
  };
  if (previous?.topic === context.topic && previous.sectionSlug === context.sectionSlug)
    return {context};
  const name = (slug:string|null) => slug === null ? null :
    sections.find(s=>s.slug===slug)?.name.slice(0,80) || null;
  return {context,change:{
    topic:context.topic,sectionSlug:context.sectionSlug,
    previousTopic:previous?.topic || null,previousSectionSlug:previous?.sectionSlug || null,
    sectionName:name(context.sectionSlug),previousSectionName:name(previous?.sectionSlug || null),
    reason:candidate.reason,at,
  }};
}

/** Display only when an actual model proposal was validated and persisted. */
export function contextChangeLabel(change: ContextChange): string {
  if (change.previousTopic === null) return "Тема: " + change.topic +
    " · Раздел: " + (change.sectionName || "не определён");
  if (change.previousSectionSlug !== change.sectionSlug)
    return "Раздел изменён: " + (change.previousSectionName || "не определён") +
      " → " + (change.sectionName || "не определён") +
      (change.previousTopic !== change.topic ? " · Новая тема: " + change.topic : "");
  return "Тема изменена: " + change.topic;
}
