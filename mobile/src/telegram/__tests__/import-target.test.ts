import {
  telegramTargetOptions,requireTelegramTarget,loadTelegramImportTarget,
  loadTelegramTargetForWrite,chooseTelegramImportTarget,
} from "../import-target";
import {loadTelegramTargetId,saveTelegramTargetId} from "../settings";
import {localMemoryRepository} from "../../local-memory/repository";
import {proposableMemorySections} from "../../direct-agent/memory";
jest.mock("../settings",()=>({
 loadTelegramTargetId:jest.fn(),saveTelegramTargetId:jest.fn(),
}));
jest.mock("../../local-memory/repository",()=>({localMemoryRepository:jest.fn()}));
jest.mock("../../direct-agent/memory",()=>({proposableMemorySections:jest.fn()}));
const collections=[
 {id:"section-1",name:"Учёба",slug:"study",description:null,sensitivity:"standard",created_at:"2026",parent_id:null},
 {id:"private-1",name:"Входящие",slug:"inbox",description:null,sensitivity:"sensitive",created_at:"2026",parent_id:null},
];
beforeEach(()=>{
 jest.clearAllMocks();
 (localMemoryRepository as jest.Mock).mockResolvedValue({
   listCollections:jest.fn(async()=>collections),
 });
 (proposableMemorySections as jest.Mock).mockResolvedValue([
   {slug:"study",name:"Учёба",path:"Учёба"},
   {slug:"inbox",name:"Входящие",path:"Входящие"},
 ]);
 (loadTelegramTargetId as jest.Mock).mockResolvedValue("");
 (saveTelegramTargetId as jest.Mock).mockResolvedValue(undefined);
});
test("default Inbox is sensitive and only standard sections can be selected",async()=>{
 expect(await requireTelegramTarget("guest")).toEqual({sensitivity:"sensitive"});
 expect(await telegramTargetOptions("guest")).toEqual([{id:"section-1",name:"Учёба"}]);
 await expect(chooseTelegramImportTarget("guest","saved","private-1"))
   .rejects.toThrow("telegram_target_unavailable");
 expect(saveTelegramTargetId).not.toHaveBeenCalled();
 await chooseTelegramImportTarget("guest","bot","section-1");
 expect(saveTelegramTargetId).toHaveBeenCalledWith("guest","bot","section-1");
 expect(await requireTelegramTarget("guest",{collectionId:"section-1"}))
   .toEqual({sensitivity:"standard",collectionId:"section-1"});
});
test("stale section is invisible to UI but fail closed at write",async()=>{
 (loadTelegramTargetId as jest.Mock).mockResolvedValue("private-1");
 expect(await loadTelegramImportTarget("guest","saved")).toBeUndefined();
 await expect(loadTelegramTargetForWrite("guest","saved"))
   .rejects.toThrow("telegram_target_unavailable");
});
