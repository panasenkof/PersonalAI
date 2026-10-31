import { embedVisionImage83, embedVisionText83 } from "../vision-native-vectors";
import { localMemorySessionUnlocked } from "../../local-memory/storage";
jest.mock("react-native",()=>({Platform:{OS:"android"}}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("expo-modules-core",()=>({
  ...jest.requireActual("expo-modules-core"),requireOptionalNativeModule:jest.fn(),
}));
const {requireOptionalNativeModule}=require("expo-modules-core") as {
  requireOptionalNativeModule:jest.Mock;
};
const unlocked=localMemorySessionUnlocked as jest.Mock;
const model={modelName:"eg2-model-aaa.litertlm",modelSha256:"a".repeat(64)};
const unit=()=>[1,...Array(767).fill(0)];
beforeEach(()=>{jest.clearAllMocks();unlocked.mockReturnValue(true);});

test("existing ordinary APK remains unable to call experimental native engine",async()=>{
  const config=require("../../../modules/persai-vision/expo-module.config.json");
  expect(config.platforms).not.toContain("android");
  requireOptionalNativeModule.mockReturnValue(null);
  await expect(embedVisionText83(model,"красный велосипед")).rejects.toThrow("vision_native_unavailable");
});
test("model checksum, sandbox names and AppLock deny requests before native access",async()=>{
  unlocked.mockReturnValue(false);
  await expect(embedVisionText83(model,"машина")).rejects.toThrow("application_locked");
  unlocked.mockReturnValue(true);
  await expect(embedVisionText83({...model,modelName:"../other.litertlm"},"машина"))
    .rejects.toThrow("invalid_vision_model");
  await expect(embedVisionText83({...model,modelSha256:"fake"},"машина"))
    .rejects.toThrow("invalid_vision_model");
  await expect(embedVisionText83(model," ")).rejects.toThrow("invalid_vision_query");
  await expect(embedVisionImage83({...model,imageName:"../private.png"}))
    .rejects.toThrow("invalid_vision_image");
  expect(requireOptionalNativeModule).not.toHaveBeenCalled();
});
test("returns 768D finite float32 for text and photo without mixing model dimensions",async()=>{
  const embedTextVector=jest.fn(async()=>unit());
  const embedImageVector=jest.fn(async()=>unit());
  requireOptionalNativeModule.mockReturnValue({
    isSupported:()=>true,embedTextVector,embedImageVector,
  });
  const text=await embedVisionText83(model,"велосипед");
  const photo=await embedVisionImage83({...model,imageName:"preview.webp"});
  expect(text).toBeInstanceOf(Float32Array);
  expect(photo).toBeInstanceOf(Float32Array);
  expect(text.length).toBe(768);
  expect(photo.length).toBe(768);
  expect(embedTextVector).toHaveBeenCalledWith(model.modelName,model.modelSha256,"велосипед");
  expect(embedImageVector).toHaveBeenCalledWith(model.modelName,model.modelSha256,"preview.webp");
});
test("rejects NaN, malformed, truncated, non-normalized or fabricated native payload",async()=>{
  const bad=[new Array(384).fill(1),new Array(768).fill(0),
    [NaN,...new Array(767).fill(0)],"not-a-vector",null,
    [1000000,...new Array(767).fill(0)]];
  for(const value of bad){
    requireOptionalNativeModule.mockReturnValue({isSupported:()=>true,
      embedTextVector:async()=>value});
    await expect(embedVisionText83(model,"text")).rejects.toThrow(/invalid_native_vision_(norm|vector)/);
  }
});
