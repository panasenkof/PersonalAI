import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import type { TextEmbedder, TextEmbedderModel } from "react-native-executorch";
import { whisperSupported } from "./whisper-core";
import { VECTOR_MODEL, vectorSpaceKey, type VectorArtifacts } from "../local-memory/vectors";

/** On-device sentence vectors (п. 13): paraphrase-multilingual-MiniLM-L12-v2,
 * downloaded once on request. Texts never leave the phone. */
export type EmbedderStatus =
  | { state: "unsupported" }
  | { state: "absent" }
  | { state: "downloading"; progress: number }
  | { state: "ready" }
  | { state: "error"; message: string };

export const EMBEDDER_APPROX_MB = 380;
const KEY = "pia.memory.embedder.v1";
type Saved = { model: string; resolved: TextEmbedderModel; sha256?: VectorArtifacts };
/** The model artifacts are shared across user profiles, but the *vectors*
 * remain in each profile's separate SQLCipher database. Never log paths or
 * checksums from the private app directory.
 */
let verifiedSpace: string | null = null;
let verifying: Promise<string> | null = null;
const SHA256 = /^[a-f0-9]{64}$/;
// The same requirement as Whisper: react-native-executorch needs Android 13+ / iOS 17+.
let status: EmbedderStatus = { state: whisperSupported(Platform.OS, Platform.Version) ? "absent" : "unsupported" };
let initialized: Promise<void> | null = null;
let engine: TextEmbedder | null = null;
let loading: Promise<TextEmbedder> | null = null;
let aborter: AbortController | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const set = (next: EmbedderStatus) => { status = next; listeners.forEach(l => l()); };

const executorch = () => require("react-native-executorch") as typeof import("react-native-executorch");
const config = (): TextEmbedderModel => {
  const group = executorch().models.textEmbeddings.PARAPHRASE_MULTILINGUAL_MINILM_L12_V2;
  // 8-bit weights on Android (about 380 MB); Core ML on iOS.
  return Platform.OS === "ios" ? group.COREML_FP16 : group.XNNPACK_8DA4W;
};
const pathsOf = (m?: TextEmbedderModel) => m ? [m.modelPath, m.tokenizerPath].filter(p => p && !/^https?:/.test(p)) : [];
/** Native hashing streams 380+ MB directly in native code, never through JS.
 * These are *local* fingerprints, not a vendor-signed authenticity guarantee.
 */
async function artifactHashes(m: TextEmbedderModel): Promise<VectorArtifacts> {
  if (typeof m.modelPath !== "string" || typeof m.tokenizerPath !== "string" ||
      !m.modelPath.trim() || !m.tokenizerPath.trim() ||
      [m.modelPath, m.tokenizerPath].some(path => /^(https?:|content:)/i.test(path))) {
    throw new Error("model_artifacts_not_local");
  }
  const BlobUtil = (require("react-native-blob-util") as typeof import("react-native-blob-util")).default;
  const [weights, tokenizer] = await Promise.all([m.modelPath, m.tokenizerPath].map(
    path => BlobUtil.fs.hash(path.replace(/^file:\/\//, ""), "sha256")));
  const result = { model: String(weights).toLowerCase(), tokenizer: String(tokenizer).toLowerCase() };
  if (!SHA256.test(result.model) || !SHA256.test(result.tokenizer)) throw new Error("invalid_model_sha256");
  return result;
}

/** The current embedding namespace is derived from actual downloaded bytes.
 * Old installations get a one-time local checksum on first use, not a new
 * download. Existing unversioned vectors are safely reindexed under the hash.
 * A changed checksum on later launches FAILS CLOSED instead of mixing vectors.
 */
export function verifiedVectorSpace(): Promise<string> {
  if (verifiedSpace) return Promise.resolve(verifiedSpace);
  if (verifying) return verifying;
  verifying = (async () => {
    const saved = await readSaved();
    if (!saved) throw new Error("model_artifacts_absent");
    const actual = await artifactHashes(saved.resolved);
    if (saved.sha256 && (saved.sha256.model !== actual.model ||
                         saved.sha256.tokenizer !== actual.tokenizer)) {
      throw new Error("model_artifacts_checksum_mismatch");
    }
    if (!saved.sha256) {
      // Legacy model: persist the first observed checksums. These hashes
      // establish future consistency, not vendor authenticity.
      await SecureStore.setItemAsync(KEY, JSON.stringify({ ...saved, sha256: actual } satisfies Saved));
    }
    const key = vectorSpaceKey(Platform.OS === "ios" ? "ios" : "android", actual);
    verifiedSpace = key;
    return key;
  })().catch(error => {
    if (status.state !== "unsupported") set({ state: "error",
      message: "Поиск по смыслу: не удалось проверить целостность локальной модели. Удалите её и скачайте заново." });
    throw error;
  }).finally(() => { verifying = null; });
  return verifying;
}
async function readSaved(): Promise<Saved | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const saved = raw ? JSON.parse(raw) as Saved : null;
    return saved?.model === VECTOR_MODEL && saved.resolved?.modelPath ? saved : null;
  } catch { return null; }
}
function message(e: unknown, stage: "download" | "load" | "embed"): string {
  const text = String((e as Error)?.message || e).slice(0, 160);
  if (stage === "download") return /network|internet|connection|timeout|resolve/i.test(text)
    ? "Поиск по смыслу: модель не скачалась — нет связи с huggingface.co. Проверьте интернет и повторите." : "Поиск по смыслу: модель не скачалась. Код: «" + text + "».";
  if (stage === "load") return "Поиск по смыслу: модель не запустилась. Удалите её и скачайте снова. Код: «" + text + "».";
  return "Поиск по смыслу: не удалось посчитать вектор. Код: «" + text + "».";
}

export function initEmbedder(): Promise<void> {
  if (status.state === "unsupported") return Promise.resolve();
  return initialized ??= readSaved().then(saved => { if (saved && status.state === "absent") set({ state: "ready" }); });
}
export const getEmbedderStatus = () => status;
export function useEmbedderStatus(): EmbedderStatus {
  return useSyncExternalStore(l => { listeners.add(l); void initEmbedder(); return () => { listeners.delete(l); }; }, getEmbedderStatus, getEmbedderStatus);
}
export const embedderReady = async () => { await initEmbedder(); return status.state === "ready"; };

export async function downloadEmbedder(): Promise<void> {
  if (status.state === "unsupported" || status.state === "downloading") return;
  aborter?.abort(); aborter = new AbortController();
  const signal = aborter.signal;
  set({ state: "downloading", progress: 0 });
  try {
    const rne = executorch();
    rne.setTelemetryEnabled(false);
    const resolved = await rne.download(config(), { signal, onProgress: progress => {
      if (!signal.aborted) set({ state: "downloading", progress: Math.round(progress * 100) });
    } });
    const sha256 = await artifactHashes(resolved);
    if (signal.aborted) throw new Error("model_download_cancelled");
    await SecureStore.setItemAsync(KEY, JSON.stringify({ model: VECTOR_MODEL, resolved, sha256 } satisfies Saved));
    engine?.dispose(); engine = null;
    verifiedSpace = vectorSpaceKey(Platform.OS === "ios" ? "ios" : "android", sha256);
    set({ state: "ready" });
  } catch (e) {
    if (signal.aborted) { set((await readSaved()) ? { state: "ready" } : { state: "absent" }); return; }
    set({ state: "error", message: message(e, "download") });
  }
}
export function cancelEmbedderDownload() { aborter?.abort(); }

export async function deleteEmbedder(): Promise<void> {
  aborter?.abort();
  await queue.catch(() => undefined);
  engine?.dispose(); engine = null;
  verifiedSpace = null;
  const saved = await readSaved();
  await SecureStore.deleteItemAsync(KEY);
  if (saved) {
    const BlobUtil = (require("react-native-blob-util") as typeof import("react-native-blob-util")).default;
    for (const path of pathsOf(saved.resolved)) await BlobUtil.fs.unlink(path.replace(/^file:\/\//, "")).catch(() => undefined);
  }
  if (status.state !== "unsupported") set({ state: "absent" });
}

async function load(): Promise<TextEmbedder> {
  if (engine) return engine;
  return loading ??= (async () => {
    const saved = await readSaved();
    if (!saved) throw new Error("Модель поиска по смыслу не скачана: Настройки → Умный поиск по памяти.");
    try {
      await verifiedVectorSpace();
      engine = await executorch().createTextEmbedder(saved.resolved);
      return engine;
    }
    catch (e) { throw new Error(message(e, "load")); }
    finally { loading = null; }
  })();
}

/** Vectors for texts, one at a time: the native runner is busy otherwise. */
export function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const run = queue.catch(() => undefined).then(async () => {
    const model = await load();
    const out: Float32Array[] = [];
    for (const text of texts) {
      try { out.push(await model.embed(text)); }
      catch (e) { throw new Error(message(e, "embed")); }
    }
    return out;
  });
  queue = run;
  return run;
}

/** The question's vector, or nothing if the model is absent or too slow:
 * the search then works by words alone. */
export async function embedQuery(text: string, timeoutMs = 3000): Promise<Float32Array | null> {
  if (!(await embedderReady())) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      embedTexts([text.slice(0, 500)]).then(v => v[0] ?? null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
