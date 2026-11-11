import {syncTelegramBotText} from "../bot-sync";
import {fetchBotUpdates} from "../bot-api";
import {prepareBotOriginal} from "../bot-media";
import {advanceTelegramBotCursor,loadTelegramBotConfig} from "../bot-settings";
import {saveMediaNote} from "../../media/attachments";
import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../../local-memory/storage";
import {scheduleVectors} from "../../media/vector-runner";
jest.mock("../bot-api",()=>({fetchBotUpdates:jest.fn()}));
jest.mock("../bot-media",()=>({prepareBotOriginal:jest.fn()}));
jest.mock("../bot-settings",()=>({loadTelegramBotConfig:jest.fn(),advanceTelegramBotCursor:jest.fn()}));
jest.mock("../../media/attachments",()=>({saveMediaNote:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn(),onLocalMemorySessionChange:jest.fn()}));
jest.mock("../../media/vector-runner",()=>({scheduleVectors:jest.fn()}));
const token="12345678:"+"a".repeat(35);
const msg=(id:number,text:string,chatId=12345)=>({
  message_id:id,chat:{id:chatId,type:"private"},text,
});
beforeEach(()=>{
  jest.clearAllMocks();
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (onLocalMemorySessionChange as jest.Mock).mockImplementation(()=>()=>{});
  (loadTelegramBotConfig as jest.Mock).mockResolvedValue({
    token,botId:456,username:"MyPersAIBot",allowedChatId:"12345",cursor:0,
  });
  (advanceTelegramBotCursor as jest.Mock).mockResolvedValue(undefined);
  (saveMediaNote as jest.Mock).mockResolvedValue("note-id");
  (fetchBotUpdates as jest.Mock).mockResolvedValue([]);
  (prepareBotOriginal as jest.Mock).mockResolvedValue(null);
});
test("only approved private chat reaches canonical writer with typed provenance",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValue([
    {update_id:1,message:msg(1,"Private from others",900)},
    {update_id:2,message:msg(2,"/start")},
    {update_id:3,message:msg(3,"Рецепт\nПомнить!")},
  ]);
  expect(await syncTelegramBotText("p1")).toEqual({imported:1,skipped:2,lastUpdate:3});
  expect(fetchBotUpdates).toHaveBeenCalledWith(token,0,expect.any(Object));
  expect(saveMediaNote).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).toHaveBeenCalledWith("p1",expect.objectContaining({
    title:"Рецепт",body:"Рецепт\nПомнить!",sensitivity:"sensitive",
    receipt:"telegram-bot:456:12345:3",
    botMessage:{botId:456,chatId:"12345",messageId:3},
  }),expect.any(Object));
  expect(advanceTelegramBotCursor).toHaveBeenCalledTimes(3);
  expect(advanceTelegramBotCursor).toHaveBeenLastCalledWith("p1",456,"12345",3);
  expect(scheduleVectors).toHaveBeenCalledWith("p1");
});
test("does not ACK an update when canonical writer fails",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValue([
    {update_id:5,message:msg(5,"okay",900)},
    {update_id:6,message:msg(6,"Must retry")},
  ]);
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error("SQLCipher writer failed"));
  await expect(syncTelegramBotText("p2")).rejects.toThrow("SQLCipher writer failed");
  expect(advanceTelegramBotCursor).toHaveBeenCalledTimes(1);
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("p2",456,"12345",5);
});
test("unsupported media and edits block ACK instead of silently losing content",async()=>{
  (prepareBotOriginal as jest.Mock).mockRejectedValueOnce(new Error("Импорт остановлен без потери сообщения."));
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:8,message:{...msg(8,"photo"),photo:[{file_id:"secret"}]},
  }]);
  await expect(syncTelegramBotText("p3")).rejects.toThrow("Импорт остановлен");
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:8,edited_message:msg(8,"changed"),
  }]);
  await expect(syncTelegramBotText("p4")).rejects.toThrow("отредактированное");
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});
test("AppLock prevents bot network and note writes",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  await expect(syncTelegramBotText("p5")).rejects.toThrow("Разблокируйте");
  expect(fetchBotUpdates).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});
test("simultaneous calls for one profile share the same cursor worker",async()=>{
  let release:(value:unknown)=>void=()=>{};
  (fetchBotUpdates as jest.Mock).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const first=syncTelegramBotText("p6");
  const second=syncTelegramBotText("p6");
  expect(first).toBe(second);
  // The worker first awaits the protected profile config before calling fetch.
  // Releasing the deferred fetch before that microtask would leave it blocked.
  await Promise.resolve();
  await Promise.resolve();
  expect(fetchBotUpdates).toHaveBeenCalledTimes(1);
  release([]);
  expect(await first).toEqual({imported:0,skipped:0,lastUpdate:0});
  expect(fetchBotUpdates).toHaveBeenCalledTimes(1);
});

test("single Telegram photo is saved with its original and caption before cursor advances",async()=>{
  const remove=jest.fn();
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce({
    file:{uri:"file:///cache/photo.jpg",name:"photo.jpg",mimeType:"image/jpeg",size:45},
    remove,
  });
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:11,message:{...msg(11,"Подпись к фотографии"),photo:[{file_id:"AgACfile123"}]},
  }]);
  const result=await syncTelegramBotText("photo");
  expect(result.imported).toBe(1);
  expect(prepareBotOriginal).toHaveBeenCalledWith(token,expect.objectContaining({message_id:11}),expect.any(Object));
  expect(saveMediaNote).toHaveBeenCalledWith("photo",expect.objectContaining({
    file:expect.objectContaining({uri:"file:///cache/photo.jpg"}),
    body:"Подпись к фотографии",receipt:"telegram-bot:456:12345:11",
  }),expect.any(Object));
  expect(remove).toHaveBeenCalledTimes(1);
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("photo",456,"12345",11);
});
test("a failed original save cleans temporary file and never acknowledges the Telegram update",async()=>{
  const remove=jest.fn();
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce({
    file:{uri:"file:///cache/voice.ogg",name:"voice.ogg",mimeType:"audio/ogg",size:90},remove,
  });
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:12,message:{...msg(12,""),voice:{file_id:"AwACfile123"}},
  }]);
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error("SQLCipher unavailable"));
  await expect(syncTelegramBotText("voice")).rejects.toThrow("SQLCipher unavailable");
  expect(remove).toHaveBeenCalledTimes(1);
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});
test("non-file Telegram objects do not disappear from the queue on ACK",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:13,message:{...msg(13,""),location:{latitude:1,longitude:2}},
  }]);
  await expect(syncTelegramBotText("location")).rejects.toThrow("неподдержанный объект");
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
  expect(prepareBotOriginal).not.toHaveBeenCalled();
});

test("AppLock aborts an in-flight Telegram media download without cursor ACK",async()=>{
  let change:(unlocked:boolean)=>void=()=>{};
  (onLocalMemorySessionChange as jest.Mock).mockImplementation(cb=>{change=cb;return ()=>{};});
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:14,message:{...msg(14,""),photo:[{file_id:"AgACbig12345"}]},
  }]);
  (prepareBotOriginal as jest.Mock).mockImplementation(
    (_token:string,_message:unknown,signal:AbortSignal)=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("Импорт Telegram отменён.")),{once:true});
    }));
  const pending=syncTelegramBotText("locked");
  // Allow the protected config, fetch and media selection to settle.
  await new Promise(resolve=>setImmediate(resolve));
  change(false);
  await expect(pending).rejects.toThrow("Импорт Telegram отменён");
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});

test("replayed Telegram message does not count as newly imported",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{update_id:15,message:msg(15,"Сохранённый текст")}]);
  (saveMediaNote as jest.Mock).mockImplementationOnce(async(_profile:unknown,input:{onReplay?:()=>void})=>{
    input.onReplay?.();
    return "existing-note";
  });
  expect(await syncTelegramBotText("replay")).toEqual({imported:0,skipped:1,lastUpdate:15});
  expect(scheduleVectors).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("replay",456,"12345",15);
});
test("media with a /start caption is not silently skipped as a command",async()=>{
  const remove=jest.fn();
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce({
    file:{uri:"file:///cache/photo.jpg",name:"photo.jpg",mimeType:"image/jpeg",size:90},remove,
  });
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([{
    update_id:16,message:{...msg(16,"/start"),photo:[{file_id:"AgACbig12345"}]},
  }]);
  const result=await syncTelegramBotText("media-command");
  expect(result.imported).toBe(1);
  expect(saveMediaNote).toHaveBeenCalledWith("media-command",
    expect.objectContaining({file:expect.objectContaining({name:"photo.jpg"})}),expect.any(Object));
  expect(remove).toHaveBeenCalledTimes(1);
});
