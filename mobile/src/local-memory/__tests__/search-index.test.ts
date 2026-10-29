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

test("long Russian question retains discriminating final terms, dates and numbers", () => {
  const query = "Что говорится про ремонт и оплату ".repeat(12) +
    "в счёте 2025 года, где указан серийный номер ZX77881?";
  const terms = searchSteps(query).filter(s => !s.prefix).map(s => s.term);
  expect(terms).toContain("zx77881");
  expect(terms).toContain("2025");
  expect(terms).not.toContain(query.slice(0, 120));
  expect(searchSteps(query).length).toBeLessThanOrEqual(40);
  const extended = "вводная ".repeat(700) + "Уникальный термин ВЕЛОСИПЕД999";
  expect(searchSteps(extended).some(s => s.term === "велосипед999")).toBe(true);
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

test("a three-letter stem is searched only among index words and names", () => {
  expect(searchSteps("Как зовут моего шефа?")).toContainEqual({ term: "шеф", prefix: true, weight: 1, column: "terms" });
  expect(ftsPhrase("шеф", true, "terms")).toBe('{terms aliases} : "шеф"*');
});

test("conditional missing source is not a negative fact; declension probes stay bounded",()=>{
  const {requiredSearchEvidence}=require("../query");
  const q="Открой статью о мультиметре. Если полный текст не сохранился, скажи об этом.";
  expect(requiredSearchEvidence(q)).toEqual([]);
  expect(requiredSearchEvidence("Если в 2024 записи нет, проверь 2025.")).toEqual(["2025"]);
  expect(requiredSearchEvidence("Кто не любит кофе в 2025 году?")).toEqual(["не любит","2025"]);
  expect(searchSteps("мультиметр статья")).toContainEqual({
    term:"мультиметр",prefix:true,weight:3,
  });
  expect(searchSteps("мультиметре").some(x=>x.term==="мультиметр"&&x.prefix)).toBe(true);
  expect(searchSteps("Кто любит кофе?").some(x=>x.term==="коф"&&x.prefix&&!x.column)).toBe(false);
});

test("vectors: cosine, BLOB round trip and rank fusion", () => {
  const { cosine, toBlob, fromBlob, fuseRanks } = require("../vectors");
  const a = Float32Array.from([1, 0, 0]), b = Float32Array.from([0.6, 0.8, 0]);
  expect(cosine(a, a)).toBeCloseTo(1); expect(cosine(a, b)).toBeCloseTo(0.6); expect(cosine(a, Float32Array.from([1, 0]))).toBe(0);
  expect(Array.from(fromBlob(toBlob(b)))).toEqual(Array.from(b));
  expect(fromBlob(new Uint8Array(3))).toBeNull();
  const fused = fuseRanks([["x", "y"], ["z", "x"]]);
  expect([...fused.entries()].sort((p, q) => q[1] - p[1])[0][0]).toBe("x");
});


test("negation and exact year require literal source evidence, rather than an unrelated positive hit", () => {
  const { requiredSearchEvidence } = require("../query");
  expect(requiredSearchEvidence("Кто не любит кофе в 2025 году?")).toEqual(["не любит", "2025"]);
  expect(searchSteps("Кто не любит кофе в 2025 году?")).toContainEqual({
    term: "не любит", prefix: false, weight: 6,
  });
  expect(requiredSearchEvidence("Событие в 2024, а не 2025?")).toEqual(["2024"]);
  expect(requiredSearchEvidence("Что не стоит готовить мне на ужин?")).toEqual([]);
});
