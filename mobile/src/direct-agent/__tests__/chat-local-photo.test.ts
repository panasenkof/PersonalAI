import { DirectChatStore } from "../chat-store";
import type { ConversationRepository, SavedConversation } from "../conversations";
import { localPhotoIntent83, searchLocalPhotosFromChat83 } from "../../media/vision-chat-search";
import { waitForApplicationSession, localMemorySessionUnlocked } from "../../local-memory/storage";
import type { ChatAttachment } from "../chat-attachments";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),
  withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
jest.mock("../../media/vision-chat-search",()=>({
  localPhotoIntent83:jest.fn(),
  searchLocalPhotosFromChat83:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"id-"+Math.random().toString(36).slice(2)}));
jest.mock("../agent-preferences",()=>({loadModelCallLimit:jest.fn(async()=>4)}));
const intent=localPhotoIntent83 as jest.Mock;
const search=searchLocalPhotosFromChat83 as jest.Mock;
const settings={provider:"openai",apiKey:"never-send",model:"remote",
  baseUrl:"https://api.openai.com/v1",allowWeb:false} as any;
function fixture(){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()]),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const runner=jest.fn().mockResolvedValue({text:"Ответ помощника",sources:[],requests:1});
  return {records,repo,runner};
}
const image:ChatAttachment={
  id:"captured",name:"photo.jpg",kind:"image",mime:"image/jpeg",
  data:Buffer.from([255,216,255,1,2,3]).toString("base64"),size:6,
};
const matching={text:"Найдены фотографии",memory:[{
  id:"saved-note",title:"Велосипед",via:"search",photo:true,photoAttachmentId:"saved-image",
}]};
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  intent.mockImplementation((q:string,files:ChatAttachment[])=>
    q.toLowerCase().includes("похож")&&files.some(x=>x.kind==="image")
      ? {mode:"image",description:""} : null);
  search.mockResolvedValue(matching);
});

test("all ordinary photo chat queries call agent; no automatic direct photo route",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Найди фото красного велосипеда");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].prompt).toBe("Найди фото красного велосипеда");
  expect(typeof runner.mock.calls[0][0].searchPhotos).toBe("function");
  expect(search).not.toHaveBeenCalled();
  expect(records.get(store.getSnapshot().activeId!)?.rows.at(-1)?.role)
    .toBe("assistant");
  store.dispose();
});

test("camera-selected photo goes through LLM; provider receives no original; tool gets local photo",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  store.setQuestion("Это мой несвязанный черновик");
  runner.mockImplementationOnce(async(options:any)=>{
    expect(options.photoQueryAvailable).toBe(true);
    expect(options.attachments).toEqual([]);
    expect(JSON.stringify(options.history)).not.toContain(image.data);
    const result=await options.searchPhotos({mode:"image",description:""});
    expect(result.memory[0]).toMatchObject({photoAttachmentId:"saved-image"});
    return {...matching,sources:[],requests:2};
  });
  await store.searchPhotosWithAgent(settings,image,id);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledWith("guest",
    {mode:"image",description:""},[image],expect.any(Object));
  const saved=records.get(id)!;
  expect(saved.question).toBe("Это мой несвязанный черновик");
  expect(saved.attachments).toEqual([]);
  expect(saved.rows.map(row=>row.role)).toEqual(["user","assistant"]);
  expect(saved.rows[1].memory?.[0]).toMatchObject({photo:true,photoAttachmentId:"saved-image"});
  expect(JSON.stringify(saved)).not.toContain(image.data);
  store.dispose();
});

test("normal attached-image search goes through LLM; only local tool sees the image",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  store.setQuestion("Найди похожие фотографии в моей памяти");
  runner.mockImplementationOnce(async(options:any)=>{
    expect(options.photoQueryAvailable).toBe(true);
    expect(options.attachments).toEqual([]);
    expect(options.history).toEqual([]);
    await options.searchPhotos({mode:"image",description:""});
    return {...matching,sources:[],requests:2};
  });
  await store.send(settings);
  expect(search).toHaveBeenCalledTimes(1);
  expect(records.get(id)?.rows[0].attachments).toBeUndefined();
  expect(JSON.stringify(records.get(id))).not.toContain(image.data);
  store.dispose();
});

test("simple non-photo image-understanding chat still follows normal model route",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Что изображено здесь?");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].photoQueryAvailable).toBe(false);
  expect(search).not.toHaveBeenCalled();
  store.dispose();
});

test("inaccessible or locked photo tool cannot show data after AppLock changes",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Найди фото велосипеда");
  runner.mockImplementationOnce(async(options:any)=>{
    (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
    await expect(options.searchPhotos({mode:"text",description:"велосипед"}))
      .rejects.toThrow("application_locked");
    return {text:"Нет доступа",sources:[],requests:1};
  });
  await store.send(settings);
  expect(search).not.toHaveBeenCalled();
  store.dispose();
});

test("failed camera search cannot silently fall back to a direct search",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  runner.mockRejectedValueOnce(new Error("model_unavailable"));
  await store.searchPhotosWithAgent(settings,image,id);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(search).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.role).toBe("info");
  expect(store.getSnapshot().conversations[0].busy).toBe(false);
  store.dispose();
});

test("model missing local vision keeps a retry handle, never saves the query image",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  runner.mockResolvedValueOnce({
    text:"Установите модель для поиска фотографий",sources:[],requests:2,
    photoAction:"model",
  });
  await store.searchPhotosWithAgent(settings,image,id);
  const state=store.getSnapshot().conversations[0];
  expect(state.retryPhoto).toMatchObject({image});
  expect(records.get(id)?.rows.at(-1)?.photoAction).toBe("model");
  expect(JSON.stringify(records.get(id))).not.toContain(image.data);
  await store.searchPhotosWithAgent(settings,state.retryPhoto!.image,id);
  expect(runner).toHaveBeenCalledTimes(2);
  store.dispose();
});

test("web-image search remains explicitly authorized and separate from local image mode",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  store.setQuestion("Несохранённый вопрос");
  await store.send({...settings,allowWeb:true},image.id);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].attachments).toEqual([image]);
  expect(runner.mock.calls[0][0].skipLocalMemory).toBe(true);
  expect(store.getSnapshot().conversations[0].question).toBe("Несохранённый вопрос");
  store.dispose();
});
