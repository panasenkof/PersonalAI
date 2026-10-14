import type { CollectionRecord, MemoryRepository, MemorySensitivity } from "./types";

/** The built-in sections memory is organised into. Each is an ordinary
 * collection identified by its slug, so a user can still rename it, change its
 * sensitivity or add their own sections next to it. */
export type SectionSlug = "about" | "people" | "projects" | "preferences" | "dates" | "documents" | "notes";
export type SectionDefinition = {
  slug: SectionSlug; name: string; icon: string;
  /** What belongs here, shown in the memory screen and given to the model. */
  hint: string;
  sensitivity: MemorySensitivity;
};

export const SECTIONS: SectionDefinition[] = [
  { slug: "about", name: "Обо мне", icon: "user", sensitivity: "standard",
    hint: "Имя, как обращаться, город, работа, чем живёте, что для вас важно" },
  { slug: "people", name: "Люди", icon: "users", sensitivity: "standard",
    hint: "Близкие, коллеги, друзья: кто они вам и что о них важно помнить" },
  { slug: "projects", name: "Дела и проекты", icon: "briefcase", sensitivity: "standard",
    hint: "Текущие задачи, цели, проекты на работе и дома, решения" },
  { slug: "preferences", name: "Предпочтения", icon: "heart", sensitivity: "standard",
    hint: "Что нравится и не нравится, привычки, как вам удобнее получать ответы" },
  { slug: "dates", name: "Важные даты", icon: "calendar", sensitivity: "standard",
    hint: "Дни рождения, годовщины, сроки, повторяющиеся события" },
  { slug: "documents", name: "Документы", icon: "file-text", sensitivity: "sensitive",
    hint: "Номера, полисы, договоры. Раздел личный: его содержимое не отправляется модели" },
  { slug: "notes", name: "Заметки", icon: "book-open", sensitivity: "standard",
    hint: "Всё остальное: идеи, рецепты, мысли" },
];
export const SECTION_SLUGS = SECTIONS.map(s => s.slug);
/** Sections the assistant may propose notes for: never the personal documents section. */
export const PROPOSABLE_SECTIONS: SectionSlug[] = SECTIONS.filter(s => s.sensitivity === "standard").map(s => s.slug);
export const isSectionSlug = (value: unknown): value is SectionSlug =>
  typeof value === "string" && (SECTION_SLUGS as string[]).includes(value);
export const sectionBySlug = (slug: string) => SECTIONS.find(s => s.slug === slug);

/** Collections in display order: built-in sections first, then the user's own. */
export function orderCollections(collections: CollectionRecord[]): CollectionRecord[] {
  const rank = (c: CollectionRecord) => { const i = SECTION_SLUGS.indexOf(c.slug as SectionSlug); return i < 0 ? SECTIONS.length : i; };
  return [...collections].sort((a, b) => rank(a) - rank(b) || String(a.created_at).localeCompare(String(b.created_at)));
}

/** Creates any built-in section that is missing; never changes existing ones. */
export async function ensureSections(db: Pick<MemoryRepository, "listCollections" | "createCollection">): Promise<CollectionRecord[]> {
  const existing = await db.listCollections();
  const missing = SECTIONS.filter(s => !existing.some(c => c.slug === s.slug));
  const created: CollectionRecord[] = [];
  for (const section of missing) {
    try { const record = await db.createCollection({ name: section.name, slug: section.slug, sensitivity: section.sensitivity }); if (record) created.push(record); }
    catch { /* a concurrent screen created it first; re-read below */ }
  }
  return orderCollections(created.length === missing.length ? [...existing, ...created] : await db.listCollections());
}

/** One line per section for the model's instructions. */
export const sectionGuide = (): string =>
  SECTIONS.filter(s => s.sensitivity === "standard").map(s => `${s.slug} — ${s.name}: ${s.hint}`).join("; ");
