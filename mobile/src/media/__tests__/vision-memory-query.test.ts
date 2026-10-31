import { searchWithVision83 } from "../vision-memory-query";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../../local-memory/storage";
import { readyNativeVisionModel83 } from "../vision-native-model";
import { embedVisionText83 } from "../vision-native-vectors";
import { SqliteMemoryRepository } from "../../local-memory/repository";

jest.mock("../../local-memory/storage",()=>({
  localMemorySessionUnlocked:jest.fn(),withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../vision-native-model",()=>({readyNativeVisionModel83:jest.fn()}));
jest.mock("../vision-native-vectors",()=>({embedVisionText83:jest.fn()}));
jest.mock("../../local-memory/repository",()=>({SqliteMemoryRepository:jest.fn()}));
const unlocked=localMemorySessionUnlocked as jest.Mock;
const database=withLocalMemoryDatabase as jest.Mock;
const model=readyNativeVisionModel83 as jest.Mock;
const vector=embedVisionText83 as jest.Mock;
const Repo=SqliteMemoryRepository as jest.Mock;
const mockSearch=jest.fn();
const active={
 modelSpace:"eg2|vision|768|sha256:"+"a".repeat(64),
 modelName:"eg2-model.litertlm",modelSha256:"a".repeat(64),
};
beforeEach(()=>{
 jest.clearAllMocks();
 unlocked.mockReturnValue(true);
 database.mockImplementation(async (_:string,work:(db:unknown)=>Promise<unknown>)=>work({}));
 model.mockResolvedValue(active);
 vector.mockResolvedValue(new Float32Array([1,...Array(767).fill(0)]));
 Repo.mockImplementation(()=>({searchMemory:mockSearch}));
 mockSearch.mockResolvedValue([{entity:{id:"note"},score:0.9,chunk:""}]);
});
test("image search uses canonical searchMemory with existing text MiniLM + scope, not parallel query",async()=>{
 const textVector={model:"minilm",values:new Float32Array([1,...Array(383).fill(0)])};
 const result=await searchWithVision83("guest","красный велосипед",{
   collectionIds:["photos"],sensitivities:["standard"],limit:7,vector:textVector,
 });
 expect(result).toEqual([expect.objectContaining({entity:{id:"note"}})]);
 expect(vector).toHaveBeenCalledWith({
   modelName:active.modelName,modelSha256:active.modelSha256,
 },"красный велосипед");
 expect(mockSearch).toHaveBeenCalledWith("красный велосипед",{
   collectionIds:["photos"],sensitivities:["standard"],limit:7,
   vector:textVector,imageVector:{model:active.modelSpace,values:expect.any(Float32Array)},
 });
 expect(database).toHaveBeenCalledTimes(1);
});
test("no installed vision model retains ordinary searchMemory and never invokes native",async()=>{
 model.mockResolvedValue(null);
 await searchWithVision83("guest","рецепт лазаньи",{limit:5});
 expect(vector).not.toHaveBeenCalled();
 expect(mockSearch).toHaveBeenCalledWith("рецепт лазаньи",{limit:5});
});
test("AppLock and invalid input reject before reading memory or native",async()=>{
 unlocked.mockReturnValue(false);
 await expect(searchWithVision83("guest","автомобиль")).rejects.toThrow("application_locked");
 unlocked.mockReturnValue(true);
 await expect(searchWithVision83("guest","  ")).rejects.toThrow("vision_invalid_search_query");
 await expect(searchWithVision83("guest","x".repeat(300))).rejects.toThrow("vision_invalid_search_query");
 expect(database).not.toHaveBeenCalled();
});
test("lock expiry after native call prevents result queries",async()=>{
 vector.mockImplementationOnce(async()=>{unlocked.mockReturnValue(false);return new Float32Array(768)});
 await expect(searchWithVision83("guest","велосипед")).rejects.toThrow("application_locked");
 expect(database).not.toHaveBeenCalled();
});
test("native failure never returns invented photo hits",async()=>{
 vector.mockRejectedValueOnce(new Error("native_failed"));
 await expect(searchWithVision83("guest","склад")).rejects.toThrow("native_failed");
 expect(mockSearch).not.toHaveBeenCalled();
});

test("explicit photo mode without installed model never disguises text-only hits as photo results",async()=>{
 model.mockResolvedValue(null);
 await expect(searchWithVision83("guest","птица у окна",{requireVisionModel:true}))
   .rejects.toThrow("vision_model_not_installed");
 expect(vector).not.toHaveBeenCalled();
 expect(mockSearch).not.toHaveBeenCalled();
 expect(database).not.toHaveBeenCalled();
});
