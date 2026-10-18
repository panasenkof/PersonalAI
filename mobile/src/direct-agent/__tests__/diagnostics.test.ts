import { diagnosticTrace, getDiagnosticSettings, setDiagnosticSettings, listDiagnosticFiles,
  deleteDiagnosticFiles, shareDiagnosticFile, redactDiagnostic, resetDiagnosticsForTests } from "../diagnostics";
import * as Sharing from "expo-sharing";

const mockFileContents = new Map<string, string>();
const mockSettings = new Map<string, string>();
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA256" },
  digestStringAsync: jest.fn(async (_algorithm: string, profile: string) => profile === "alpha" ? "a".repeat(64) : "b".repeat(64)),
}));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockSettings.get(key) || null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); }),
}));
jest.mock("expo-sharing", () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));
jest.mock("expo-file-system", () => {
  class MockDirectory {
    path: string;
    constructor(...pieces: any[]) { this.path = pieces.map(p => typeof p === "string" ? p : p.path).join("/"); }
    get exists() { return [...mockFileContents.keys()].some(key => key.startsWith(this.path + "/")); }
    create() {}
    list() {
      return [...mockFileContents.keys()].filter(key => key.startsWith(this.path + "/") &&
        !key.slice(this.path.length + 1).includes("/")).map(key => new MockFile(this, key.split("/").pop()!));
    }
  }
  class MockFile {
    uri: string;
    name: string;
    constructor(dir: MockDirectory, name: string) { this.name = name; this.uri = dir.path + "/" + name; }
    get exists() { return mockFileContents.has(this.uri); }
    get size() { return (mockFileContents.get(this.uri) || "").length; }
    create() { mockFileContents.set(this.uri, ""); }
    write(text: string, options?: { append?: boolean }) {
      mockFileContents.set(this.uri, (options?.append ? mockFileContents.get(this.uri) || "" : "") + text);
      return Promise.resolve();
    }
    delete() { mockFileContents.delete(this.uri); }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { document: "/private" } };
});

beforeEach(() => {
  mockFileContents.clear(); mockSettings.clear(); resetDiagnosticsForTests(); jest.clearAllMocks();
});
const path = (name: string, profile = "alpha") => "/private/diagnostics/" + (profile === "alpha" ? "a" : "b").repeat(24) + "/" + name;

test("diagnostics are off by default and do not persist the prompt or other events", async () => {
  expect(await getDiagnosticSettings("alpha")).toEqual({ enabled: false, includeContent: false });
  const log = diagnosticTrace("alpha", "conversation1", "turn1");
  log("turn.start", { promptChars: 11 }, { prompt: "my private text" });
  expect(await listDiagnosticFiles("alpha")).toEqual([]);
  expect(mockFileContents.size).toBe(0);
});

test("enabled metadata includes ordered JSONL events but not prompts or tokens", async () => {
  await setDiagnosticSettings("alpha", { enabled: true, includeContent: false });
  const log = diagnosticTrace("alpha", "chat", "t1");
  log("turn.start", { historyTurns: 3, apiKey: "super-private", step: "search" }, { prompt: "private story" });
  log("llm.response", { requests: 2, name: "search_local_notes" }, { result: "private notes" });
  const files = await listDiagnosticFiles("alpha");
  expect(files).toHaveLength(1);
  const lines = mockFileContents.get(path(files[0].name))!.trim().split("\n").map(s => JSON.parse(s));
  expect(lines.map(line => line.event)).toEqual(["turn.start", "llm.response"]);
  expect(lines[0].data).toMatchObject({ historyTurns: 3, apiKey: "[REDACTED]" });
  expect(lines[0].content).toBeUndefined();
  expect(JSON.stringify(lines)).not.toMatch(/private story|private notes|super-private/);
});

test("content requires a separate opt-in and redacts common API credentials", async () => {
  await setDiagnosticSettings("alpha", { enabled: true, includeContent: true });
  const log = diagnosticTrace("alpha", "chat", "t1");
  log("llm.tool_requested", { count: 1 }, { arguments: "Bearer sk-abcdef1234567890 password=hello" });
  const files = await listDiagnosticFiles("alpha");
  const line = JSON.parse(mockFileContents.get(path(files[0].name))!.trim());
  expect(line.content.arguments).not.toContain("sk-abcdef1234567890");
  expect(line.content.arguments).not.toContain("hello");
  expect(line.content.arguments).toContain("[REDACTED]");
  expect(redactDiagnostic("token=abc123")).not.toContain("abc123");
});

test("logs are separated by profile and can be shared and deleted explicitly", async () => {
  await setDiagnosticSettings("alpha", { enabled: true, includeContent: false });
  diagnosticTrace("alpha", "chat", "t1")("turn.start");
  const files = await listDiagnosticFiles("alpha");
  expect(await listDiagnosticFiles("beta")).toEqual([]);
  await shareDiagnosticFile("alpha", files[0].name);
  expect(Sharing.shareAsync).toHaveBeenCalledWith(path(files[0].name), expect.objectContaining({ mimeType: "application/x-ndjson" }));
  await deleteDiagnosticFiles("alpha");
  expect(await listDiagnosticFiles("alpha")).toEqual([]);
  await expect(shareDiagnosticFile("alpha", "../bad")).rejects.toThrow("Некорректное");
});

test("stale files are pruned without deleting the current test session", async () => {
  mockFileContents.set(path("diag-2020-01-01-001.jsonl"), "old");
  await setDiagnosticSettings("alpha", { enabled: true, includeContent: false });
  diagnosticTrace("alpha", "chat", "t1")("turn.start");
  expect(await listDiagnosticFiles("alpha")).toHaveLength(1);
  expect(mockFileContents.has(path("diag-2020-01-01-001.jsonl"))).toBe(false);
});

test("disabling stops recording and retains earlier files", async () => {
  await setDiagnosticSettings("alpha", { enabled: true, includeContent: true });
  const log = diagnosticTrace("alpha", "chat", "t1");
  log("event1");
  expect(await listDiagnosticFiles("alpha")).toHaveLength(1);
  await setDiagnosticSettings("alpha", { enabled: false, includeContent: true });
  log("event2");
  const files = await listDiagnosticFiles("alpha");
  expect(mockFileContents.get(path(files[0].name))!.trim().split("\n")).toHaveLength(1);
  expect(await getDiagnosticSettings("alpha")).toMatchObject({ enabled: false, includeContent: false });
});
