/** Only synthetic bytes and paths: no real user profiles/models in CI. */
jest.mock("../whisper-core", () => ({ whisperSupported: () => true }));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));
jest.mock("react-native-blob-util", () => ({
  __esModule: true, default: { fs: { hash: jest.fn(), unlink: jest.fn() } },
}));
jest.mock("react-native-executorch", () => ({
  setTelemetryEnabled: jest.fn(),
  models: { textEmbeddings: { PARAPHRASE_MULTILINGUAL_MINILM_L12_V2: {
    COREML_FP16: { modelPath: "https://example.invalid/coreml", tokenizerPath: "https://example.invalid/tok" },
    XNNPACK_8DA4W: { modelPath: "https://example.invalid/android", tokenizerPath: "https://example.invalid/tok" },
  } } },
  download: jest.fn(), createTextEmbedder: jest.fn(),
}));

const modelName = "paraphrase-multilingual-minilm-l12-v2";
const file = { modelPath: "file:///private/models/weights.pte", tokenizerPath: "file:///private/models/tokenizer.json" };
const sha = { model: "a".repeat(64), tokenizer: "b".repeat(64) };
const saved = (hashes?: { model: string; tokenizer: string }) =>
  JSON.stringify({ model: modelName, resolved: file, ...(hashes ? { sha256: hashes } : {}) });

function fixtures(raw: string | null) {
  jest.resetModules();
  const store = require("expo-secure-store") as {
    getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock;
  };
  store.getItemAsync.mockResolvedValue(raw);
  store.setItemAsync.mockResolvedValue(undefined);
  const blob = require("react-native-blob-util").default;
  blob.fs.hash.mockImplementation(async (path: string, alg: string) => {
    expect(alg).toBe("sha256");
    return path.endsWith("weights.pte") ? sha.model : sha.tokenizer;
  });
  blob.fs.unlink.mockResolvedValue(undefined);
  const native = require("react-native-executorch") as {
    createTextEmbedder: jest.Mock; download: jest.Mock;
  };
  native.createTextEmbedder.mockResolvedValue({
    embed: jest.fn().mockResolvedValue(new Float32Array(384)), dispose: jest.fn(),
  });
  native.download.mockResolvedValue(file);
  const embedder = require("../embedder") as typeof import("../embedder");
  return { store, blob, native, embedder };
}

test("legacy downloaded model is fingerprinted locally once and reused without repeat 380MB hash", async () => {
  const { embedder, store, blob, native } = fixtures(saved());
  await embedder.initEmbedder();
  expect(embedder.getEmbedderStatus().state).toBe("ready");
  const space = await embedder.verifiedVectorSpace();
  expect(space).toContain("|sha256:" + sha.model + ":" + sha.tokenizer);
  expect(blob.fs.hash).toHaveBeenCalledTimes(2);
  expect(store.setItemAsync).toHaveBeenCalledWith(expect.any(String),
    expect.stringContaining('"sha256"'));
  expect(await embedder.verifiedVectorSpace()).toBe(space);
  expect(blob.fs.hash).toHaveBeenCalledTimes(2);
  await embedder.embedTexts(["example"]);
  expect(native.createTextEmbedder).toHaveBeenCalledTimes(1);
});

test("download creates native checksum manifest before enabling the model", async () => {
  const { embedder, store, blob } = fixtures(null);
  await embedder.downloadEmbedder();
  expect(embedder.getEmbedderStatus()).toEqual({ state: "ready" });
  expect(blob.fs.hash).toHaveBeenCalledTimes(2);
  const record = JSON.parse(store.setItemAsync.mock.calls[0][1]);
  expect(record.sha256).toEqual(sha);
  expect(record.resolved).toEqual(file);
});

test("tampered native model cannot be loaded or used in similarity search", async () => {
  const { embedder, native, store } = fixtures(saved({
    model: "c".repeat(64), tokenizer: sha.tokenizer,
  }));
  await embedder.initEmbedder();
  await expect(embedder.embedTexts(["не передавать в модель"])).rejects.toThrow("model_artifacts_checksum_mismatch");
  expect(native.createTextEmbedder).not.toHaveBeenCalled();
  expect(embedder.getEmbedderStatus().state).toBe("error");
  expect(store.setItemAsync).not.toHaveBeenCalled();
});

test("a fake remote URI never bypasses local native hash checks", async () => {
  const { embedder, blob, native } = fixtures(JSON.stringify({
    model: modelName,
    resolved: { modelPath: "https://evil.invalid/model.pte", tokenizerPath: file.tokenizerPath },
  }));
  await expect(embedder.verifiedVectorSpace()).rejects.toThrow("model_artifacts_not_local");
  expect(blob.fs.hash).not.toHaveBeenCalled();
  expect(native.createTextEmbedder).not.toHaveBeenCalled();
});
