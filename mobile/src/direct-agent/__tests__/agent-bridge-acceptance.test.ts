/** Step 9T3, baseline C1: real store + actual Responses tool loop + canonical
 * verified host adapters, with synthetic fixtures. NO paid LLM and NO
 * physical Android claims. Canonical SQL transaction integration is covered
 * separately by local-memory/__tests__/chat-note-move.test.ts. */
import { DirectChatStore } from "../chat-store";
import { runDirectAgent } from "../engine";
import { parseConversation,type ConversationRepository,type SavedConversation } from "../conversations";
import { searchApprovedNotes,readApprovedNote } from "../memory";
import { previewMove,confirmMove,undoMove } from "../move-proposal";
import { localMemorySessionUnlocked,waitForApplicationSession } from "../../local-memory/storage";
import { searchLocalPhotosFromChat83 } from "../../media/vision-chat-search";
import type { ChatAttachment } from "../chat-attachments";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
jest.mock("../memory",()=>({
  proposableMemorySections:jest.fn().mockResolvedValue([{slug:"notes",name:"Заметки"},
    {slug:"recipes",name:"Рецепты"}]),
  searchApprovedNotes:jest.fn(),readApprovedNote:jest.fn(),
  saveApprovedNote:jest.fn(),
}));
jest.mock("../move-proposal",()=>({
  ...jest.requireActual("../move-proposal"),
  previewMove:jest.fn(),confirmMove:jest.fn(),undoMove:jest.fn(),
}));
jest.mock("../../media/vision-chat-search",()=>({
  localPhotoIntent83:jest.fn(()=>null),
  searchLocalPhotosFromChat83:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>
  "id-"+Math.random().toString(36).slice(2)}));
jest.mock("../agent-preferences",()=>({loadModelCallLimit:jest.fn(async()=>6)}));
const settings={provider:"openai",baseUrl:"https://api.openai.com/v1",model:"gpt-4.1-mini",
  apiKey:"synthetic-only",allowWeb:false,webSearchKey:""} as any;
const move={
  noteId:"note-lasagna",expectedVersion:4,title:"Лазанья с соусом",
  fromCollectionId:"c-notes",fromName:"Заметки",
  toCollectionId:"c-recipes",toName:"Рецепты",
  reason:"Это рецепт, его удобно хранить с рецептами",
  attachmentCount:1,hasSource:true,
};
const receipt={
  noteId:move.noteId,title:move.title,
  fromCollectionId:move.fromCollectionId,fromName:move.fromName,
  toCollectionId:move.toCollectionId,toName:move.toName,
  batch:"notes:move:11111111-2222-3333-4444-555555555555",verified:true,
};
const moveArgs={noteId:move.noteId,expectedVersion:4,
  targetSectionSlug:"recipes",reason:move.reason};
const image:ChatAttachment={
  id:"synthetic-image",name:"red-bike.jpg",kind:"image",mime:"image/jpeg",
  data:Buffer.from([255,216,255,3,5,7]).toString("base64"),size:6,
};
function tool(name:string,args:unknown,call_id:string){
  return {ok:true,status:200,json:async()=>({status:"completed",output:[{
    type:"function_call",name,call_id,arguments:JSON.stringify(args),
  }]})};
}
function answer(text:string){
  return {ok:true,status:200,json:async()=>({status:"completed",output:[{
    type:"message",content:[{type:"output_text",text}],
  }]})};
}
function fixture(responses:unknown[]){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()].map(r=>JSON.parse(JSON.stringify(r)))),
    save:jest.fn(async row=>{records.set(row.id,JSON.parse(JSON.stringify(row)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const transport=jest.fn().mockImplementation(async()=>{
    const value=responses.shift();
    if(!value)throw new Error("scripted LLM budget exceeded");
    return value;
  });
  const runner=jest.fn((options:any)=>runDirectAgent({
    ...options,transport:transport as unknown as typeof fetch,
  }));
  return {records,repo,transport,runner,store:new DirectChatStore("guest",repo,runner)};
}
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (searchApprovedNotes as jest.Mock).mockResolvedValue([{
    id:move.noteId,title:move.title,section:"Заметки",version:4,
    body:"Соус бешамель, томаты и сыр",excerptOnly:false,
  }]);
  (readApprovedNote as jest.Mock).mockResolvedValue({
    id:move.noteId,revision:4,title:move.title,
    content:"Соус бешамель, томаты и сыр",offset:0,totalChars:30,hasMore:false,
    source:{recordId:move.noteId,sourceRef:"https://example.test/recipe",
      location:"unknown"},
    evidence:{recordId:move.noteId,recordVersion:4,startChar:0,endChar:30,
      coverage:"complete",originalPage:null,originalTime:null},
  });
  (previewMove as jest.Mock).mockResolvedValue(move);
  (confirmMove as jest.Mock).mockResolvedValue(receipt);
  (undoMove as jest.Mock).mockResolvedValue(undefined);
  (searchLocalPhotosFromChat83 as jest.Mock).mockResolvedValue({
    text:"Нашёл фотографию велосипеда",memory:[{
      id:"note-bike",title:"Красный велосипед у дерева",via:"search",
      photo:true,photoAttachmentId:"photo-bike",
    }],
  });
});

test("9T3-C1: exact search → read → LLM proposal → user confirm → real receipt → user undo survives reopen",async()=>{
  const responses=[
    tool("search_local_notes",{query:"лазанья"},"find"),
    tool("read_local_note",{id:move.noteId,version:4,offset:0,budget:4000},"read"),
    tool("propose_move_local_note",moveArgs,"propose"),
    answer("Нашёл запись. Предлагаю перенос; подтвердите карточку."),
  ];
  const {store,runner,records,repo,transport}=fixture(responses);
  await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Найди мою лазанью, прочитай и предложи перенести в Рецепты");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(4);
  expect(readApprovedNote).toHaveBeenCalledWith("guest",move.noteId,4,0,4000);
  expect(previewMove).toHaveBeenCalledWith("guest",moveArgs);
  expect(confirmMove).not.toHaveBeenCalled();
  const proposalRow=store.getSnapshot().conversations[0].rows.at(-1)!;
  expect(proposalRow.moveProposal).toEqual(move);
  const secondRequest=JSON.parse(transport.mock.calls[1][1].body);
  expect(secondRequest.input.some((m:any)=>m.type==="function_call_output"&&
    m.call_id==="find")).toBe(true);
  const fourthRequest=JSON.parse(transport.mock.calls[3][1].body);
  const proposalResponse=fourthRequest.input.find((m:any)=>m.call_id==="propose"&&
    m.type==="function_call_output");
  expect(JSON.parse(proposalResponse.output)).toMatchObject({
    saved:false,requiresUserTap:true,status:"awaiting_user_confirmation",
  });
  await store.confirmMoveProposal(proposalRow.id);
  expect(confirmMove).toHaveBeenCalledWith("guest",move);
  const confirmed=store.getSnapshot().conversations[0].rows.find(r=>r.id===proposalRow.id);
  expect(confirmed?.moveReceipt).toEqual(receipt);
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.find(r=>r.id===proposalRow.id)?.moveReceipt)
    .toEqual(receipt);
  await store.undoConfirmedMove(proposalRow.id);
  expect(undoMove).toHaveBeenCalledWith("guest",receipt);
  expect(store.getSnapshot().conversations[0].rows.find(r=>r.id===proposalRow.id)?.moveReceipt?.undone)
    .toBe(true);
  store.dispose();
  const reloaded=new DirectChatStore("guest",repo);
  await reloaded.initialize();
  expect(reloaded.getSnapshot().conversations[0].rows.find(r=>r.id===proposalRow.id)?.moveReceipt?.undone)
    .toBe(true);
  reloaded.dispose();
});

test("9T3-C1: made-up ID cannot create a confirmation card or write any note",async()=>{
  const responses=[
    tool("propose_move_local_note",{...moveArgs,noteId:"forged-id"},"forged"),
    answer("Не удалось подтвердить запись. Сначала нужно найти её в памяти."),
  ];
  const {store,transport}=fixture(responses);
  await store.initialize();
  store.setQuestion("Перенеси несуществующую запись в Рецепты");
  await store.send(settings);
  expect(previewMove).not.toHaveBeenCalled();
  expect(confirmMove).not.toHaveBeenCalled();
  const output=JSON.parse(transport.mock.calls[1][1].body).input.find((m:any)=>
    m.type==="function_call_output"&&m.call_id==="forged");
  expect(JSON.parse(output.output)).toMatchObject({error:"note_not_selected_for_move"});
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.moveProposal).toBeUndefined();
  store.dispose();
});

test("9T3-C1: host rejects stale preview after model receives a valid note handle",async()=>{
  (previewMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  const {store,transport}=fixture([
    tool("search_local_notes",{query:"лазанья"},"find"),
    tool("propose_move_local_note",moveArgs,"propose"),
    answer("Версия записи изменилась. Повторите поиск."),
  ]);
  await store.initialize();
  store.setQuestion("Найди и перенеси запись в Рецепты");
  await store.send(settings);
  expect(previewMove).toHaveBeenCalledTimes(1);
  expect(confirmMove).not.toHaveBeenCalled();
  const output=JSON.parse(transport.mock.calls[2][1].body).input.find((m:any)=>
    m.type==="function_call_output"&&m.call_id==="propose");
  expect(JSON.parse(output.output)).toMatchObject({error:"tool_failed_or_unavailable"});
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.moveProposal).toBeUndefined();
  store.dispose();
});

test("9T3-C1: photo query uses the one local search adapter through LLM without sending original bytes",async()=>{
  const {store,transport}=fixture([
    tool("search_local_photos",{mode:"image",description:""},"photo"),
    answer("Нашёл фото велосипеда в памяти телефона."),
  ]);
  await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setAttachments(id,[image]);
  await store.searchPhotosWithAgent(settings,image,id);
  expect(searchLocalPhotosFromChat83).toHaveBeenCalledWith("guest",
    {mode:"image",description:""},[image],expect.any(Object));
  expect(transport).toHaveBeenCalledTimes(2);
  const outbound=transport.mock.calls.map(call=>JSON.stringify(JSON.parse(call[1].body)));
  expect(outbound.join("")).not.toContain(image.data);
  expect(outbound.join("")).not.toContain("image_url");
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.memory?.[0])
    .toMatchObject({photo:true,photoAttachmentId:"photo-bike"});
  store.dispose();
});
