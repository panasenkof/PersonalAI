import {importEntireSavedHistory,savedHistoryFailure} from "../full-history";
import {importSavedTextPage} from "../saved-import";
import {readSavedMessagesPage} from "../saved-messages";
import {
  clearSavedHistoryCheckpoint,loadSavedHistoryCheckpoint,saveSavedHistoryCheckpoint,
  type SavedHistoryCheckpoint,
} from "../settings";
import {localMemorySessionUnlocked} from "../../local-memory/storage";

jest.mock("../saved-import",()=>({importSavedTextPage:jest.fn()}));
jest.mock("../saved-messages",()=>({readSavedMessagesPage:jest.fn()}));
jest.mock("../saved-topics",()=>({safeTopicId:(v:string)=>/^(0|-?[1-9][0-9]{0,15})$/.test(v)}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../settings",()=>({
  loadSavedHistoryCheckpoint:jest.fn(),
  saveSavedHistoryCheckpoint:jest.fn(),
  clearSavedHistoryCheckpoint:jest.fn(),
}));
let stored:SavedHistoryCheckpoint|null=null;
const first=(nextCursor:string,saved=2)=>({
  selfChatId:"12345",maxMessageId:"100",minMessageId:nextCursor||"90",nextCursor,
  saved,duplicates:0,unsupported:0,empty:0,withFiles:0,tooLarge:0,
});
const completed={...first("",1),maxMessageId:"79"};
beforeEach(()=>{
  jest.clearAllMocks();
  stored=null;
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (loadSavedHistoryCheckpoint as jest.Mock).mockImplementation(async()=>stored);
  (saveSavedHistoryCheckpoint as jest.Mock).mockImplementation(async(_:string,c:SavedHistoryCheckpoint)=>{
    stored={...c};
  });
  (clearSavedHistoryCheckpoint as jest.Mock).mockImplementation(async()=>{stored=null;});
  (readSavedMessagesPage as jest.Mock).mockResolvedValue({
    selfChatId:"12345",messages:[],nextCursor:"",
  });
});
test("whole Saved history uses the one canonical importer and cleans completed checkpoint",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce(first("90"))
    .mockResolvedValueOnce({...completed,duplicates:1});
  const seen:SavedHistoryCheckpoint[]=[];
  const result=await importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,x=>seen.push({...x}));
  expect(result.status).toBe("completed");
  expect(result.progress).toMatchObject({processed:4,saved:3,duplicates:1,pages:2});
  expect(importSavedTextPage).toHaveBeenNthCalledWith(1,"guest","0",
    expect.any(Object),undefined,"supported-originals",undefined);
  expect(importSavedTextPage).toHaveBeenNthCalledWith(2,"guest","90",
    expect.any(Object),undefined,"supported-originals",undefined);
  expect(stored).toBeNull();
  expect(seen[1]).toMatchObject({cursor:"90",pages:1,saved:2});
});
test("stopping between pages persists cursor and resume does not reload earlier pages",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce(first("90"))
    .mockResolvedValueOnce(completed);
  const stop=new AbortController();
  await expect(importEntireSavedHistory("guest",undefined,undefined,stop.signal,x=>{
    if(x.pages===1)stop.abort();
  })).rejects.toThrow("telegram_saved_import_cancelled");
  expect(stored).toMatchObject({cursor:"90",pages:1,saved:2});
  const resumed=await importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{},true);
  expect(resumed.status).toBe("completed");
  expect(resumed.progress.saved).toBe(3);
  expect(readSavedMessagesPage).toHaveBeenCalledWith("guest","0",1);
  expect((importSavedTextPage as jest.Mock).mock.calls.map(c=>c[1])).toEqual(["0","90"]);
});
test("unfinished album never loops or skips a source message",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce({
    ...first("0",0),pendingAlbum:2,
  });
  const result=await importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{});
  expect(result.status).toBe("pending_album");
  expect(stored).toMatchObject({cursor:"0",saved:0});
  expect(importSavedTextPage).toHaveBeenCalledTimes(1);
});
test("same-page cursor without pending album is retryable, not falsely complete",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce(first("0",0));
  const result=await importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{});
  expect(result.status).toBe("stalled");
  expect(stored?.cursor).toBe("0");
});
test("cannot reuse checkpoint for another selected topic, destination or account",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce(first("90"));
  const ctrl=new AbortController();
  await expect(importEntireSavedHistory("guest","17",{collectionId:"topic-section"},
    ctrl.signal,x=>{if(x.pages)ctrl.abort();})).rejects.toThrow("telegram_saved_import_cancelled");
  expect(stored).toMatchObject({topicId:"17",targetId:"topic-section",cursor:"90"});
  await expect(importEntireSavedHistory("guest","18",{collectionId:"topic-section"},
    new AbortController().signal,()=>{},true)).rejects.toThrow("telegram_history_resume_scope_changed");
  await expect(importEntireSavedHistory("guest","17",undefined,
    new AbortController().signal,()=>{},true)).rejects.toThrow("telegram_history_resume_scope_changed");
  (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce({
    selfChatId:"99999",messages:[],nextCursor:"",
  });
  await expect(importEntireSavedHistory("guest","17",{collectionId:"topic-section"},
    new AbortController().signal,()=>{},true)).rejects.toThrow("telegram_saved_account_changed");
  expect(importSavedTextPage).toHaveBeenCalledTimes(1);
});
test("flood wait leaves the last committed page and a sanitized backoff message",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce(first("90"))
    .mockRejectedValueOnce(new Error("tdlib_flood_wait_70 PRIVATE PHONE"));
  await expect(importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{})).rejects.toThrow("tdlib_flood_wait_70");
  expect(stored?.cursor).toBe("90");
  expect(savedHistoryFailure(new Error("tdlib_flood_wait_70 PRIVATE PHONE"))).toMatch(/2 мин/);
  expect(savedHistoryFailure(new Error("tdlib_flood_wait_70 PRIVATE PHONE"))).not.toMatch(/PRIVATE/);
});
test("lock during a page prevents advancing the durable checkpoint",async()=>{
  (importSavedTextPage as jest.Mock).mockImplementationOnce(async()=>{
    (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
    return first("90");
  });
  await expect(importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{})).rejects.toThrow("telegram_app_locked");
  expect(stored).toMatchObject({cursor:"0",pages:0});
});
test("invalid and missing resume checkpoint never start an import",async()=>{
  await expect(importEntireSavedHistory("guest",undefined,undefined,
    new AbortController().signal,()=>{},true)).rejects.toThrow("telegram_history_resume_scope_changed");
  await expect(importEntireSavedHistory("guest","nope",undefined,
    new AbortController().signal,()=>{})).rejects.toThrow("telegram_history_scope_invalid");
  expect(importSavedTextPage).not.toHaveBeenCalled();
});
