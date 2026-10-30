import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import { getVisionModel, parseVendorModelMetadata, SHA256_HEX, REVISION_HEX, type VisionModelId, type TrustedFileMetadata } from "./vision-model-catalog";

/**
 * #83.2 — one shared application-private model cache (NOT a second memory).
 * The app's existing SQLCipher memory and MiniLM search remain authoritative.
 * Neither a ready file nor an active selection claims photo indexing is live:
 * the native Expo engine remains quarantined pending an exact-head APK gate.
 *
 * Model bytes go directly to native disk; never through JS memory or logs.
 * The vendor's HTTPS LFS SHA-256 is verified against the actual local bytes.
 */
export type VisionInstalled = Readonly<{
  id: VisionModelId; filename: string; sha256: string; revision: string; bytes: number;
}>;
type Saved = { revision: 1; activeId: VisionModelId | null; installed: VisionInstalled[] };
export type VisionModelStatus = Readonly<{
  loaded: boolean; busy: boolean; progress: number; downloadingId: VisionModelId | null;
  activeId: VisionModelId | null; installed: readonly VisionInstalled[];
  error: string; notice: string;
}>;
const KEY = "persai.vision.models.v1";
const empty: Saved = { revision: 1, activeId: null, installed: [] };
let snapshot: VisionModelStatus = {
  loaded: false, busy: false, progress: 0, downloadingId: null,
  activeId: null, installed: [], error: "", notice: "",
};
const listeners = new Set<() => void>();
const emit = (next: VisionModelStatus) => { snapshot = next; for (const fn of listeners) fn(); };
let initialized: Promise<void> | null = null;
let transfer: { cancel(): Promise<unknown> | unknown } | null = null;
let generation = 0;

const blob = () => (require("react-native-blob-util") as typeof import("react-native-blob-util")).default;
const modelDir = () => blob().fs.dirs.DocumentDir + "/persai-vision-models";
const modelPath = (item: VisionInstalled) => modelDir() + "/" + item.filename;
const fileName = (id: VisionModelId, sha: string) => id + "-" + sha.slice(0, 24) + ".litertlm";
const isInstalled = (r: unknown): r is VisionInstalled => {
  if (!r || typeof r !== "object") return false;
  const x = r as Partial<VisionInstalled>;
  return typeof x.id === "string" && !!getVisionModel(x.id) &&
    typeof x.sha256 === "string" && SHA256_HEX.test(x.sha256) &&
    typeof x.revision === "string" && REVISION_HEX.test(x.revision) &&
    typeof x.bytes === "number" && Number.isSafeInteger(x.bytes) && x.bytes > 50_000_000 &&
    x.filename === fileName(x.id as VisionModelId, x.sha256);
};
function loadValue(raw: string | null): Saved {
  if (!raw) return { ...empty, installed: [] };
  const input = JSON.parse(raw) as Partial<Saved>;
  if (input.revision !== 1 || !Array.isArray(input.installed)) throw new Error("vision_metadata_invalid");
  const installed = input.installed.filter(isInstalled);
  if (installed.length !== input.installed.length || new Set(installed.map(m => m.id)).size !== installed.length) {
    throw new Error("vision_metadata_invalid");
  }
  const activeId = installed.some(m => m.id === input.activeId) ? input.activeId! : null;
  return { revision: 1, activeId, installed };
}
async function readSaved(): Promise<Saved> {
  return loadValue(await SecureStore.getItemAsync(KEY));
}
async function writeSaved(next: Saved): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
}
async function exists(path: string): Promise<boolean> {
  return blob().fs.exists(path);
}
async function removeFile(path: string) {
  if (await exists(path)) await blob().fs.unlink(path);
}
function sameGeneration(n: number) {
  if (n !== generation) throw new Error("vision_transfer_cancelled");
}
async function vendorManifest(id: VisionModelId): Promise<TrustedFileMetadata> {
  const option = getVisionModel(id);
  if (!option) throw new Error("vision_unknown_model");
  // Only these hard-coded Hugging Face repos are used; never fetch a user URL.
  const root = "https://huggingface.co/api/models/" + option.repo;
  const infoResponse = await fetch(root, { headers: { Accept: "application/json" } });
  if (!infoResponse.ok) throw new Error("vision_vendor_unreachable");
  const info = await infoResponse.json() as { sha?: unknown };
  if (typeof info.sha !== "string" || !REVISION_HEX.test(info.sha)) throw new Error("vision_revision_untrusted");
  const treeResponse = await fetch(root + "/tree/" + info.sha, { headers: { Accept: "application/json" } });
  if (!treeResponse.ok) throw new Error("vision_vendor_manifest_unavailable");
  const tree = await treeResponse.json() as unknown;
  return parseVendorModelMetadata(option, info.sha, tree);
}

export function getVisionModelStatus(): VisionModelStatus { return snapshot; }
export function useVisionModelStatus(): VisionModelStatus {
  return useSyncExternalStore(callback => {
    listeners.add(callback);
    void initVisionModels();
    return () => { listeners.delete(callback); };
  }, getVisionModelStatus, getVisionModelStatus);
}
export function initVisionModels(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    if (Platform.OS !== "android") {
      emit({ ...snapshot, loaded: true, notice: "Загрузка визуальных моделей пока доступна только на Android." });
      return;
    }
    const state = await readSaved();
    // Missing files must never look usable after restore/clear-storage.
    const valid: VisionInstalled[] = [];
    for (const record of state.installed) {
      if (!(await exists(modelPath(record)))) continue;
      const stat = await blob().fs.stat(modelPath(record));
      if (Number(stat.size) === record.bytes) valid.push(record);
    }
    if (valid.length !== state.installed.length) {
      const next = { revision: 1 as const, installed: valid,
        activeId: valid.some(x => x.id === state.activeId) ? state.activeId : null };
      await writeSaved(next);
    }
    emit({ ...snapshot, loaded: true, activeId: valid.some(x => x.id === state.activeId) ? state.activeId : null, installed: valid });
  })().catch(() => {
    emit({ ...snapshot, loaded: true, error: "Не удалось открыть сведения о моделях. Данные памяти не затронуты." });
  });
  return initialized;
}
export async function downloadVisionModel(id: VisionModelId): Promise<void> {
  await initVisionModels();
  if (Platform.OS !== "android" || snapshot.busy) return;
  if (!getVisionModel(id)) throw new Error("vision_unknown_model");
  const token = ++generation;
  emit({ ...snapshot, busy: true, progress: 0, downloadingId: id, error: "", notice: "" });
  let temporary: string | null = null;
  try {
    const metadata = await vendorManifest(id);
    sameGeneration(token);
    const dir = modelDir();
    if (!(await exists(dir))) await blob().fs.mkdir(dir);
    const nextItem: VisionInstalled = { id, filename: fileName(id, metadata.sha256),
      sha256: metadata.sha256, revision: metadata.revision, bytes: metadata.bytes };
    temporary = modelPath(nextItem) + ".partial";
    await removeFile(temporary);
    sameGeneration(token);
    const task = blob().config({ path: temporary, overwrite: true }).fetch("GET", metadata.url);
    transfer = task;
    const response = await task.progress({ interval: 300 }, (received: number) => {
      if (generation === token) {
        emit({ ...snapshot, progress: Math.min(99, Math.max(0, Math.floor(received / metadata.bytes * 100))) });
      }
    });
    transfer = null;
    sameGeneration(token);
    if (response.info().status !== 200) throw new Error("vision_http_status");
    const size = Number((await blob().fs.stat(temporary)).size);
    if (size !== metadata.bytes) throw new Error("vision_wrong_size");
    const sha256 = String(await blob().fs.hash(temporary, "sha256")).toLowerCase();
    if (sha256 !== metadata.sha256) throw new Error("vision_wrong_hash");
    sameGeneration(token);
    const finalPath = modelPath(nextItem);
    if (!(await exists(finalPath))) await blob().fs.mv(temporary, finalPath);
    else await removeFile(temporary);
    temporary = null;
    const previous = await readSaved();
    const old = previous.installed.find(v => v.id === id);
    const installed = [...previous.installed.filter(v => v.id !== id), nextItem];
    const updated: Saved = { revision: 1, installed, activeId: previous.activeId ?? id };
    await writeSaved(updated);
    emit({ ...snapshot, loaded: true, activeId: updated.activeId, installed,
      notice: "Файл проверен по SHA-256 и сохранён на телефоне. Поиск фото подключается отдельно." });
    if (old && old.filename !== nextItem.filename) await removeFile(modelPath(old)).catch(() => undefined);
  } catch {
    if (generation === token) {
      emit({ ...snapshot, error: "Не удалось скачать или проверить файл модели. Проверьте интернет и место на телефоне; затем повторите." });
    }
  } finally {
    transfer = null;
    if (temporary) await removeFile(temporary).catch(() => undefined);
    if (generation === token || snapshot.downloadingId === id) {
      emit({ ...snapshot, busy: false, downloadingId: null, progress: 0 });
    }
  }
}
export function cancelVisionModelDownload() {
  if (!snapshot.busy) return;
  generation++;
  void transfer?.cancel();
  // Cleanup is performed by the in-flight operation's finally block.
  emit({ ...snapshot, notice: "Загрузка отменяется…", error: "" });
}
export async function chooseVisionModel(id: VisionModelId) {
  await initVisionModels();
  if (snapshot.busy || !snapshot.installed.some(v => v.id === id)) return;
  const saved = await readSaved();
  const next = { ...saved, activeId: id };
  await writeSaved(next);
  emit({ ...snapshot, activeId: id, notice: "Модель выбрана. Поиск по фото включится после подключения движка.", error: "" });
}
export async function deleteVisionModel(id: VisionModelId) {
  await initVisionModels();
  if (snapshot.busy) return;
  const saved = await readSaved();
  const record = saved.installed.find(m => m.id === id);
  if (!record) return;
  const installed = saved.installed.filter(m => m.id !== id);
  const next: Saved = { revision: 1, installed, activeId: saved.activeId === id ? null : saved.activeId };
  await writeSaved(next);
  emit({ ...snapshot, installed, activeId: next.activeId, notice: "Файл модели удалён из списка.", error: "" });
  await removeFile(modelPath(record));
}

/** Mandatory expensive check immediately before a native inference opens a file.
 * No saved SHA is trusted without reading the *actual* local model bytes.
 * The returned embedding namespace must be stored with future SQLCipher rows.
 */
export async function verifiedActiveVisionModel(): Promise<{ path: string; space: string } | null> {
  await initVisionModels();
  const state = await readSaved();
  const item = state.installed.find(m => m.id === state.activeId);
  if (!item) return null;
  const path = modelPath(item);
  if (!(await exists(path)) || Number((await blob().fs.stat(path)).size) !== item.bytes ||
      String(await blob().fs.hash(path, "sha256")).toLowerCase() !== item.sha256) {
    throw new Error("vision_model_checksum_mismatch");
  }
  return { path, space: "eg2|vision|768|sha256:" + item.sha256 };
}
