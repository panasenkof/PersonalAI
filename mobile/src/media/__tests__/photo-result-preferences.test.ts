import { loadPhotoResultCount, savePhotoResultCount, DEFAULT_PHOTO_RESULT_COUNT } from "../photo-result-preferences";
import * as SecureStore from "expo-secure-store";
jest.mock("expo-secure-store",()=>({getItemAsync:jest.fn(),setItemAsync:jest.fn()}));
const get=SecureStore.getItemAsync as jest.Mock;
const set=SecureStore.setItemAsync as jest.Mock;
beforeEach(()=>{jest.resetAllMocks();get.mockResolvedValue(null);set.mockResolvedValue(undefined);});
test("defaults to six matches for a new profile",async()=>{
  expect(await loadPhotoResultCount("guest")).toBe(DEFAULT_PHOTO_RESULT_COUNT);
});
test("stores an allowed count only under the current profile",async()=>{
  await savePhotoResultCount("guest",20);
  expect(set).toHaveBeenCalledWith("persai.photo-result-count.v1.guest","20");
  get.mockResolvedValueOnce("20");
  expect(await loadPhotoResultCount("guest")).toBe(20);
  get.mockResolvedValueOnce("999");
  expect(await loadPhotoResultCount("guest")).toBe(6);
});
test("rejects invalid counts rather than silently changing the ranking",async()=>{
  await expect(savePhotoResultCount("guest",999 as any)).rejects.toThrow("photo_result_count_invalid");
  expect(set).not.toHaveBeenCalled();
});
