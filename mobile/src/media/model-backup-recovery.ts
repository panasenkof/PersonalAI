/**
 * Portable inventory / one-tap recovery INTENT for existing on-device models.
 *
 * No model bytes or device filesystem paths enter the SQLCipher backup. The
 * canonical installed-model owners stay Whisper, MiniLM, vision and OCR.
 * The small SecureStore key below remembers only the post-restore request.
 * Network downloads happen ONLY after the user explicitly taps the button.
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { VECTOR_MODEL } from "../local-memory/vectors";
import { getVisionModel, REVISION_HEX, SHA256_HEX, type VisionModelId } from "./vision-model-catalog";
import { isWhisperId, type WhisperId } from "./whisper-core";

export type RecoveryModel =
  | { kind: "whisper"; id: WhisperId; hashes: { model: string; tokenizer?: string; vad?: string } }
  | { kind: "minilm"; id: string; hashes: { model: string; tokenizer: string } }
  | { kind: "vision"; id: VisionModelId; revision: string; sha256: string; bytes: number; active: boolean }
  | { kind: "russian-ocr"; id: "rus"; sha256: string; bytes: number };

export type RecoveryModelsManifest = { version: 1; models: RecoveryModel[] };
const SHA = /^[a-f0-9]{64}$/;
const OCR_SHA = "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225";
const OCR_BYTES = 3_861_738;
const RECOVERY_KEY = (profile: string) => {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(profile)) throw new Error("invalid_local_profile");
  return "pia.backup.local-model-recovery.v1." + profile;
};
const fs = () => (require("react-native-blob-util") as typeof import("react-native-blob-util")).default.fs;
const localPath = (v: unknown) =>
  typeof v === "string" && v.length > 0 && !/^(https?:|content:)/i.test(v)
    ? v.replace(/^file:\/\//, "") : null;
async function exists(path: unknown): Promise<boolean> {
  const file = localPath(path);
  return Boolean(file && await fs().exists(file));
}
async function hash(path: unknown): Promise<string | null> {
  const file = localPath(path);
  if (!file || !(await fs().exists(file))) return null;
  const digest = String(await fs().hash(file, "sha256")).toLowerCase();
  return SHA.test(digest) ? digest : null;
}
const json = (raw: string | null): unknown => raw ? JSON.parse(raw) as unknown : null;

export function parseRecoveryModels(raw: unknown): RecoveryModelsManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("backup_models_invalid");
  const data = raw as { version?: unknown; models?: unknown };
  if (data.version !== 1 || !Array.isArray(data.models) || data.models.length > 12)
    throw new Error("backup_models_invalid");
  const seen = new Set<string>();
  const models: RecoveryModel[] = [];
  for (const item of data.models) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("backup_models_invalid");
    const m = item as Record<string, unknown>;
    let valid = false;
    if (m.kind === "whisper" && isWhisperId(m.id)) {
      const hashes = m.hashes as Record<string, unknown> | null;
      valid = Boolean(hashes && SHA.test(String(hashes.model || "")) &&
        (hashes.tokenizer === undefined || SHA.test(String(hashes.tokenizer))) &&
        (hashes.vad === undefined || SHA.test(String(hashes.vad))));
    } else if (m.kind === "minilm" && m.id === VECTOR_MODEL) {
      const hashes = m.hashes as Record<string, unknown> | null;
      valid = Boolean(hashes && SHA.test(String(hashes.model || "")) &&
        SHA.test(String(hashes.tokenizer || "")));
    } else if (m.kind === "vision" && typeof m.id === "string" && getVisionModel(m.id)) {
      valid = typeof m.revision === "string" && REVISION_HEX.test(m.revision) &&
        typeof m.sha256 === "string" && SHA256_HEX.test(m.sha256) &&
        Number.isSafeInteger(m.bytes) && (m.bytes as number) >= 50_000_000 &&
        (m.bytes as number) <= 1_500_000_000 && typeof m.active === "boolean";
    } else if (m.kind === "russian-ocr") {
      valid = m.id === "rus" && m.sha256 === OCR_SHA && m.bytes === OCR_BYTES;
    }
    const key = String(m.kind) + ":" + String(m.id);
    if (!valid || seen.has(key)) throw new Error("backup_models_invalid");
    seen.add(key);
    models.push(m as RecoveryModel);
  }
  if (models.filter(m => m.kind === "vision" && m.active).length > 1 ||
      models.filter(m => m.kind === "whisper").length > 1 ||
      models.filter(m => m.kind === "minilm").length > 1 ||
      models.filter(m => m.kind === "russian-ocr").length > 1)
    throw new Error("backup_models_invalid");
  return { version: 1, models };
}

/** Reads *existing* SecureStore manifests and physically present local files.
 * Native hashing is streamed, so even large Whisper binaries stay out of JS.
 */
export async function captureInstalledModels(): Promise<RecoveryModelsManifest> {
  if (Platform.OS !== "android") return { version: 1, models: [] };
  const [whisperRaw, miniRaw, visionRaw] = await Promise.all([
    SecureStore.getItemAsync("pia.voice.whisper.v1"),
    SecureStore.getItemAsync("pia.memory.embedder.v1"),
    SecureStore.getItemAsync("persai.vision.models.v1"),
  ]);
  const models: RecoveryModel[] = [];
  const whisper = json(whisperRaw) as { id?: unknown; resolved?: { modelPath?: string; tokenizerPath?: string; vadModel?: { modelPath?: string } } } | null;
  if (whisper && isWhisperId(whisper.id) && whisper.resolved) {
    const weights = await hash(whisper.resolved.modelPath);
    const tokenizer = whisper.resolved.tokenizerPath ? await hash(whisper.resolved.tokenizerPath) : null;
    const vad = whisper.resolved.vadModel?.modelPath ? await hash(whisper.resolved.vadModel.modelPath) : null;
    if (weights && (!whisper.resolved.tokenizerPath || tokenizer) &&
        (!whisper.resolved.vadModel?.modelPath || vad)) {
      models.push({ kind: "whisper", id: whisper.id,
        hashes: { model: weights, ...(tokenizer ? { tokenizer } : {}), ...(vad ? { vad } : {}) } });
    }
  }
  const mini = json(miniRaw) as { model?: unknown; resolved?: { modelPath?: string; tokenizerPath?: string };
    sha256?: { model?: string; tokenizer?: string } } | null;
  if (mini && mini.model === VECTOR_MODEL && mini.resolved) {
    const weights = await hash(mini.resolved.modelPath);
    const tokenizer = await hash(mini.resolved.tokenizerPath);
    if (weights && tokenizer && (!mini.sha256 ||
        (mini.sha256.model === weights && mini.sha256.tokenizer === tokenizer))) {
      models.push({ kind: "minilm", id: VECTOR_MODEL, hashes: { model: weights, tokenizer } });
    }
  }
  const vision = json(visionRaw) as { activeId?: unknown;
    installed?: Array<{ id: string; filename: string; sha256: string; revision: string; bytes: number }> } | null;
  if (vision?.installed && Array.isArray(vision.installed)) {
    for (const v of vision.installed) {
      if (!getVisionModel(v.id) || !SHA.test(v.sha256) || !REVISION_HEX.test(v.revision) ||
          !Number.isSafeInteger(v.bytes) || v.bytes < 50_000_000 || v.bytes > 1_500_000_000 ||
          v.filename !== v.id + "-" + v.sha256.slice(0, 24) + ".litertlm") continue;
      const path = fs().dirs.DocumentDir + "/persai-vision-models/" + v.filename;
      if (await exists(path) && Number((await fs().stat(path)).size) === v.bytes) {
        // Original SHA came from vendor LFS and was checked by the canonical
        // vision downloader; use its pinned revision, never /resolve/main.
        models.push({ kind: "vision", id: v.id as VisionModelId, revision: v.revision,
          sha256: v.sha256, bytes: v.bytes, active: vision.activeId === v.id });
      }
    }
  }
  const ocrPath = fs().dirs.DocumentDir + "/tessdata/rus.traineddata";
  if (await exists(ocrPath) && Number((await fs().stat(ocrPath)).size) === OCR_BYTES &&
      await hash(ocrPath) === OCR_SHA)
    models.push({ kind: "russian-ocr", id: "rus", sha256: OCR_SHA, bytes: OCR_BYTES });
  return parseRecoveryModels({ version: 1, models });
}

/** Saved after the ordinary SQLCipher restore. An old v9 archive with no
 * model inventory clears stale recovery reminders, without touching models.
 */
export async function saveRecoveryModels(profile: string, plan?: RecoveryModelsManifest): Promise<void> {
  const key = RECOVERY_KEY(profile);
  if (!plan || !plan.models.length) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, JSON.stringify(parseRecoveryModels(plan)));
}
export async function getRecoveryModels(profile: string): Promise<RecoveryModelsManifest | null> {
  const raw = await SecureStore.getItemAsync(RECOVERY_KEY(profile));
  if (!raw) return null;
  return parseRecoveryModels(JSON.parse(raw) as unknown);
}

/** Only trusted, preinstalled model IDs and pinned vendor revisions can run.
 * A missing/corrupt model remains visible for retry, never silently "restored".
 */
async function installedMatches(model: RecoveryModel): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  if (model.kind === "russian-ocr") {
    const path = fs().dirs.DocumentDir + "/tessdata/rus.traineddata";
    return await exists(path) && Number((await fs().stat(path)).size) === OCR_BYTES &&
      await hash(path) === model.sha256;
  }
  if (model.kind === "vision") {
    const raw = await SecureStore.getItemAsync("persai.vision.models.v1");
    const value = json(raw) as { installed?: Array<{ id: string; sha256: string; revision: string; bytes: number; filename: string }> } | null;
    const current = value?.installed?.find(v => v.id === model.id &&
      v.sha256 === model.sha256 && v.revision === model.revision && v.bytes === model.bytes);
    if (!current || current.filename !== model.id + "-" + model.sha256.slice(0, 24) + ".litertlm") return false;
    const path = fs().dirs.DocumentDir + "/persai-vision-models/" + current.filename;
    return await exists(path) && Number((await fs().stat(path)).size) === model.bytes;
  }
  if (model.kind === "whisper") {
    const raw = await SecureStore.getItemAsync("pia.voice.whisper.v1");
    const value = json(raw) as { id?: string; resolved?: { modelPath?: string; tokenizerPath?: string; vadModel?: {modelPath?:string} } } | null;
    if (value?.id !== model.id || !value.resolved) return false;
    return await hash(value.resolved.modelPath) === model.hashes.model &&
      (!model.hashes.tokenizer || await hash(value.resolved.tokenizerPath) === model.hashes.tokenizer) &&
      (!model.hashes.vad || await hash(value.resolved.vadModel?.modelPath) === model.hashes.vad);
  }
  const raw = await SecureStore.getItemAsync("pia.memory.embedder.v1");
  const value = json(raw) as { model?: string; resolved?: {modelPath?:string;tokenizerPath?:string} } | null;
  return value?.model === model.id && Boolean(value.resolved &&
    await hash(value.resolved.modelPath) === model.hashes.model &&
    await hash(value.resolved.tokenizerPath) === model.hashes.tokenizer);
}

export async function missingRecoveryModels(profile: string): Promise<RecoveryModel[]> {
  const plan = await getRecoveryModels(profile);
  if (!plan) return [];
  const missing: RecoveryModel[] = [];
  for (const model of plan.models) if (!(await installedMatches(model))) missing.push(model);
  return missing;
}
export const recoveryModelTitle = (model: RecoveryModel): string =>
  model.kind === "whisper" ? "Whisper " + model.id :
  model.kind === "minilm" ? "MiniLM · поиск по смыслу" :
  model.kind === "russian-ocr" ? "Русский OCR" :
  getVisionModel(model.id)?.title || model.id;
export const recoveryModelApproxMb = (model: RecoveryModel): number =>
  model.kind === "whisper" ? (model.id === "tiny" ? 150 : 400) :
  model.kind === "minilm" ? 380 :
  model.kind === "russian-ocr" ? 4 : Math.ceil(model.bytes / 1_000_000);

export type RecoveryProgress = { index: number; total: number; title: string };
/** Sequential download avoids flooding a phone with several 400+ MB native
 * tasks at once. Continue after failures; never download on app start.
 */
export async function downloadMissingRecoveryModels(
  profile: string, onProgress: (progress: RecoveryProgress) => void,
  isCancelled: () => boolean,
): Promise<{ downloaded: number; failed: string[]; cancelled: boolean }> {
  const plan = await getRecoveryModels(profile);
  if (!plan) return { downloaded: 0, failed: [], cancelled: false };
  const pending = await missingRecoveryModels(profile);
  const failed: string[] = [];
  let downloaded = 0;
  for (let i = 0; i < pending.length; i++) {
    if (isCancelled()) break;
    const model = pending[i];
    onProgress({ index: i + 1, total: pending.length, title: recoveryModelTitle(model) });
    try {
      if (model.kind === "whisper") {
        await (require("./whisper") as typeof import("./whisper")).downloadWhisper(model.id);
      } else if (model.kind === "minilm") {
        await (require("./embedder") as typeof import("./embedder")).downloadEmbedder();
      } else if (model.kind === "vision") {
        await (require("./vision-model-manager") as typeof import("./vision-model-manager"))
          .downloadVisionModel(model.id, { revision: model.revision, sha256: model.sha256, bytes: model.bytes });
      } else {
        await (require("./russian-ocr") as typeof import("./russian-ocr")).installRussianOcr();
      }
      if (isCancelled()) break;
      if (await installedMatches(model)) downloaded++;
      else failed.push(recoveryModelTitle(model) + ": не удалось вернуть исходную версию");
    } catch {
      failed.push(recoveryModelTitle(model) + ": не удалось скачать или проверить");
    }
  }
  if (!isCancelled() && !failed.length && (await missingRecoveryModels(profile)).length === 0) {
    // Apply the original image model choice once its pinned bytes exist.
    const active = plan.models.find(m => m.kind === "vision" && m.active);
    if (active?.kind === "vision")
      await (require("./vision-model-manager") as typeof import("./vision-model-manager"))
        .chooseVisionModel(active.id);
    await saveRecoveryModels(profile);
  }
  return { downloaded, failed, cancelled: isCancelled() };
}
export function cancelRecoveryModelDownload(model: RecoveryModel | null) {
  if (!model) return;
  if (model.kind === "whisper") (require("./whisper") as typeof import("./whisper")).cancelWhisperDownload();
  else if (model.kind === "minilm") (require("./embedder") as typeof import("./embedder")).cancelEmbedderDownload();
  else if (model.kind === "vision")
    (require("./vision-model-manager") as typeof import("./vision-model-manager")).cancelVisionModelDownload();
  else (require("./russian-ocr") as typeof import("./russian-ocr")).cancelRussianOcrDownload();
}
