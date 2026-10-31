import { DirectChatStore } from "../chat-store";
import type { ConversationRepository, SavedConversation } from "../conversations";
import { localPhotoIntent83,searchLocalPhotosFromChat83 } from "../../media/vision-chat-search";
import { waitForApplicationSession } from "../../local-memory/storage";
import type { ChatAttachment } from "../chat-attachments";
jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),
  withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../../media/vision-chat-search",()=>({
  localPhotoIntent83:jest.fn(),
  searchLocalPhotosFromChat83:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"id-"+Math.random().toString(36).slice(2)}));
const intent=localPhotoIntent83 as jest.Mock;
const search=searchLocalPhotosFromChat83 as jest.Mock;
const settings={provider:"openai",apiKey:"never-send",model:"remote",baseUrl:"https://api.openai.com/v1"} as any;
function fixture(){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()]),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const runner=jest.fn();
  return {records,repo,runner};
}
const image:ChatAttachment={
  id:"captured",name:"photo.jpg",kind:"image",mime:"image/jpeg",
  data:Buffer.from([255,216,255,1,2,3]).toString("base64"),size:6,
};
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  intent.mockImplementation((q:string,files:ChatAttachment[])=> q.includes("Найди")?
    {mode:files.some(x=>x.kind==="image")?"image":"text",description:q}:null);
  search.mockResolvedValue({text:"Найдены фотографии",memory:[{
    id:"saved-note",title:"Велосипед",via:"search",photo:true,photoAttachmentId:"saved-image",
  }]});
});
test("new camera photo immediately searches in chat, never stores its bytes or calls remote LLM",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);
  await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Это несвязанный черновик");
  await store.searchPhotosLocally(image,id);
  expect(runner).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledWith("guest",expect.objectContaining({mode:"image"}),[image],expect.any(Object));
  const conversation=records.get(id)!;
  expect(conversation.question).toBe("Это несвязанный черновик");
  expect(conversation.rows.map(x=>x.role)).toEqual(["user","assistant"]);
  expect(conversation.rows[1].memory?.[0]).toMatchObject({photo:true,photoAttachmentId:"saved-image"});
  expect(JSON.stringify(conversation)).not.toContain(image.data);
  store.dispose();
});
test("explicit text photo query is local and still works with no LLM setup",async()=>{
  const {records,repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);
  await store.initialize();
  store.setQuestion("Найди фото красного велосипеда");
  await store.send(settings);
  expect(runner).not.toHaveBeenCalled();
  expect(search).toHaveBeenCalledWith("guest",expect.objectContaining({mode:"text"}),[],expect.any(Object));
  expect(records.get(store.getSnapshot().activeId!)?.rows.at(-1)?.role).toBe("assistant");
  store.dispose();
});
test("ordinary image understanding request still follows remote model path, no forced photo search",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);
  await store.initialize();
  store.setQuestion("Что изображено здесь?");
  runner.mockResolvedValue({text:"Текст",sources:[],requests:1});
  // Existing AI message routing is unchanged (mocked direct agent).
  await store.send(settings);
  expect(search).not.toHaveBeenCalled();
  store.dispose();
});
