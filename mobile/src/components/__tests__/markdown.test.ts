import { parseInline, parseMarkdown } from "../markdown";

test("bold, italic, code and links lose their markup", () => {
  expect(parseInline("Вы спрашивали: **«Сколько лет Де Ниро?»** — *примерно* `83`, [ЦБ](https://cbr.ru/)")).toEqual([
    { text: "Вы спрашивали: " }, { text: "«Сколько лет Де Ниро?»", bold: true }, { text: " — " },
    { text: "примерно", italic: true }, { text: " " }, { text: "83", code: true }, { text: ", " }, { text: "ЦБ", url: "https://cbr.ru/" },
  ]);
});
test("asterisks that are not markup stay as they are", () => {
  expect(parseInline("2 * 3 * 4 = 24").map(s => s.text).join("")).toBe("2 * 3 * 4 = 24");
  expect(parseInline("file_name_here").map(s => s.text).join("")).toBe("file_name_here");
});
test("headings, lists, quotes, code and blank lines become blocks", () => {
  const blocks = parseMarkdown("## Погода\n\n- **Сегодня:** +12\n  - ночью +5\n1. Зонт\n> Источник: ЦБ\n```\nx = 1\n```\n\n\n");
  expect(blocks.map(b => b.kind)).toEqual(["heading", "blank", "bullet", "bullet", "numbered", "quote", "code"]);
  expect(blocks[3]).toMatchObject({ kind: "bullet", depth: 1 });
  expect(blocks[6]).toEqual({ kind: "code", text: "x = 1" });
});
test("an unfinished bold while the answer streams is shown as typed", () => {
  expect(parseInline("Ответ: **83").map(s => s.text).join("")).toBe("Ответ: **83");
});
