import { indexPhotoPage83 } from "../vision-index-pages";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../../local-memory/storage";
import { fingerprintExtractionSource } from "../../local-memory/extractions";
import { indexSavedPhoto83 } from "../vision-index-attachment";
import { readyNativeVisionModel83 } from "../vision-native-model";

jest.mock("../../local-memory/storage", () => ({
  localMemorySessionUnlocked: jest.fn(), withLocalMemoryDatabase: jest.fn(),
}));
jest.mock("../../local-memory/extractions", () => ({
  fingerprintExtractionSource: jest.fn(),
}));
jest.mock("../vision-index-attachment", () => ({ indexSavedPhoto83: jest.fn() }));
jest.mock("../vision-native-model", () => ({ readyNativeVisionModel83: jest.fn() }));

const unlocked = localMemorySessionUnlocked as jest.Mock;
const database = withLocalMemoryDatabase as jest.Mock;
const fingerprint = fingerprintExtractionSource as jest.Mock;
const indexOne = indexSavedPhoto83 as jest.Mock;
const model = readyNativeVisionModel83 as jest.Mock;
const modelSpace = "eg2|vision|768|sha256:" + "a".repeat(64);
const altSpace = "eg2|vision|768|sha256:" + "b".repeat(64);
const info = (space = modelSpace) => ({
  modelName: "vision-model.litertlm", modelSha256: space.slice(-64), modelSpace: space,
});
type Item = { attachmentId: string; indexedVersion: string | null };
let rows: Item[] = [];
const db = { getAllAsync: jest.fn() };
beforeEach(() => {
  jest.clearAllMocks();
  rows = [];
  unlocked.mockReturnValue(true);
  model.mockResolvedValue(info());
  database.mockImplementation(async (_profile: string, work: (connection: { getAllAsync: jest.Mock }) => Promise<unknown>) => work(db));
  db.getAllAsync.mockImplementation(async (sql: string, params: unknown[]) => {
    expect(sql).toContain("memory_attachment_vectors");
    expect(sql).toContain("e.sensitivity IN ('standard','inherit')");
    expect(sql).toContain("c.sensitivity='standard'");
    expect(sql).toContain("a.mime IN ('image/jpeg','image/png','image/webp')");
    expect(sql).toContain("ORDER BY a.id LIMIT ?");
    const cursor = String(params[1]);
    const limit = Number(params.at(-1));
    return rows.filter(r => r.attachmentId > cursor).slice(0, limit);
  });
  fingerprint.mockImplementation(async (_db: unknown, id: string) => id + "-current");
  indexOne.mockImplementation(async (_profile: string, id: string) => {
    const row = rows.find(r => r.attachmentId === id)!;
    row.indexedVersion = id + "-current";
    return { indexed: true, attachmentId: id, modelSpace };
  });
});

test("scan uses SQLCipher attachment+vector tables, processes at most a page and yields stable cursor", async () => {
  rows = [
    {attachmentId:"att-01",indexedVersion:"att-01-current"},
    {attachmentId:"att-02",indexedVersion:null},
    {attachmentId:"att-03",indexedVersion:null},
  ];
  const first = await indexPhotoPage83("guest", {limit:2});
  expect(first).toEqual({
    modelSpace,nextCursor:"att-02",hasMore:true,examined:2,
    alreadyCurrent:1,indexed:1,sourceChanged:0,failed:0,halted:"none",
  });
  expect(indexOne).toHaveBeenCalledTimes(1);
  expect(indexOne).toHaveBeenCalledWith("guest","att-02",undefined);
  const second = await indexPhotoPage83("guest",{afterId:first.nextCursor,limit:2});
  expect(second.indexed).toBe(1);
  expect(second.nextCursor).toBe("att-03");
  expect(second.hasMore).toBe(false);
  expect(db.getAllAsync).toHaveBeenCalledTimes(2);
});
test("restart at empty cursor avoids costly inference for complete unchanged images", async () => {
  rows = [{attachmentId:"att-01",indexedVersion:null}];
  expect((await indexPhotoPage83("guest")).indexed).toBe(1);
  indexOne.mockClear();
  const restarted=await indexPhotoPage83("guest");
  expect(restarted.alreadyCurrent).toBe(1);
  expect(restarted.indexed).toBe(0);
  expect(indexOne).not.toHaveBeenCalled();
});
test("edited original is reindexed while stale vector space stays isolated", async () => {
  rows = [{attachmentId:"att-01",indexedVersion:"old-source-manifest"}];
  const page=await indexPhotoPage83("guest");
  expect(page.indexed).toBe(1);
  expect(indexOne).toHaveBeenCalledTimes(1);
  expect(db.getAllAsync.mock.calls[0][1][0]).toBe(modelSpace);
});
test("no model, locked session, invalid page and cancellation avoid all SQLCipher scans", async () => {
  unlocked.mockReturnValue(false);
  await expect(indexPhotoPage83("guest")).rejects.toThrow("application_locked");
  unlocked.mockReturnValue(true);
  await expect(indexPhotoPage83("guest",{limit:999})).rejects.toThrow("vision_invalid_index_page");
  await expect(indexPhotoPage83("guest",{afterId:"../secret"})).rejects.toThrow("vision_invalid_index_page");
  const controller = new AbortController(); controller.abort();
  await expect(indexPhotoPage83("guest",{signal:controller.signal}))
    .rejects.toThrow("vision_index_cancelled");
  model.mockResolvedValue(null);
  expect((await indexPhotoPage83("guest")).halted).toBe("model_not_installed");
  expect(db.getAllAsync).not.toHaveBeenCalled();
});
test("failed native inference stops without a busy retry loop or advancing cursor", async () => {
  rows=[{attachmentId:"att-01",indexedVersion:null},{attachmentId:"att-02",indexedVersion:null}];
  indexOne.mockRejectedValueOnce(new Error("native_crashed"));
  const page=await indexPhotoPage83("guest",{limit:2});
  expect(page.halted).toBe("failed");
  expect(page.failed).toBe(1);
  expect(page.nextCursor).toBe("");
  expect(indexOne).toHaveBeenCalledTimes(1);
});
test("active model changed mid-page prevents a mixed embedding namespace",async()=>{
  rows=[{attachmentId:"att-01",indexedVersion:null}];
  model.mockResolvedValueOnce(info()).mockResolvedValueOnce(info(altSpace));
  const page=await indexPhotoPage83("guest");
  expect(page.halted).toBe("model_changed");
  expect(page.indexed).toBe(0);
  expect(indexOne).not.toHaveBeenCalled();
});
test("lock expiry on page aborts remaining work",async()=>{
  rows=[{attachmentId:"att-01",indexedVersion:null},{attachmentId:"att-02",indexedVersion:null}];
  indexOne.mockImplementationOnce(async()=>{unlocked.mockReturnValue(false);return {
    indexed:true, attachmentId:"att-01",modelSpace,
  };});
  await expect(indexPhotoPage83("guest",{limit:2})).rejects.toThrow("application_locked");
  expect(indexOne).toHaveBeenCalledTimes(1);
});
test("overlapping page calls are rejected before a second inference",async()=>{
  rows=[{attachmentId:"att-01",indexedVersion:null}];
  let resume!:()=>void;
  indexOne.mockImplementationOnce(()=>new Promise(resolve=>{
    resume=()=>resolve({indexed:true,attachmentId:"att-01",modelSpace});
  }));
  const first=indexPhotoPage83("guest");
  // Wait for asynchronous model selection + SQLCipher snapshot to reach call.
  await new Promise(resolve=>setImmediate(resolve));
  await expect(indexPhotoPage83("guest")).rejects.toThrow("vision_index_page_busy");
  resume();
  expect((await first).indexed).toBe(1);
});

test("active model switch during already-current fingerprint does not advance cursor",async()=>{
  rows=[{attachmentId:"att-01",indexedVersion:"att-01-current"}];
  model.mockResolvedValueOnce(info()).mockResolvedValueOnce(info(altSpace));
  const page=await indexPhotoPage83("guest",{limit:1});
  expect(page.halted).toBe("model_changed");
  expect(page.nextCursor).toBe("");
  expect(page.alreadyCurrent).toBe(0);
  expect(indexOne).not.toHaveBeenCalled();
});
