import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { downloadVisionModel, getVisionModelStatus, verifiedActiveVisionModel } from "../vision-model-manager";
import { VISION_MODELS } from "../vision-model-catalog";

const mockFiles = new Map<string, number>();
let mockHash = "b".repeat(64);
let mockSaved: string | null = null;
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => mockSaved),
  setItemAsync: jest.fn(async (_key: string, raw: string) => { mockSaved = raw; }),
}));
jest.mock("react-native-blob-util", () => {
  const fs = {
    dirs: { DocumentDir: "/app-private" },
    exists: jest.fn(async (path: string) => mockFiles.has(path)),
    mkdir: jest.fn(async (path: string) => { mockFiles.set(path, 0); }),
    stat: jest.fn(async (path: string) => {
      if (!mockFiles.has(path)) throw new Error("file_absent");
      return { size: String(mockFiles.get(path)) };
    }),
    hash: jest.fn(async () => mockHash),
    mv: jest.fn(async (from: string, to: string) => {
      mockFiles.set(to, mockFiles.get(from)!); mockFiles.delete(from);
    }),
    unlink: jest.fn(async (path: string) => { mockFiles.delete(path); }),
  };
  return { __esModule: true, default: {
    fs,
    config: jest.fn(({path}: {path: string}) => ({
      fetch: jest.fn(() => {
        mockFiles.set(path, 388000000);
        const promise: any = Promise.resolve({ info: () => ({ status: 200 }) });
        promise.progress = (_opts: unknown, callback: (done: number, total: number) => void) => {
          callback(388000000, 388000000); return promise;
        };
        promise.cancel = jest.fn(async () => {});
        return promise;
      }),
    })),
  } };
});

test("private download verifies immutable vendor SHA and cannot replace trusted bytes with a mismatched file", async () => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  mockFiles.clear(); mockSaved = null; mockHash = "b".repeat(64);
  (global as any).fetch = jest.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes("/tree/") ? [
      { path: VISION_MODELS[0].filename, type: "file", lfs: { oid: "b".repeat(64), size: 388000000 } },
      { path: VISION_MODELS[1].filename, type: "file", lfs: { oid: "b".repeat(64), size: 388000000 } },
    ] : { sha: "a".repeat(40) },
  }));
  await downloadVisionModel("eg2-vision-440");
  const ready = getVisionModelStatus();
  expect(ready.busy).toBe(false);
  expect(ready.activeId).toBe("eg2-vision-440");
  expect(ready.installed).toHaveLength(1);
  expect(ready.installed[0].sha256).toBe("b".repeat(64));
  expect((await verifiedActiveVisionModel())?.space).toBe("eg2|vision|768|sha256:" + "b".repeat(64));
  expect(SecureStore.setItemAsync).toHaveBeenCalled();
  // The vendor's expected digest is unchanged, but the next downloaded bytes
  // are different. The new (larger) model MUST NOT become installed or active.
  mockHash = "f".repeat(64);
  await downloadVisionModel("eg2-vision-440-mt6991");
  expect(getVisionModelStatus().installed).toHaveLength(1);
  expect(getVisionModelStatus().activeId).toBe("eg2-vision-440");
  expect(getVisionModelStatus().error).toMatch(/проверить файл/);
  expect(mockFiles.has("/app-private/persai-vision-models/eg2-vision-440-mt6991-" + "b".repeat(24) + ".litertlm")).toBe(false);
});
