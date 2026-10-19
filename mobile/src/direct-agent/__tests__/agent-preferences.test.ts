import * as SecureStore from "expo-secure-store";
import { loadModelCallLimit, saveModelCallLimit } from "../agent-preferences";

const mockVault = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockVault.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockVault.set(key, value); }),
}));
beforeEach(() => { jest.clearAllMocks(); mockVault.clear(); });

test("the default is four; a saved choice survives reads and is scoped to one device profile", async () => {
  expect(await loadModelCallLimit("guest")).toBe(4);
  await saveModelCallLimit("guest", 7);
  expect(await loadModelCallLimit("guest")).toBe(7);
  expect(await loadModelCallLimit("other")).toBe(4);
  await saveModelCallLimit("other", 2);
  expect(await loadModelCallLimit("guest")).toBe(7);
  expect(await loadModelCallLimit("other")).toBe(2);
});
test.each([0, 21, -1, 1.5, NaN, Infinity])("an invalid choice never replaces the saved limit: %s", async value => {
  await saveModelCallLimit("guest", 6);
  await expect(saveModelCallLimit("guest", value)).rejects.toThrow("от 1 до 20");
  expect(await loadModelCallLimit("guest")).toBe(6);
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
});
test("a failed save leaves the previous value usable", async () => {
  await saveModelCallLimit("guest", 3);
  (SecureStore.setItemAsync as jest.Mock).mockRejectedValueOnce(new Error("storage_failure"));
  await expect(saveModelCallLimit("guest", 8)).rejects.toThrow();
  expect(await loadModelCallLimit("guest")).toBe(3);
});
test.each(["garbled", "21", "0", '"6"'])("corrupt settings fail visibly instead of silently changing the budget: %s", async value => {
  mockVault.set("pia.agent.call-limit.v1.guest", value);
  await expect(loadModelCallLimit("guest")).rejects.toThrow("Сохраните его заново");
});
