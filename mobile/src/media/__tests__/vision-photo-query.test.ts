import { preparePhotoMatchChatAttachment83 } from "../vision-photo-query";
import { localMemorySessionUnlocked } from "../../local-memory/storage";
import { readyNativeVisionModel83 } from "../vision-native-model";
import { embedVisionImage83 } from "../vision-native-vectors";
import type { ChatAttachment } from "../../direct-agent/chat-attachments";

const mockWrite=jest.fn(),mockCleanup=jest.fn();
jest.mock("expo-crypto",()=>({randomUUID:()=>"photo-query-test"}));
jest.mock("expo-file-system",()=>({
  Paths:{cache:{uri:"file:///app/cache"}},
  Directory:jest.fn().mockImplementation(()=>({create:jest.fn()})),
  File:jest.fn().mockImplementation((_:unknown,name:string)=>({
    name,exists:true,write:mockWrite,delete:mockCleanup,
  })),
}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("../vision-native-model",()=>({readyNativeVisionModel83:jest.fn()}));
jest.mock("../vision-native-vectors",()=>({embedVisionImage83:jest.fn()}));
const unlocked=localMemorySessionUnlocked as jest.Mock;
const model=readyNativeVisionModel83 as jest.Mock;
const native=embedVisionImage83 as jest.Mock;
const modelSpace="eg2|vision|768|sha256:"+"a".repeat(64);
const attachment:ChatAttachment={
  id:"photo",name:"велосипед.jpg",kind:"image",mime:"image/jpeg",
  data:Buffer.from([255,216,255,224,0,0,0,0]).toString("base64"),size:8,
};
beforeEach(()=>{
  jest.clearAllMocks();
  unlocked.mockReturnValue(true);
  model.mockResolvedValue({modelName:"eg2.litertlm",modelSha256:"a".repeat(64),modelSpace});
  native.mockResolvedValue(new Float32Array([1,...Array(767).fill(0)]));
});
test("chat JPEG is never stored, inference uses temporary private file, then deletes it",async()=>{
  const result=await preparePhotoMatchChatAttachment83(attachment);
  expect(result.model).toBe(modelSpace);
  expect(result.values.length).toBe(768);
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenCalledWith({
    modelName:"eg2.litertlm",modelSha256:"a".repeat(64),imageName:"photo-query-test.jpg",
  });
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});
test("reject damaged and nonimage attachments before native inference",async()=>{
  await expect(preparePhotoMatchChatAttachment83({...attachment,mime:"image/heic"}))
    .rejects.toThrow();
  await expect(preparePhotoMatchChatAttachment83({...attachment,data:"AAAA"}))
    .rejects.toThrow();
  expect(native).not.toHaveBeenCalled();
});
test("missing model cannot infer an image",async()=>{
  model.mockResolvedValue(null);
  await expect(preparePhotoMatchChatAttachment83(attachment)).rejects.toThrow("vision_model_not_installed");
  expect(mockWrite).not.toHaveBeenCalled();
});
test("native errors and lock expiry clean temporary query bytes",async()=>{
  native.mockRejectedValueOnce(new Error("native_failure"));
  await expect(preparePhotoMatchChatAttachment83(attachment)).rejects.toThrow("native_failure");
  expect(mockCleanup).toHaveBeenCalledTimes(1);
  native.mockImplementationOnce(async()=>{
    unlocked.mockReturnValue(false);
    return new Float32Array(768);
  });
  await expect(preparePhotoMatchChatAttachment83(attachment)).rejects.toThrow("application_locked");
  expect(mockCleanup).toHaveBeenCalledTimes(2);
});
test("switching model during inference rejects mismatched space",async()=>{
  model.mockResolvedValueOnce({modelName:"eg2.litertlm",modelSha256:"a".repeat(64),modelSpace})
    .mockResolvedValueOnce({modelName:"new.litertlm",modelSha256:"b".repeat(64),modelSpace:"eg2|vision|768|sha256:"+"b".repeat(64)});
  await expect(preparePhotoMatchChatAttachment83(attachment)).rejects.toThrow("vision_model_changed");
  expect(mockCleanup).toHaveBeenCalledTimes(1);
});
