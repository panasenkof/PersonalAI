import { preparePhotoMatchQuery83 } from "../vision-photo-query";
import { localMemorySessionUnlocked } from "../../local-memory/storage";
import { readyNativeVisionModel83 } from "../vision-native-model";
import { embedVisionImage83 } from "../vision-native-vectors";

const mockCopy = jest.fn();
const mockDelete = jest.fn();
jest.mock("expo-crypto", () => ({ randomUUID: () => "test-photo-id" }));
jest.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///app/cache" } },
  Directory: jest.fn().mockImplementation(() => ({ create: jest.fn(), uri: "file:///app/cache/persai-vision-probe" })),
  File: jest.fn().mockImplementation((source: string | {uri:string}, name?:string) => ({
    uri: name ? "file:///app/cache/persai-vision-probe/"+name : source,
    name: name ?? "red-bicycle.jpg", exists: true, size: 2048,
    copy: mockCopy, delete: mockDelete,
  })),
}));
jest.mock("../../local-memory/storage", () => ({
  localMemorySessionUnlocked: jest.fn(),
}));
jest.mock("../vision-native-model", () => ({ readyNativeVisionModel83: jest.fn() }));
jest.mock("../vision-native-vectors", () => ({ embedVisionImage83: jest.fn() }));

const unlocked = localMemorySessionUnlocked as jest.Mock;
const model = readyNativeVisionModel83 as jest.Mock;
const native = embedVisionImage83 as jest.Mock;
const modelId = "eg2|vision|768|sha256:"+"a".repeat(64);
const asset = {
  uri:"file:///app/cache/gallery-copied.jpg",
  name:"gallery-copied.jpg",mimeType:"image/jpeg",size:2048,
};
beforeEach(() => {
  jest.clearAllMocks();
  unlocked.mockReturnValue(true);
  model.mockResolvedValue({modelName:"eg2.litertlm",modelSha256:"a".repeat(64),modelSpace:modelId});
  native.mockResolvedValue(new Float32Array([1,...Array(767).fill(0)]));
});

test("one selected local JPEG produces an in-memory image vector and destroys staging",async () => {
  const result=await preparePhotoMatchQuery83(asset);
  expect(result).toEqual({model:modelId,values:expect.any(Float32Array)});
  expect(native).toHaveBeenCalledWith({
    modelName:"eg2.litertlm",modelSha256:"a".repeat(64),
    imageName:"test-photo-id.jpg",
  });
  expect(mockCopy).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test("reject external gallery URI, unsupported format and oversize before inference",async () => {
  await expect(preparePhotoMatchQuery83({...asset,uri:"content://gallery/item"}))
    .rejects.toThrow("vision_invalid_query_image");
  await expect(preparePhotoMatchQuery83({...asset,mimeType:"image/heic"}))
    .rejects.toThrow("vision_invalid_query_image");
  await expect(preparePhotoMatchQuery83({...asset,uri:"file:///app/cache/../private.jpg"}))
    .rejects.toThrow("vision_invalid_query_image");
  expect(model).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});
test("no active model never infers or saves the query photo",async () => {
  model.mockResolvedValue(null);
  await expect(preparePhotoMatchQuery83(asset)).rejects.toThrow("vision_model_not_installed");
  expect(mockCopy).not.toHaveBeenCalled();
});
test("native failure cleans up temporary photo, with no text-only fallback",async () => {
  native.mockRejectedValueOnce(new Error("native_error"));
  await expect(preparePhotoMatchQuery83(asset)).rejects.toThrow("native_error");
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
test("lock expiry after embedding invalidates the result and cleans staging",async () => {
  native.mockImplementationOnce(async () => {
    unlocked.mockReturnValue(false);
    return new Float32Array(768);
  });
  await expect(preparePhotoMatchQuery83(asset)).rejects.toThrow("application_locked");
  expect(mockDelete).toHaveBeenCalledTimes(1);
});
