import { checkedNoteTags, noteTagsDraft, noteTagsFromPayload, parseNoteTagsInput } from "../note-tags";
import { searchableStructuredText, memoryText } from "../search-index";

test("MSG-6: user explicitly supplies optional Russian hashtags, sorted and deduplicated",()=>{
  expect(parseNoteTagsInput("")).toEqual([]);
  expect(parseNoteTagsInput(" #Рецепты, #авто #РЕЦЕПТЫ ")).toEqual(["авто","рецепты"]);
  expect(noteTagsDraft(["рецепты","авто"])).toBe("#авто #рецепты");
  expect(checkedNoteTags(["#Дом", "дом", "Проекты"])).toEqual(["дом","проекты"]);
});

test("MSG-6: invalid labels cannot be written or indexed as arbitrary JSON",()=>{
  for(const value of ["#а".repeat(40), "#verylongnamethatexceeds_thirty_two_characters",
    "#кот/админ", "#нужен@сайт"]) {
    expect(()=>parseNoteTagsInput(value)).toThrow();
  }
  expect(()=>parseNoteTagsInput(Array(13).fill("#дом").join(" "))).toThrow("12");
  expect(()=>checkedNoteTags(["untrusted name"])).toThrow();
  expect(noteTagsFromPayload({danger:"raw"})).toEqual([]);
  expect(noteTagsFromPayload(["ok", "#bad/path"])).toEqual([]);
  expect(noteTagsFromPayload(Array(13).fill("a"))).toEqual([]);
});

test("MSG-6: only verified tag metadata participates in existing searchable text; authored body unchanged",()=>{
  const body={body:"Моя заметка о поездке",tags:["#Авто","ремонт"]};
  expect(memoryText(body)).toBe("Моя заметка о поездке");
  expect(searchableStructuredText(body)).toContain("Теги: авто ремонт");
  expect(searchableStructuredText({body:"",tags:["ok","/hidden"]})).not.toContain("hidden");
  expect(searchableStructuredText({body:"",tags:undefined})).toBe("");
});
