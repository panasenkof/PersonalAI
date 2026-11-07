import { suggestIncomingCollection } from "../share-collection-suggestion";

const collections = [
  { id: "notes", name: "Заметки", slug: "notes", sensitivity: "standard" },
  { id: "recipes", name: "Рецепты", slug: "recipes", sensitivity: "standard" },
  { id: "cars", name: "Авто", slug: "cars", sensitivity: "standard" },
  { id: "work", name: "Работа", slug: "work", sensitivity: "standard" },
  { id: "docs", name: "Документы", slug: "documents", sensitivity: "sensitive" },
  { id: "inbox", name: "Входящие", slug: "inbox", sensitivity: "sensitive" },
] as const;

test("MSG-6.C1: one exact hashtag proposes an EXISTING ordinary collection only", () => {
  expect(suggestIncomingCollection("Лазанья #РЕЦЕПТЫ", collections)).toEqual({
    collectionId: "recipes", name: "Рецепты",
    reason: "по отметке #РЕЦЕПТЫ", evidence: "hashtag",
  });
});

test("MSG-6.C1: existing collection name in caption is sufficient when unambiguous", () => {
  expect(suggestIncomingCollection("Рецепты на каждый день: суп", collections)).toMatchObject({
    collectionId: "recipes", evidence: "text",
  });
  expect(suggestIncomingCollection("папка", collections)).toBeNull();
});

test("MSG-6.C1: untrusted hashtags cannot pick a private collection or auto-create a section", () => {
  expect(suggestIncomingCollection("#Документы номер паспорта", collections)).toBeNull();
  expect(suggestIncomingCollection("#периметр описание", collections)).toBeNull();
  expect(suggestIncomingCollection("#Входящие получение", collections)).toBeNull();
});

test("MSG-6.C1: two matching tags or two matching section names are ambiguous", () => {
  expect(suggestIncomingCollection("#авто/#работа купил запчасти", collections)).toBeNull();
  expect(suggestIncomingCollection("Авто и работа сегодня", collections)).toBeNull();
  expect(suggestIncomingCollection("Книга #авто и #рецепты", collections)).toBeNull();
});

test("MSG-6.C1: URL fragments are not treated as a user hashtag", () => {
  expect(suggestIncomingCollection("https://example.org/page#рецепты", collections)).toBeNull();
  expect(suggestIncomingCollection("https://example.org/#авто комментарий #работа", collections))
    .toMatchObject({ collectionId: "work", evidence: "hashtag" });
});

test("MSG-6.C1: different collection labels, non-Russian labels and unicode normalize", () => {
  const custom = [{id:"dev",name:"AI Tools",slug:"ai-tools",sensitivity:"standard"}] as const;
  expect(suggestIncomingCollection("Сборка #ai_tools", custom)).toMatchObject({collectionId:"dev"});
  expect(suggestIncomingCollection("AI Tools: планы", custom)).toMatchObject({collectionId:"dev"});
});

test("MSG-6.C1: invalid/oversized text and zero collections return no proposal", () => {
  expect(suggestIncomingCollection("X".repeat(60_001), collections)).toBeNull();
  expect(suggestIncomingCollection("машина", [])).toBeNull();
});
