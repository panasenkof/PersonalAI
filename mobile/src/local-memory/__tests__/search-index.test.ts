import { chunkText, contentHash, defaultKind, normalizeAlias } from "../search-index";
import { foldText, ftsPhrase, searchSteps } from "../query";

test("chunks keep paragraphs together and never exceed the limit", () => {
  expect(chunkText("")).toEqual([]);
  expect(chunkText("Один.\n\nДва.")).toEqual(["Один.\n\nДва."]);
  const long = "Первое предложение. ".repeat(60);
  const chunks = chunkText(long + "\n\nКонец.", 300);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every(c => c.length <= 300)).toBe(true);
  expect(chunks[chunks.length - 1]).toContain("Конец.");
  // One endless word is still cut to the limit.
  expect(chunkText("а".repeat(1000), 300).map(c => c.length)).toEqual([300, 300, 300, 100]);
});

test("hash, names, folding and default types", () => {
  expect(contentHash("текст")).toBe(contentHash("текст"));
  expect(contentHash("текст")).not.toBe(contentHash("текст."));
  expect(normalizeAlias("  Алёна   Петрова ")).toBe("алена петрова");
  expect(foldText("Ёж и ёлка")).toBe("Еж и елка");
  expect(defaultKind("people")).toBe("person");
  expect(defaultKind("dates")).toBe("event");
  expect(defaultKind("my-own")).toBe("note");
  expect(ftsPhrase('ёж "OR" x', true)).toBe('"еж ""OR"" x"*');
});

test("search steps: the phrase, words without helper words, then stems; a question about me lists recent records", () => {
  const steps = searchSteps("Сколько лет моей машине?");
  expect(steps[0]).toEqual({ term: "Сколько лет моей машине?", prefix: false, weight: 4 });
  expect(steps.filter(s => s.weight === 2).map(s => s.term)).toEqual(["машине"]);
  expect(steps.filter(s => s.prefix).map(s => s.term)).toEqual(["машин"]);
  expect(searchSteps("Что ты знаешь обо мне?")).toEqual([{ term: "", prefix: false, weight: 1 }]);
  expect(searchSteps("a")).toEqual([]);
});

test("sections for proposals: the user's own are included, «Документы», secret and unclassified never", () => {
  const { proposableSections, factProposal, restoredProposal, findSection } = require("../../direct-agent/fact-tool");
  const col = (slug: string, name: string, sensitivity: string) => ({ id: slug, slug, name, sensitivity, description: null, created_at: "" });
  const sections = proposableSections([col("notes", "Заметки", "standard"), col("documents", "Документы", "sensitive"),
    col("section-1", "Рецепты", "standard"), col("section-2", "Тайное", "secret"), col("section-3", "Старое", "unclassified")]);
  expect(sections.map((s: any) => s.name)).toEqual(["Заметки", "Рецепты"]);
  expect(sections[1]).toMatchObject({ own: true });
  expect(findSection("рецепты", sections).slug).toBe("section-1");
  expect(findSection("«Рецепты»", sections).slug).toBe("section-1");
  expect(factProposal({ title: "a", body: "b", section: "null" }, sections)).toEqual({ title: "a", body: "b" });
  expect(restoredProposal({ section: "section-1", newSection: "  ", kind: "event", date: "2026-13-01" })).toEqual({ section: "section-1", kind: "event" });
  expect(restoredProposal({ section: "documents", newSection: "Гараж" })).toEqual({ newSection: "Гараж" });
});
