/**
 * Portable settings snapshot for the existing SQLCipher backup.
 *
 * SecureStore remains the authoritative on-device owner of connection secrets.
 * This payload exists ONLY inside the independently encrypted backup database;
 * it is never a plaintext sidecar or a second runtime settings store.
 * OS grants, biometrics, online-send consents, model BINARIES and device-bound
 * secrets are NOT portable. Only verified model identities/checksums travel.
 */
import {
  loadDirectConnections, saveDirectConnections, validateBaseUrl, validateModel, validateProvider,
  type DirectConnections, type SearchKeys,
} from "../direct-agent/settings";
import { loadModelCallLimit, saveModelCallLimit } from "../direct-agent/agent-preferences";
import { validateModelCallLimit } from "../direct-agent/limits";
import { getEnrichState, loadIndexTermsPreference, setIndexTermsEnabled } from "../direct-agent/enrich-runner";
import { loadMediaPreferences, saveMediaPreferences, type MediaPreferences } from "../media/preferences";
import { loadPhotoResultCount, savePhotoResultCount, validPhotoResultCount } from "../media/photo-result-preferences";
import { getVoiceEngine, initVoiceEngine, setVoiceEngine } from "../media/voice-engine";
import { captureInstalledModels, parseRecoveryModels, saveRecoveryModels, type RecoveryModelsManifest } from "../media/model-backup-recovery";

export type PortableBackupSettings = {
  version: 1;
  connections: DirectConnections;
  modelCallLimit: number;
  media: MediaPreferences;
  photoResultCount: number;
  voiceEngine: "system" | "whisper";
  indexTermsEnabled: boolean;
  /** Optional extension: archives created before model recovery omit this. */
  localModels?: RecoveryModelsManifest;
};

const textValid = (v: unknown, max = 1024): v is string =>
  typeof v === "string" && v.length <= max;
const keyValid = (v: unknown): v is string =>
  textValid(v) && (v === "" || (!/\s/.test(v) && v.length > 0));
const validSearchKeys = (v: unknown): v is SearchKeys =>
  !!v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).every(k => ["tavily", "yandex", "deepseek"].includes(k) &&
    keyValid((v as Record<string, unknown>)[k]));

/** Reject tampering and malformed remote settings BEFORE any destination write. */
export function parsePortableBackupSettings(raw: string): PortableBackupSettings {
  if (raw.length > 256_000) throw new Error("backup_settings_invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("backup_settings_invalid"); }
  const v = parsed as Partial<PortableBackupSettings> | null;
  if (!v || typeof v !== "object" || v.version !== 1 ||
      !v.connections || !Array.isArray(v.connections.connections) ||
      v.connections.connections.length < 1 || v.connections.connections.length > 20 ||
      typeof v.connections.activeId !== "string" ||
      !v.connections.connections.some(c => c.id === v.connections!.activeId) ||
      new Set(v.connections.connections.map(c => c.id)).size !== v.connections.connections.length ||
      !Number.isSafeInteger(v.modelCallLimit) || !validPhotoResultCount(v.photoResultCount) ||
      !v.media || !textValid(v.media.visionId, 80) || !textValid(v.media.speechId, 80) ||
      !["device", "online"].includes(v.media.fileAsrMode) ||
      !["system", "whisper"].includes(v.voiceEngine as string) ||
      typeof v.indexTermsEnabled !== "boolean") throw new Error("backup_settings_invalid");
  if (v.localModels !== undefined) {
    try { parseRecoveryModels(v.localModels); }
    catch { throw new Error("backup_settings_invalid"); }
  }
  try {
    validateModelCallLimit(v.modelCallLimit!);
    for (const c of v.connections.connections) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || !textValid(c.name, 60) || !c.name.trim() ||
          !textValid(c.apiKey) || !keyValid(c.apiKey) ||
          !textValid(c.webSearchKey) || !keyValid(c.webSearchKey) ||
          !["tavily", "yandex", "deepseek", "builtin", undefined].includes(c.searchProvider) ||
          (c.searchKeys && !validSearchKeys(c.searchKeys)) ||
          !textValid(c.searchFolderId || "", 50) || !textValid(c.transcriptionModel || "", 200) ||
          typeof c.allowWeb !== "boolean") throw new Error("backup_settings_invalid");
      validateProvider(c.provider);
      validateBaseUrl(c.baseUrl, c.provider);
      validateModel(c.model);
      if (c.transcriptionModel) validateModel(c.transcriptionModel);
    }
  } catch { throw new Error("backup_settings_invalid"); }
  return v as PortableBackupSettings;
}

/** Fails closed if a saved connection/key is unreadable; never omit it silently. */
export async function capturePortableBackupSettings(profile: string): Promise<string> {
  const [connections, modelCallLimit, media, photoResultCount] = await Promise.all([
    loadDirectConnections(profile), loadModelCallLimit(profile),
    loadMediaPreferences(profile), loadPhotoResultCount(profile),
  ]);
  await Promise.all([initVoiceEngine(), loadIndexTermsPreference()]);
  const voice = getVoiceEngine();
  const payload: PortableBackupSettings = {
    version: 1, connections, modelCallLimit, media, photoResultCount,
    voiceEngine: voice.preference === "whisper" ? "whisper" : "system",
    indexTermsEnabled: getEnrichState().enabled,
    localModels: await captureInstalledModels(),
  };
  const json = JSON.stringify(payload);
  parsePortableBackupSettings(json);
  return json;
}

/** Apply only after the memory import transaction has committed. */
export async function applyPortableBackupSettings(profile: string, snapshot: PortableBackupSettings): Promise<void> {
  await saveModelCallLimit(profile, snapshot.modelCallLimit);
  await savePhotoResultCount(profile, snapshot.photoResultCount);
  await setVoiceEngine(snapshot.voiceEngine);
  // Offline preference cannot silently authorize uploading private speech.
  await setIndexTermsEnabled(snapshot.indexTermsEnabled);
  await saveMediaPreferences(profile, snapshot.media);
  // Connections staged and published atomically by the existing SecureStore writer.
  await saveDirectConnections(profile, snapshot.connections);
  // This is only a small, persistent post-restore download *request*. Actual
  // model metadata and files remain owned by their existing loaders.
  await saveRecoveryModels(profile, snapshot.localModels);
}
