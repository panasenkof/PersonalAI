import {importSavedTextPage} from "../saved-import";
import {readSavedMessagesPage} from "../saved-messages";
import {readSavedTopicPage} from "../saved-topics";
import {saveMediaNote} from "../../media/attachments";
import {scheduleVectors} from "../../media/vector-runner";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
import {downloadSavedOriginal,downloadSavedAlbumOriginal,releaseSavedOriginal} from "../saved-original";
jest.mock("../saved-messages",()=>({readSavedMessagesPage:jest.fn()}));
jest.mock("../saved-original",()=>({downloadSavedOriginal:jest.fn(),downloadSavedAlbumOriginal:jest.fn(),releaseSavedOriginal:jest.fn(),
  supportsSavedOriginal:(kind:string)=>["messagePhoto","messageDocument","messageVideo",
    "messageAudio","messageVoiceNote","messageAnimation","messageVideoNote"].includes(kind)}));
jest.mock("../saved-topics",()=>({readSavedTopicPage:jest.fn(),safeTopicId:(v:string)=>typeof v==="string"&&/^(0|-?[1-9][0-9]{0,15})$/.test(v)&&Number.isSafeInteger(Number(v))}));
jest.mock("../../media/attachments",()=>({saveMediaNote:jest.fn(),MAX_TOTAL_ORIGINAL_BYTES:80*1024*1024}));
jest.mock("../../media/vector-runner",()=>({scheduleVectors:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
const item=(id:string,text:string,kind="messageText",hasMedia=false)=>({
  id,date:1794300000,kind,text,hasMedia,
});
beforeEach(()=>{
  jest.clearAllMocks();
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (readSavedMessagesPage as jest.Mock).mockResolvedValue({
    selfChatId:"12345",messages:[item("50","Заметка"),item("49","Другой текст")],nextCursor:"49",
  });
  (saveMediaNote as jest.Mock).mockResolvedValue("note-1");
  (releaseSavedOriginal as jest.Mock).mockResolvedValue(undefined);
  (downloadSavedOriginal as jest.Mock).mockResolvedValue({
    file:{uri:"file:///data/persai-tdlib-guest/files/photo.jpg",name:"photo.jpg",mimeType:"image/jpeg",size:40},
  });
  (downloadSavedAlbumOriginal as jest.Mock).mockImplementation(async (_profile:string,_chat:string,preview:{id:string;kind:string;albumId:string;text:string;date:number})=>({
    file:{uri:"file:///data/persai-tdlib-guest/files/"+preview.id+".jpg",name:preview.id+".jpg",mimeType:"image/jpeg",size:40},
    chatId:"12345",messageId:preview.id,kind:preview.kind,albumId:preview.albumId,text:preview.text,date:preview.date,
  }));
  (readSavedTopicPage as jest.Mock).mockResolvedValue({selfChatId:"12345",messages:[item("50","Заметка")],nextCursor:"50"});
});
test("imports newest self-chat text using existing canonical writer and immutable source IDs",async()=>{
  expect(await importSavedTextPage("guest")).toEqual({
    saved:2,duplicates:0,unsupported:0,empty:0,nextCursor:"49",selfChatId:"12345",
  });
  expect(readSavedMessagesPage).toHaveBeenCalledWith("guest","0",20);
  expect(saveMediaNote).toHaveBeenCalledTimes(2);
  expect((saveMediaNote as jest.Mock).mock.calls[0][1]).toMatchObject({
    title:"Другой текст",body:"Другой текст",sensitivity:"sensitive",
    receipt:"telegram-saved:12345:49",
    telegramSavedMessage:{chatId:"12345",messageId:"49",date:1794300000,kind:"messageText"},
  });
  expect((saveMediaNote as jest.Mock).mock.calls[1][1]).toMatchObject({
    receipt:"telegram-saved:12345:50",
  });
  expect(scheduleVectors).toHaveBeenCalledWith("guest");
});
test("existing source does not produce duplicate note or re-run vectors",async()=>{
  (saveMediaNote as jest.Mock).mockImplementation(async(_profile:string,input:any)=>{
    input.onReplay({entityId:"note-1",recordStatus:"archived"});
    return "note-1";
  });
  const result=await importSavedTextPage("guest","55");
  expect(result.duplicates).toBe(2);
  expect(result.saved).toBe(0);
  expect(scheduleVectors).not.toHaveBeenCalled();
  expect(readSavedMessagesPage).toHaveBeenCalledWith("guest","55",20);
});
test("skips media instead of saving misleading caption-only notes, and reports missing data",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[
      item("9","Подпись","messageDocument",true),
      item("8","","messagePhoto",true),
      item("7","","messageText",false),
      item("6","Настоящий текст")
    ],nextCursor:"6",
  });
  const result=await importSavedTextPage("guest");
  expect(result).toMatchObject({saved:1,duplicates:0,unsupported:2,empty:1,nextCursor:"6"});
  expect(saveMediaNote).toHaveBeenCalledTimes(1);
  expect((saveMediaNote as jest.Mock).mock.calls[0][1].receipt).toBe("telegram-saved:12345:6");
});
test("SQLCipher rejection never produces a success report; retry may replay stable receipt",async()=>{
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error("SQLCipher unavailable"));
  await expect(importSavedTextPage("guest")).rejects.toThrow("SQLCipher unavailable");
  expect(scheduleVectors).not.toHaveBeenCalled();
  await expect(importSavedTextPage("guest")).resolves.toMatchObject({saved:2});
});
test("locked session prevents any Telegram reads or writes",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  await expect(importSavedTextPage("guest")).rejects.toThrow("telegram_app_locked");
  expect(readSavedMessagesPage).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});
test("AppLock after network read prevents saving",async()=>{
  (localMemorySessionUnlocked as jest.Mock)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);
  await expect(importSavedTextPage("guest")).rejects.toThrow("telegram_app_locked");
  expect(saveMediaNote).not.toHaveBeenCalled();
});
test("parallel import for same profile is rejected rather than racing DB cursor",async()=>{
  let release:(value:any)=>void=()=>{};
  (readSavedMessagesPage as jest.Mock).mockImplementationOnce(
    ()=>new Promise(resolve=>{release=resolve;}));
  const first=importSavedTextPage("guest");
  await expect(importSavedTextPage("guest")).rejects.toThrow("telegram_saved_import_running");
  release({selfChatId:"12345",messages:[],nextCursor:""});
  expect(await first).toMatchObject({saved:0});
});
test("cancelled run fails without writing source data",async()=>{
  const controller=new AbortController();controller.abort();
  await expect(importSavedTextPage("guest","0",controller.signal))
    .rejects.toThrow("telegram_saved_import_cancelled");
  expect(readSavedMessagesPage).not.toHaveBeenCalled();
});

test("topic and global history share the same canonical receipt; topic ID is only metadata",async()=>{
  await importSavedTextPage("guest","0",undefined,"-1005432");
  expect(readSavedTopicPage).toHaveBeenCalledWith("guest","-1005432","0",20);
  expect(readSavedMessagesPage).not.toHaveBeenCalled();
  expect((saveMediaNote as jest.Mock).mock.calls[0][1]).toMatchObject({
    receipt:"telegram-saved:12345:50",
    telegramSavedMessage:{chatId:"12345",messageId:"50",date:1794300000,kind:"messageText",topicId:"-1005432"},
  });
});
test("cannot supply arbitrary malformed topic ID or bypass AppLock",async()=>{
  await expect(importSavedTextPage("guest","0",undefined,"--999"))
    .rejects.toThrow("telegram_saved_topic_request_invalid");
  expect(readSavedTopicPage).not.toHaveBeenCalled();
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  await expect(importSavedTextPage("guest","0",undefined,"1"))
    .rejects.toThrow("telegram_app_locked");
});
test("topic media and captions never become a false text-only note",async()=>{
  (readSavedTopicPage as jest.Mock).mockResolvedValueOnce({selfChatId:"12345",messages:[
    item("50","Подпись к видео","messageVideo",true),item("49","Нормальный текст"),
  ],nextCursor:"49"});
  expect(await importSavedTextPage("guest","0",undefined,"0"))
    .toMatchObject({saved:1,unsupported:1});
  expect(saveMediaNote).toHaveBeenCalledTimes(1);
  expect((saveMediaNote as jest.Mock).mock.calls[0][1].receipt)
    .toBe("telegram-saved:12345:49");
});

test("explicit manual mode stores Saved photo ORIGINAL with its caption and stable source receipt",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[item("60","Новая фотография","messagePhoto",true)],
    nextCursor:"60",
  });
  const result=await importSavedTextPage("guest","0",undefined,undefined,"supported-originals");
  expect(result).toMatchObject({saved:1,duplicates:0,unsupported:0});
  expect(downloadSavedOriginal).toHaveBeenCalledWith("guest","12345",
    expect.objectContaining({id:"60",kind:"messagePhoto"}),undefined);
  expect(saveMediaNote).toHaveBeenCalledWith("guest",expect.objectContaining({
    body:"Новая фотография",
    file:expect.objectContaining({name:"photo.jpg",mimeType:"image/jpeg"}),
    receipt:"telegram-saved:12345:60",
    telegramSavedMessage:expect.objectContaining({
      messageId:"60",chatId:"12345",kind:"messagePhoto",
    }),
  }),undefined);
});
test("on-open text-only mode does NOT download Saved originals silently",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[item("60","Новая фотография","messagePhoto",true)],
    nextCursor:"60",
  });
  const result=await importSavedTextPage("guest","0");
  expect(result).toMatchObject({saved:0,unsupported:1});
  expect(downloadSavedOriginal).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});
test("failed original download does not save caption-only note or claim successful import",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[item("60","Подпись","messagePhoto",true)],nextCursor:"60",
  });
  (downloadSavedOriginal as jest.Mock).mockRejectedValueOnce(new Error("tdlib_request_timeout"));
  await expect(importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .rejects.toThrow("tdlib_request_timeout");
  expect(saveMediaNote).not.toHaveBeenCalled();
});


test("TDLib Saved album is not split into misleading independent original notes",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[
      {...item("61","Подпись 2","messagePhoto",true),hasAlbum:true},
      {...item("60","Подпись 1","messagePhoto",true),hasAlbum:true},
    ],nextCursor:"60",
  });
  expect(await importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .toMatchObject({saved:0,unsupported:2});
  expect(downloadSavedOriginal).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});

test("successful original import releases the TDLib cache only AFTER canonical SQLCipher write",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[item("70","Фото","messagePhoto",true)],nextCursor:"70",
  });
  let wrote=false;
  (saveMediaNote as jest.Mock).mockImplementationOnce(async()=>{
    wrote=true;
    expect(releaseSavedOriginal).not.toHaveBeenCalled();
    return "note-id";
  });
  (releaseSavedOriginal as jest.Mock).mockImplementationOnce(async()=>{expect(wrote).toBe(true);});
  const result=await importSavedTextPage("guest","0",undefined,undefined,"supported-originals");
  expect(result.saved).toBe(1);
  expect(releaseSavedOriginal).toHaveBeenCalledWith("guest",expect.objectContaining({
    file:expect.objectContaining({name:"photo.jpg"}),
  }));
});
test("SQLCipher failure still attempts to reclaim the specific staged original",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[item("70","Фото","messagePhoto",true)],nextCursor:"70",
  });
  (saveMediaNote as jest.Mock).mockRejectedValueOnce(new Error("SQLCipher transaction failed"));
  await expect(importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .rejects.toThrow("SQLCipher transaction failed");
  expect(releaseSavedOriginal).toHaveBeenCalledTimes(1);
});

const grouped=(id:string,caption="",group="9007199254740993")=>({
  ...item(id,caption,"messagePhoto",true),hasAlbum:true,albumId:group,
});
test("complete native Saved album has one canonical note with all originals, captions and stable receipt",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[
      grouped("73","Второе"),grouped("72","Первое"),item("71","Старая заметка"),
    ],nextCursor:"71",
  });
  const result=await importSavedTextPage("guest","0",undefined,undefined,"supported-originals");
  expect(result).toMatchObject({saved:2,unsupported:0,nextCursor:"71"});
  expect(downloadSavedAlbumOriginal).toHaveBeenCalledTimes(2);
  expect(saveMediaNote).toHaveBeenCalledWith("guest",expect.objectContaining({
    body:"Файл 1: Первое\n\nФайл 2: Второе",
    files:[expect.objectContaining({name:"72.jpg"}),expect.objectContaining({name:"73.jpg"})],
    receipt:"telegram-saved:12345:72:album:9007199254740993:72,73",
    telegramSavedMessage:expect.objectContaining({
      chatId:"12345",messageId:"72",kind:"messageAlbum",
      mediaAlbumId:"9007199254740993",messageIds:["72","73"],
    }),
  }),undefined);
  expect(releaseSavedOriginal).toHaveBeenCalledTimes(2);
});
test("album spanning a page edge fetches only bounded older context before one complete save",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("103","newest"),grouped("102","middle")],nextCursor:"102",
  }).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("101","oldest"),item("100","Boundary")],nextCursor:"100",
  });
  expect(await importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .toMatchObject({saved:2,unsupported:0,nextCursor:"100"});
  expect(readSavedMessagesPage).toHaveBeenNthCalledWith(2,"guest","102",20);
  expect(downloadSavedAlbumOriginal).toHaveBeenCalledTimes(3);
  expect((saveMediaNote as jest.Mock).mock.calls.find(c=>c[1].telegramSavedMessage?.kind==="messageAlbum")![1]
    .telegramSavedMessage.messageIds).toEqual(["101","102","103"]);
});
test("tail album without boundary remains pending, no partial note or skipped paging cursor",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("73"),grouped("72")],nextCursor:"72",
  }).mockResolvedValueOnce({selfChatId:"12345",messages:[],nextCursor:""});
  const result=await importSavedTextPage("guest","0",undefined,undefined,"supported-originals");
  expect(result).toMatchObject({saved:0,unsupported:0,pendingAlbum:2,nextCursor:"0"});
  expect(downloadSavedAlbumOriginal).not.toHaveBeenCalled();
  expect(saveMediaNote).not.toHaveBeenCalled();
});
test("failure on a later album download releases staged originals and never saves incomplete album",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("73"),grouped("72"),item("71","Boundary")],nextCursor:"71",
  });
  (downloadSavedAlbumOriginal as jest.Mock)
    .mockResolvedValueOnce({file:{uri:"file:///72.jpg",name:"72.jpg",mimeType:"image/jpeg",size:40}})
    .mockRejectedValueOnce(new Error("tdlib_request_timeout"));
  await expect(importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .rejects.toThrow("tdlib_request_timeout");
  // The older boundary note may be saved first, but no album exists.
  expect((saveMediaNote as jest.Mock).mock.calls.some(c=>c[1].telegramSavedMessage?.kind==="messageAlbum")).toBe(false);
  expect(releaseSavedOriginal).toHaveBeenCalledTimes(1);
});
test("SQLCipher album failure cleans every downloaded member and does not mark album successful",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("73"),grouped("72"),item("71","older")],nextCursor:"71",
  });
  (saveMediaNote as jest.Mock).mockResolvedValueOnce("older-note")
    .mockRejectedValueOnce(new Error("SQLCipher failed"));
  await expect(importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .rejects.toThrow("SQLCipher failed");
  expect(releaseSavedOriginal).toHaveBeenCalledTimes(2);
});
test("album replay uses canonical receipt, reports duplicate without vector reindex",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[grouped("73"),grouped("72"),item("71","")],nextCursor:"71",
  });
  (saveMediaNote as jest.Mock).mockImplementation(async(_profile:string,input:{onReplay?:()=>void})=>{
    input.onReplay?.();return "already-saved";
  });
  expect(await importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .toMatchObject({saved:0,duplicates:1});
  expect(scheduleVectors).not.toHaveBeenCalled();
});
test("album exceeding existing 80 MiB cap never enters canonical writer",async()=>{
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"12345",messages:[
      grouped("85"),grouped("84"),grouped("83"),grouped("82"),grouped("81"),item("80",""),
    ],nextCursor:"80",
  });
  (downloadSavedAlbumOriginal as jest.Mock).mockImplementation(async()=>({
    file:{uri:"file:///large.jpg",name:"large.jpg",mimeType:"image/jpeg",size:20*1024*1024},
  }));
  await expect(importSavedTextPage("guest","0",undefined,undefined,"supported-originals"))
    .rejects.toThrow("80 МБ");
  expect((saveMediaNote as jest.Mock).mock.calls.some(c=>c[1].telegramSavedMessage?.kind==="messageAlbum")).toBe(false);
  expect(releaseSavedOriginal).toHaveBeenCalledTimes(5);
});
