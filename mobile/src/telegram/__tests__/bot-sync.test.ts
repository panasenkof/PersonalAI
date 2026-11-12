import {syncTelegramBotText,TelegramBotBlocked,skipBlockedBotUpdate} from "../bot-sync";
import {fetchBotUpdates} from "../bot-api";
import {prepareBotOriginal} from "../bot-media";
import {advanceTelegramBotCursor,loadTelegramBotConfig} from "../bot-settings";
import {saveMediaNote} from "../../media/attachments";
import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../../local-memory/storage";
import {scheduleVectors} from "../../media/vector-runner";
jest.mock("../bot-api",()=>({fetchBotUpdates:jest.fn()}));
jest.mock("../bot-media",()=>({prepareBotOriginal:jest.fn()}));
jest.mock("../bot-settings",()=>({loadTelegramBotConfig:jest.fn(),advanceTelegramBotCursor:jest.fn()}));
jest.mock("../../media/attachments",()=>({saveMediaNote:jest.fn(),MAX_TOTAL_ORIGINAL_BYTES:80*1024*1024}));
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
  expect(await syncTelegramBotText("p1")).toEqual({imported:1,skipped:2,duplicates:0,lastUpdate:3});
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
  await expect(syncTelegramBotText("p3")).rejects.toBeInstanceOf(TelegramBotBlocked);
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
  expect(await first).toEqual({imported:0,skipped:0,duplicates:0,lastUpdate:0});
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
  expect(await syncTelegramBotText("replay")).toEqual({imported:0,skipped:0,duplicates:1,lastUpdate:15});
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

const album=(updateId:number,caption="")=>({
  update_id:updateId,
  message:{message_id:updateId,chat:{id:12345,type:"private"},
    media_group_id:"albumA",photo:[{file_id:"AgACfile12345"}],caption},
});
const prepared=(name:string)=>({
  file:{uri:"file:///cache/"+name,name,mimeType:"image/jpeg",size:70},remove:jest.fn(),
});
test("album with explicit following message commits all originals before one group cursor ACK",async()=>{
  const a=prepared("first.jpg"),b=prepared("second.jpg");
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce(a).mockResolvedValueOnce(b);
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    album(21,"Первое"),album(22,"Второе"),{update_id:23,message:msg(23,"/done")},
  ]);
  const result=await syncTelegramBotText("album");
  expect(result).toEqual({imported:1,skipped:1,duplicates:0,lastUpdate:23});
  expect(prepareBotOriginal).toHaveBeenCalledTimes(2);
  expect(prepareBotOriginal).toHaveBeenNthCalledWith(
    1,token,expect.objectContaining({message_id:21}),expect.any(Object),true);
  expect(saveMediaNote).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).toHaveBeenCalledWith("album",expect.objectContaining({
    body:"Файл 1: Первое\n\nФайл 2: Второе",
    files:[a.file,b.file],
    botMessage:{botId:456,chatId:"12345",messageId:21,
      mediaGroupId:"albumA",messageIds:[21,22]},
    receipt:"telegram-bot:456:12345:21:album:albumA:21,22",
  }),expect.any(Object));
  expect(advanceTelegramBotCursor).toHaveBeenNthCalledWith(1,"album",456,"12345",22);
  expect(advanceTelegramBotCursor).toHaveBeenNthCalledWith(2,"album",456,"12345",23);
  expect(a.remove).toHaveBeenCalledTimes(1);
  expect(b.remove).toHaveBeenCalledTimes(1);
});
test("unfinished album remains pending with zero ACK or file downloads",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([album(21),album(22)]);
  expect(await syncTelegramBotText("pending")).toEqual({
    imported:0,skipped:0,lastUpdate:0,pendingAlbum:2,
  });
  expect(prepareBotOriginal).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});
test("partial album download failure releases previous temporary original without ACK",async()=>{
  const a=prepared("first.jpg");
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce(a)
    .mockRejectedValueOnce(new Error("Не удалось скачать оригинал Telegram."));
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    album(21),album(22),{update_id:23,message:msg(23,"/done")},
  ]);
  await expect(syncTelegramBotText("failed")).rejects.toThrow("скачать");
  expect(a.remove).toHaveBeenCalledTimes(1);
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});
test("canonical album replay keeps cursor idempotent without duplicate note",async()=>{
  const a=prepared("first.jpg"),b=prepared("second.jpg");
  (prepareBotOriginal as jest.Mock).mockResolvedValueOnce(a).mockResolvedValueOnce(b);
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    album(21),album(22),{update_id:23,message:msg(23,"/done")},
  ]);
  (saveMediaNote as jest.Mock).mockImplementationOnce(async(_profile:unknown,input:{onReplay?:()=>void})=>{
    input.onReplay?.();return "existing-album";
  });
  const result=await syncTelegramBotText("album-replay");
  expect(result.imported).toBe(0);
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("album-replay",456,"12345",22);
  expect(scheduleVectors).not.toHaveBeenCalled();
});

test("album cumulative size is bounded before SQLCipher write; staged originals are cleaned",async()=>{
  const files=Array.from({length:5},(_,i)=>prepared("original-"+i+".jpg"));
  for(const file of files){
    file.file.size=20_000_000;
    (prepareBotOriginal as jest.Mock).mockResolvedValueOnce(file);
  }
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    ...Array.from({length:5},(_,i)=>album(31+i)),
    {update_id:36,message:msg(36,"/done")},
  ]);
  await expect(syncTelegramBotText("large-album")).rejects.toThrow("80 МБ");
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
  expect(files.every(x=>x.remove.mock.calls.length===1)).toBe(true);
});

test("standalone /done is an album boundary command and never a memory note",async()=>{
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    {update_id:41,message:msg(41,"/done")},
  ]);
  expect(await syncTelegramBotText("boundary")).toEqual({imported:0,skipped:1,lastUpdate:41});
  expect(saveMediaNote).not.toHaveBeenCalled();
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("boundary",456,"12345",41);
});

test("already acknowledged update does not trap album sync in a retry loop",async()=>{
  (loadTelegramBotConfig as jest.Mock).mockResolvedValueOnce({
    token,botId:456,username:"MyPersAIBot",allowedChatId:"12345",cursor:20,
  });
  (fetchBotUpdates as jest.Mock).mockResolvedValueOnce([
    {update_id:20,message:msg(20,"Already acknowledged")},
    {update_id:21,message:msg(21,"Fresh")},
  ]);
  expect(await syncTelegramBotText("skip-stale")).toEqual({
    imported:1,skipped:0,lastUpdate:21,
  });
  expect(saveMediaNote).toHaveBeenCalledTimes(1);
  expect(advanceTelegramBotCursor).toHaveBeenCalledTimes(1);
  expect(advanceTelegramBotCursor).toHaveBeenCalledWith("skip-stale",456,"12345",21);
});

test("blocked unsupported poll can be explicitly skipped after rechecking live queue",async()=>{
 (fetchBotUpdates as jest.Mock).mockResolvedValue([
   {update_id:40,message:{...msg(40,""),poll:{id:"p"}}},
   {update_id:41,message:msg(41,"Следом текст")},
 ]);
 const outcome=syncTelegramBotText("block");
 await expect(outcome).rejects.toBeInstanceOf(TelegramBotBlocked);
 expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
 await skipBlockedBotUpdate("block",40);
 expect(advanceTelegramBotCursor).toHaveBeenCalledWith("block",456,"12345",40);
 (loadTelegramBotConfig as jest.Mock).mockResolvedValue({
   token,botId:456,username:"MyPersAIBot",allowedChatId:"12345",cursor:40,
 });
 (fetchBotUpdates as jest.Mock).mockResolvedValue([{update_id:41,message:msg(41,"Следом текст")}]);
 expect(await syncTelegramBotText("block")).toMatchObject({imported:1,duplicates:0,lastUpdate:41});
});
test("skip denies stale or foreign-chat blockers",async()=>{
 (fetchBotUpdates as jest.Mock).mockResolvedValue([
   {update_id:7,message:msg(7,"Not owner",900)},
   {update_id:8,message:{...msg(8,""),sticker:{}}},
   {update_id:9,message:{...msg(9,""),poll:{}}},
 ]);
 await expect(skipBlockedBotUpdate("p1",9)).rejects.toThrow("telegram_bot_queue_changed");
 expect(advanceTelegramBotCursor).not.toHaveBeenCalled();
});
test("edited owner update is typed blocker",async()=>{
 (fetchBotUpdates as jest.Mock).mockResolvedValue([
   {update_id:11,edited_message:msg(11,"changed")},
 ]);
 await expect(syncTelegramBotText("edited")).rejects.toMatchObject({
   reason:"edited",updateId:11,
 });
});
