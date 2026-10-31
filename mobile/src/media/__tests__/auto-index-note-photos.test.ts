import { autoIndexNotePhotos83 } from "../auto-index-note-photos";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../../local-memory/storage";
import { readyNativeVisionModel83 } from "../vision-native-model";
import { indexSavedPhoto83 } from "../vision-index-attachment";
import { fingerprintExtractionSource } from "../../local-memory/extractions";

jest.mock("../../local-memory/storage",()=>({
 localMemorySessionUnlocked:jest.fn(),
 withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../vision-native-model",()=>({readyNativeVisionModel83:jest.fn()}));
jest.mock("../vision-index-attachment",()=>({indexSavedPhoto83:jest.fn()}));
jest.mock("../../local-memory/extractions",()=>({fingerprintExtractionSource:jest.fn()}));
const unlocked=localMemorySessionUnlocked as jest.Mock;
const lease=withLocalMemoryDatabase as jest.Mock;
const model=readyNativeVisionModel83 as jest.Mock;
const index=indexSavedPhoto83 as jest.Mock;
const fingerprint=fingerprintExtractionSource as jest.Mock;
const getAll=jest.fn();
beforeEach(()=>{
  jest.resetAllMocks();
  unlocked.mockReturnValue(true);
  lease.mockImplementation((_p:string, callback:any)=>callback({getAllAsync:getAll}));
  model.mockResolvedValue({modelSpace:"space"});
  index.mockImplementation(async (_p:string,id:string)=>({indexed:true,attachmentId:id,modelSpace:"space"}));
  fingerprint.mockResolvedValue("latest");
  getAll.mockResolvedValue([
    {attachmentId:"already",indexedVersion:"latest"},
    {attachmentId:"new",indexedVersion:null},
  ]);
});
test("indexes only missing vectors after note commit and skips unchanged originals",async()=>{
  expect(await autoIndexNotePhotos83("guest","note-1")).toEqual({indexed:1,current:1,pending:0,failed:0});
  expect(index).toHaveBeenCalledTimes(1);
  expect(index).toHaveBeenCalledWith("guest","new",undefined);
  expect(getAll.mock.calls[0][0]).toContain("e.sensitivity IN ('standard','inherit')");
  expect(getAll.mock.calls[0][0]).toContain("c.sensitivity='standard'");
  expect(getAll.mock.calls[0][1]).toEqual(["space","note-1"]);
});
test("if model missing keep derived vectors pending without invoking native inference",async()=>{
  model.mockResolvedValue(null);
  const status=await autoIndexNotePhotos83("guest","note-1");
  expect(status).toEqual({indexed:0,current:0,pending:2,failed:0});
  expect(index).not.toHaveBeenCalled();
});
test("one corrupt image does not prevent next image from indexing",async()=>{
  getAll.mockResolvedValue([{attachmentId:"bad",indexedVersion:null},{attachmentId:"new",indexedVersion:null}]);
  index.mockRejectedValueOnce(new Error("native error"));
  expect(await autoIndexNotePhotos83("guest","note-1")).toEqual({indexed:1,current:0,pending:0,failed:1});
});
test("app lock aborts the pass without staging files",async()=>{
  unlocked.mockReturnValue(false);
  await expect(autoIndexNotePhotos83("guest","note-1")).rejects.toThrow("application_locked");
  expect(lease).not.toHaveBeenCalled();
});
