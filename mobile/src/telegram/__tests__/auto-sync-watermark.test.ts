import {syncNewSavedText} from "../saved-import";
import {importSavedTextPage} from "../saved-import";
import {loadSavedWatermark,saveSavedWatermark} from "../settings";
import {localMemorySessionUnlocked} from "../../local-memory/storage";

jest.mock("../settings",()=>({loadSavedWatermark:jest.fn(),saveSavedWatermark:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../saved-messages",()=>({readSavedMessagesPage:jest.fn()}));
jest.mock("../saved-topics",()=>({safeTopicId:jest.fn()}));
jest.mock("../saved-original",()=>({supportsSavedOriginal:()=>false}));
jest.mock("../../media/attachments",()=>({saveMediaNote:jest.fn(),MAX_TOTAL_ORIGINAL_BYTES:80*1024*1024}));
jest.mock("../../media/vector-runner",()=>({scheduleVectors:jest.fn()}));
const {readSavedMessagesPage}=require("../saved-messages");
const {saveMediaNote}=require("../../media/attachments");
const page=(top:number,bottom:number)=>({
 selfChatId:"12345",messages:Array.from({length:top-bottom+1},(_,i)=>({
 id:String(top-i),date:1794300000,kind:"messageText",text:"текст",hasMedia:false
 })),nextCursor:String(bottom),
});
beforeEach(()=>{
 jest.clearAllMocks();
 (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
 (saveMediaNote as jest.Mock).mockResolvedValue("note-id");
 (loadSavedWatermark as jest.Mock).mockResolvedValue(null);
});
test("first auto sync reads a page and stores watermark after writing",async()=>{
 (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce(page(10,1))
  .mockResolvedValueOnce({selfChatId:"12345",messages:[],nextCursor:""});
 expect(await syncNewSavedText("guest")).toMatchObject({saved:10,gap:false});
 expect(saveSavedWatermark).toHaveBeenCalledWith("guest",{selfChatId:"12345",maxMessageId:"10"});
});
test("watermark terminates an incremental sync without losing 45 messages",async()=>{
 (loadSavedWatermark as jest.Mock).mockResolvedValue({selfChatId:"12345",maxMessageId:"100"});
 (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce(page(145,126))
  .mockResolvedValueOnce(page(125,106))
  .mockResolvedValueOnce(page(105,86));
 const result=await syncNewSavedText("guest");
 expect(result).toMatchObject({gap:false});
 expect(result.saved).toBe(60); // page including the watermark is intentionally deduplicated by writer
 expect(saveSavedWatermark).toHaveBeenCalledWith("guest",{selfChatId:"12345",maxMessageId:"145"});
});
test("five pages without old watermark flag a gap",async()=>{
 (loadSavedWatermark as jest.Mock).mockResolvedValue({selfChatId:"12345",maxMessageId:"1"});
 (readSavedMessagesPage as jest.Mock).mockImplementation(async(_p:string,cursor:string)=>cursor==="0"?page(150,131):
  page(Number(cursor)-1,Number(cursor)-20));
 const result=await syncNewSavedText("guest");
 expect(result.gap).toBe(true);
 expect(readSavedMessagesPage).toHaveBeenCalledTimes(5);
});
test("lock in middle prevents watermark advancement",async()=>{
 (readSavedMessagesPage as jest.Mock).mockResolvedValueOnce(page(3,1));
 (localMemorySessionUnlocked as jest.Mock).mockReturnValueOnce(true).mockReturnValueOnce(true)
  .mockReturnValueOnce(false);
 await expect(syncNewSavedText("guest")).rejects.toThrow("telegram_app_locked");
 expect(saveSavedWatermark).not.toHaveBeenCalled();
});
