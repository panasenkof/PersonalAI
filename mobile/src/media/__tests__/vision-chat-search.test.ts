import { photoSearchReadiness83 } from "../vision-index-pages";
import { localPhotoIntent83, searchLocalPhotosFromChat83 } from "../vision-chat-search";
import { searchWithVision83 } from "../vision-memory-query";
import { preparePhotoMatchChatAttachment83 } from "../vision-photo-query";
import { withLocalMemoryDatabase,localMemorySessionUnlocked } from "../../local-memory/storage";
import { SqliteMemoryRepository } from "../../local-memory/repository";
import type { ChatAttachment } from "../../direct-agent/chat-attachments";

jest.mock("../vision-index-pages",()=>({photoSearchReadiness83:jest.fn()}));
jest.mock("../vision-memory-query",()=>({searchWithVision83:jest.fn()}));
jest.mock("../vision-photo-query",()=>({preparePhotoMatchChatAttachment83:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({
  localMemorySessionUnlocked:jest.fn(),withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../../local-memory/repository",()=>({SqliteMemoryRepository:jest.fn()}));
const textSearch=searchWithVision83 as jest.Mock;
const imageVector=preparePhotoMatchChatAttachment83 as jest.Mock;
const lease=withLocalMemoryDatabase as jest.Mock;
const Repo=SqliteMemoryRepository as jest.Mock;
const unlocked=localMemorySessionUnlocked as jest.Mock;
const search=jest.fn();
const attachment:ChatAttachment={id:"photo",name:"img.jpg",mime:"image/jpeg",kind:"image",data:"/9j/2Q==",size:4};
const photo={entity:{id:"note-1",title:"Красный велосипед"},score:0.7,
  originals:[{attachmentId:"a",kind:"image"}]};
beforeEach(()=>{
  jest.clearAllMocks();
  (photoSearchReadiness83 as jest.Mock).mockResolvedValue("ready");
  unlocked.mockReturnValue(true);
  lease.mockImplementation(async (_:string,cb:(db:unknown)=>Promise<unknown>)=>cb({}));
  Repo.mockImplementation(()=>({searchMemory:search}));
  imageVector.mockResolvedValue({model:"eg2|vision|768|sha256:"+"a".repeat(64),values:new Float32Array(768)});
  textSearch.mockResolvedValue([photo]);
  search.mockResolvedValue([photo]);
});
test("text photo request uses local visual search; no unrelated text requests",()=>{
  expect(localPhotoIntent83("Найди фото красного велосипеда у дерева")).toMatchObject({mode:"text",description:"красного велосипеда у дерева"});
  expect(localPhotoIntent83("Посмотри, что изображено на фото",[attachment])).toBeNull();
  expect(localPhotoIntent83("Найди новости в интернете")).toBeNull();
});
test("camera and attached query photo use local image mode",()=>{
  expect(localPhotoIntent83("Найди похожие фотографии в моей памяти",[attachment])?.mode).toBe("image");
  expect(localPhotoIntent83("Найди такие же снимки",[attachment])?.mode).toBe("image");
});
test("text result contains only verified photo-source hits and same scope",async()=>{
  textSearch.mockResolvedValueOnce([photo,{entity:{id:"text-note",title:"ordinary note"}}]);
  const result=await searchLocalPhotosFromChat83("guest",{mode:"text",description:"красный велосипед"});
  expect(result.memory).toEqual([{id:"note-1",title:"Красный велосипед",via:"search",photo:true,photoAttachmentId:"a"}]);
  expect(textSearch).toHaveBeenCalledWith("guest","красный велосипед",{
    sensitivities:["standard","inherit"],limit:8,requireVisionModel:true,
    minImageSimilarity:0.65,
  });
});
test("image query reuses canonical encrypted searchMemory with same ACL; never calls text search",async()=>{
  const result=await searchLocalPhotosFromChat83("guest",{mode:"image",description:""},[attachment]);
  expect(result.memory).toHaveLength(1);
  expect(search).toHaveBeenCalledWith("",{
    sensitivities:["standard","inherit"],limit:8,
    imageVector:{model:expect.any(String),values:expect.any(Float32Array)},
    minImageSimilarity:0.77,
  });
  expect(textSearch).not.toHaveBeenCalled();
});
test("two attached pictures are rejected instead of guessing which one to search",async()=>{
  await expect(searchLocalPhotosFromChat83("guest",{mode:"image",description:""},[
    attachment,{...attachment,id:"other"},
  ])).rejects.toThrow("vision_query_one_image");
  expect(search).not.toHaveBeenCalled();
});
test("lock expiry prevents result display",async()=>{
  imageVector.mockImplementationOnce(async()=>{unlocked.mockReturnValue(false);return {model:"model",values:new Float32Array(768)};});
  await expect(searchLocalPhotosFromChat83("guest",{mode:"image",description:""},[attachment]))
    .rejects.toThrow("application_locked");
  expect(search).not.toHaveBeenCalled();
});

test.each(["У меня есть фото красного велосипеда?", "Есть ли у меня фото коробки с инструментами?", "Сохранила ли я фото чека?"])("everyday request stays local: %s", prompt => {
  expect(localPhotoIntent83(prompt)).toMatchObject({mode:"text"});
});
test.each(["Как найти фото в интернете?", "Что написано на этом фото?", "Как найти фото в памяти?"])("question about using or understanding photos stays a conversation: %s", prompt => {
  expect(localPhotoIntent83(prompt,[attachment])).toBeNull();
});

test.each([["model_missing","model"],["empty","import"],["unprepared","prepare"]])("readiness %s offers recovery without inference",async(state,action)=>{
  (photoSearchReadiness83 as jest.Mock).mockResolvedValueOnce(state);
  const result=await searchLocalPhotosFromChat83("guest",{mode:"text",description:"коробка"});
  expect(result.photoAction).toBe(action);
  expect(textSearch).not.toHaveBeenCalled();
  expect(imageVector).not.toHaveBeenCalled();
});

import { localPhotoSuggestion83 } from "../vision-chat-search";
test.each(["Фото коробки с инструментами", "Снимок красного велосипеда"])("description suggests explicit local action: %s", prompt=>{
  expect(localPhotoSuggestion83(prompt)).toMatchObject({mode:"text"});
});
test.each(["Красный велосипед", "Как найти фото в интернете?", "Сделай фото для объявления", "Что написано на этикетке?", "", "У меня есть фото велосипеда?"])("ordinary or already explicit prompt has no extra suggestion: %s", prompt=>{
  expect(localPhotoSuggestion83(prompt)).toBeNull();
});
test("attachment action owns photo suggestions and typing does not search",()=>{
  expect(localPhotoSuggestion83("Фото коробки",[attachment])).toBeNull();
  localPhotoSuggestion83("Фото коробки");
  expect(textSearch).not.toHaveBeenCalled();
  expect(photoSearchReadiness83).not.toHaveBeenCalled();
});

test("successful visual matches do not offer prepare action for partial/unknown index",async()=>{
  for(const state of ["partial","unknown"]){
    (photoSearchReadiness83 as jest.Mock).mockResolvedValueOnce(state);
    const result=await searchLocalPhotosFromChat83("guest",{mode:"text",description:"красный велосипед"});
    expect(result.memory).toHaveLength(1);
    expect(result.photoAction).toBeUndefined();
    expect(result.text).not.toMatch(/записей:|Результаты упорядочены/);
  }
});
test("empty visual matches still offer index recovery when coverage is partial",async()=>{
  (photoSearchReadiness83 as jest.Mock).mockResolvedValueOnce("partial");
  textSearch.mockResolvedValueOnce([]);
  const result=await searchLocalPhotosFromChat83("guest",{mode:"text",description:"велосипед"});
  expect(result.photoAction).toBe("prepare");
});

test.each([
  ["Найди велосипед", "велосипед"],
  ["Найди красный велосипед возле дерева", "красный велосипед возле дерева"],
  ["Покажи мне синий автомобиль", "синий автомобиль"],
  ["Найди ключи", "ключи"],
])("short object request searches all local memory: %s", (prompt,description)=>{
  expect(localPhotoIntent83(prompt)).toEqual({mode:"all",description});
});
test.each([
  "Найди разговор с сестрой","Найди рецепт лазаньи","Найди документы на автомобиль",
  "Найди новости в интернете","Как найти велосипед?",
])("unrelated/complex tasks are not captured: %s", prompt=>{
  expect(localPhotoIntent83(prompt)).toBeNull();
});
test("generic local request combines photos and notes without readiness gate or LLM",async()=>{
  textSearch.mockResolvedValueOnce([photo,{entity:{id:"plain-note",title:"Ремонт велосипеда"},score:1}]);
  const result=await searchLocalPhotosFromChat83("guest",{mode:"all",description:"велосипед"});
  expect(result.memory).toEqual([
    {id:"note-1",title:"Красный велосипед",via:"search",photo:true,photoAttachmentId:"a"},
    {id:"plain-note",title:"Ремонт велосипеда",via:"search"},
  ]);
  expect(textSearch).toHaveBeenCalledWith("guest","велосипед",{
    sensitivities:["standard","inherit"],limit:8,
    includeTextVector:true,standardCollectionsOnly:true,minImageSimilarity:0.65,
  });
  expect(photoSearchReadiness83).not.toHaveBeenCalled();
  expect(result.text).toContain("1 фото");
  expect(result.text).toContain("1 записей");
});
test("generic local search returns text-only hits if image model is unavailable",async()=>{
  textSearch.mockResolvedValueOnce([{entity:{id:"plain",title:"Велосипед в гараже"}}]);
  const result=await searchLocalPhotosFromChat83("guest",{mode:"all",description:"велосипед"});
  expect(result.memory).toEqual([{id:"plain",title:"Велосипед в гараже",via:"search"}]);
  expect(result.photoAction).toBeUndefined();
});

test("attached non-photo command still uses normal model route",()=>{
  expect(localPhotoIntent83("Найди велосипед",[attachment])).toBeNull();
});
