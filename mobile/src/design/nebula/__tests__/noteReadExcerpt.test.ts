import { noteReadExcerpt } from "../noteReadExcerpt";

test("a short note is fully visible without an extra action", () => {
  const text = "Купить молоко и хлеб";
  expect(noteReadExcerpt(text, 6)).toEqual({ preview: text, needsFullReading: false });
});

test("long OCR text is bounded without changing the original or cutting an emoji codepoint", () => {
  const source = "📄" + "текст из PDF ".repeat(500);
  const result = noteReadExcerpt(source, 4);
  expect(result.needsFullReading).toBe(true);
  expect(Array.from(result.preview).length).toBeLessThanOrEqual(4 * 85 + 1);
  expect(result.preview.startsWith("📄")).toBe(true);
  expect(result.preview.endsWith("…")).toBe(true);
  expect(source).toContain("PDF");
  expect(source.length).toBeGreaterThan(result.preview.length);
});

test("many short lines have a read action even when under the codepoint cap", () => {
  const text = Array.from({length: 9}, (_,i) => "строка " + i).join("\n");
  const result = noteReadExcerpt(text, 4);
  expect(result.preview).toBe(text);
  expect(result.needsFullReading).toBe(true);
});
