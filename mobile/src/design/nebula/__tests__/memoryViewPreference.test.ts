import * as SecureStore from "expo-secure-store";
import { loadMemoryLibraryView, saveMemoryLibraryView } from "../memoryViewPreference";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(),
}));
const read = SecureStore.getItemAsync as jest.Mock;
const write = SecureStore.setItemAsync as jest.Mock;
beforeEach(() => { jest.resetAllMocks(); read.mockResolvedValue(null); write.mockResolvedValue(undefined); });

test("a new or corrupted profile preference falls back to the adaptive default", async () => {
  expect(await loadMemoryLibraryView("profile-a")).toBeNull();
  read.mockResolvedValueOnce("invalid");
  expect(await loadMemoryLibraryView("profile-a")).toBeNull();
});
test("layout choices are stored only for the requested profile", async () => {
  await saveMemoryLibraryView("profile-a", "list");
  await saveMemoryLibraryView("profile-b", "grid");
  expect(write).toHaveBeenNthCalledWith(1, "persai.memory-library-view.v1.profile-a", "list");
  expect(write).toHaveBeenNthCalledWith(2, "persai.memory-library-view.v1.profile-b", "grid");
  read.mockResolvedValueOnce("list").mockResolvedValueOnce("grid");
  expect(await loadMemoryLibraryView("profile-a")).toBe("list");
  expect(await loadMemoryLibraryView("profile-b")).toBe("grid");
});
test("blank profiles and invalid values cannot write a preference", async () => {
  await expect(saveMemoryLibraryView("", "grid")).rejects.toThrow("memory_view_preference_invalid");
  await expect(saveMemoryLibraryView("profile-a", "invalid" as any)).rejects.toThrow("memory_view_preference_invalid");
  expect(write).not.toHaveBeenCalled();
  expect(await loadMemoryLibraryView("")).toBeNull();
});
