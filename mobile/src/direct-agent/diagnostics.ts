/**
 * TEMPORARY, opt-in diagnostics for on-device chat debugging.
 * Never log HTTP bodies/headers or credentials automatically.
 * Files stay in the app's private document directory until the user shares them.
 * Remove this module and Diagnostics screen after device QA.
 */
import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";

export type DiagnosticSettings = { enabled: boolean; includeContent: boolean };
export type DiagnosticFile = { name: string; size: number };
export type DiagnosticTrace = (event: string, fields?: Record<string, unknown>, content?: Record<string, string>) => void;

export const DEFAULT_DIAGNOSTICS: DiagnosticSettings = { enabled: false, includeContent: false };
const MAX_FILE_SIZE = 2_000_000;
const MAX_FILES = 12;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const NAME = /^diag-(\d{4}-\d{2}-\d{2})-(\d{3})\.jsonl$/;
const cache = new Map<string, DiagnosticSettings>();
const loading = new Map<string, Promise<DiagnosticSettings>>();
let writes: Promise<void> = Promise.resolve();

async function profileHash(profile: string): Promise<string> {
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, profile)).slice(0, 24);
}
async function directory(profile: string): Promise<Directory> {
  return new Directory(Paths.document, "diagnostics", await profileHash(profile));
}
const settingKey = async (profile: string) => "persai.diag." + await profileHash(profile);

export async function getDiagnosticSettings(profile: string): Promise<DiagnosticSettings> {
  if (cache.has(profile)) return cache.get(profile)!;
  if (loading.has(profile)) return loading.get(profile)!;
  const work = (async () => {
    try {
      const raw = await SecureStore.getItemAsync(await settingKey(profile));
      const saved = raw ? JSON.parse(raw) as Partial<DiagnosticSettings> : {};
      const value = { enabled: saved.enabled === true, includeContent: saved.includeContent === true };
      cache.set(profile, value);
      return value;
    } catch {
      // Fail closed if secure settings storage is inaccessible.
      return DEFAULT_DIAGNOSTICS;
    } finally {
      loading.delete(profile);
    }
  })();
  loading.set(profile, work);
  return work;
}

export async function setDiagnosticSettings(profile: string, value: DiagnosticSettings): Promise<void> {
  const checked = { enabled: value.enabled === true, includeContent: value.enabled === true && value.includeContent === true };
  await SecureStore.setItemAsync(await settingKey(profile), JSON.stringify(checked));
  cache.set(profile, checked);
}

/** Scrubs common tokens; optional message content can still contain private facts.
 * Only an explicit, separate user setting enables message-content collection. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|authorization|password|passwd|token|secret|credential)\s*[:=]\s*["']?)[^"',\s}\]]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-|sk_projd_|sk-ant-)[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/([?&](?:api_key|key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]");
}
function clean(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactDiagnostic(value.slice(0, 6000));
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return depth > 2 ? "[array]" : value.slice(0, 20).map(v => clean(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 2) return "[object]";
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, item]) =>
      [key.slice(0, 60), /api.?key|authorization|password|token|secret|credential/i.test(key) ? "[REDACTED]" : clean(item, depth + 1)]));
  }
  return undefined;
}
function files(dir: Directory): File[] {
  if (!dir.exists) return [];
  return dir.list().filter((item): item is File => item instanceof File && NAME.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function trim(dir: Directory, now: Date) {
  const all = files(dir);
  for (const file of all) {
    const day = NAME.exec(file.name)![1];
    if (now.getTime() - new Date(day + "T00:00:00Z").getTime() > RETENTION_MS) file.delete();
  }
  const valid = files(dir);
  for (const file of valid.slice(0, Math.max(0, valid.length - MAX_FILES + 1))) file.delete();
}
async function append(profile: string, entry: Record<string, unknown>): Promise<void> {
  const dir = await directory(profile);
  dir.create({ idempotent: true, intermediates: true });
  const now = new Date();
  trim(dir, now);
  const day = now.toISOString().slice(0, 10);
  const todays = files(dir).filter(f => f.name.startsWith("diag-" + day + "-"));
  const last = todays[todays.length - 1];
  const index = last && (last.size || 0) < MAX_FILE_SIZE ? Number(NAME.exec(last.name)![2]) :
    last ? Number(NAME.exec(last.name)![2]) + 1 : 1;
  const file = new File(dir, "diag-" + day + "-" + String(index).padStart(3, "0") + ".jsonl");
  if (!file.exists) file.create({ intermediates: true });
  // One JSON object per line, append without re-reading megabytes of prior logs.
  await file.write(JSON.stringify(entry) + "\n", { append: true });
}
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = writes.then(work, work);
  writes = result.then(() => {}, () => {});
  return result;
}
export function diagnosticTrace(profile: string, conversation: string, turn: string): DiagnosticTrace {
  return (event, fields = {}, content) => {
    // Never throw into chat flow. All writes are serialized and fail closed.
    void enqueue(async () => {
      const settings = await getDiagnosticSettings(profile);
      if (!settings.enabled) return;
      const entry: Record<string, unknown> = {
        time: new Date().toISOString(), event: event.slice(0, 80), conversation, turn,
        data: clean(fields),
      };
      if (settings.includeContent && content) entry.content = clean(content);
      await append(profile, entry);
    }).catch(() => {});
  };
}
export async function listDiagnosticFiles(profile: string): Promise<DiagnosticFile[]> {
  await writes;
  const dir = await directory(profile);
  return files(dir).reverse().map(file => ({ name: file.name, size: file.size || 0 }));
}
export async function shareDiagnosticFile(profile: string, name: string): Promise<void> {
  if (!NAME.test(name)) throw new Error("Некорректное имя журнала");
  await writes;
  const dir = await directory(profile);
  const file = new File(dir, name);
  if (!file.exists) throw new Error("Файл журнала не найден");
  if (!await Sharing.isAvailableAsync()) throw new Error("На устройстве недоступна передача файлов");
  await Sharing.shareAsync(file.uri, { mimeType: "application/x-ndjson", dialogTitle: "Передать диагностический журнал PersAI" });
}
export async function deleteDiagnosticFiles(profile: string): Promise<void> {
  await enqueue(async () => {
    const dir = await directory(profile);
    for (const file of files(dir)) file.delete();
  });
}

/** Reset only the in-memory preferences cache in isolated tests. */
export function resetDiagnosticsForTests() { cache.clear(); loading.clear(); }
