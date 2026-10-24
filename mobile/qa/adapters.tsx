import React from "react";
import { AppState } from "./native";
const stats = (window as any).__qa = { auth: 0, closes: 0, sends: 0, authorized: false, deletes: [] as string[] };
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "device";
export const getItemAsync = async (k: string) => localStorage.getItem(k);
export const setItemAsync = async (k: string, v: string) => { localStorage.setItem(k, v); };
export const deleteItemAsync = async (k: string) => { localStorage.removeItem(k); };
export const isAvailableAsync = async () => true;
export const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
export const getEnrolledLevelAsync = async () => SecurityLevel.BIOMETRIC_STRONG;
export const authenticateAsync = async () => { stats.auth++; return { success: true }; };
export const authenticateExistingMemory = async () => false;
const sessionListeners = new Set<() => void>();
export const waitForApplicationSession = async (signal?: AbortSignal) => {
  if (stats.authorized) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { sessionListeners.delete(done); signal?.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { sessionListeners.delete(done); reject(new Error("session_disposed")); };
    sessionListeners.add(done); signal?.addEventListener("abort", cancel, { once: true });
  });
};
export const authorizeLocalMemorySession = () => { stats.authorized = true; sessionListeners.forEach(fn => fn()); };
export const revokeLocalMemorySession = () => { stats.authorized = false; };
export const closeLocalMemory = async () => { stats.closes++; };
export const onLocalMemorySessionChange = (_listener: (unlocked: boolean) => void) => () => {};
export const localMemorySessionUnlocked = () => Boolean(stats.authorized);
export const cacheDirectory = "file:///qa-cache/";
export const EncodingType = { Base64: "base64" };
export const getInfoAsync = async () => ({ exists: true, isDirectory: false, size: 100 });
export const readAsStringAsync = async (_uri: string, options?: any) => options?.encoding === "base64" ? "dGVzdA==" : "Рецепт: индейка, чеснок, паприка. Запекать до готовности.";
export const deleteAsync = async (uri: string) => { stats.deletes.push(uri); };
export const getDocumentAsync = async () => {
  (window as any).__state("background"); await new Promise(resolve => setTimeout(resolve, 20)); (window as any).__state("active");
  return { canceled: false, assets: [{ uri: "file:///qa-cache/note.txt", name: "note.txt", mimeType: "text/plain", size: 100 }] };
};
export const createVideoPlayer = () => ({ release() {}, muted: true, addListener() { return { remove() {} }; }, replaceAsync: async () => {}, generateThumbnailsAsync: async (times: number[]) => times.map(t => ({ requestedTime: t })) });
export const ImageManipulator = { manipulate: () => ({ renderAsync: async () => ({ saveAsync: async () => ({ uri: "file:///qa-cache/frame.jpg", base64: "ZnJhbWU=" }) }) }) };
export const SaveFormat = { JPEG: "jpeg", PNG: "png", WEBP: "webp" };
const speechListeners = new Map<string, Set<(value: any) => void>>();
export const ExpoSpeechRecognitionModule = {
  isRecognitionAvailable: () => true, supportsOnDeviceRecognition: () => true,
  requestPermissionsAsync: async () => ({ granted: true }),
  start: () => { speechListeners.get("start")?.forEach(fn => fn({}));
    if ((stats as any).holdSpeech) return;
    speechListeners.get("result")?.forEach(fn => fn({ results: [{ transcript: "Купить молоко и хлеб" }], isFinal: true })); speechListeners.get("end")?.forEach(fn => fn({})); },
  stop: () => speechListeners.get("end")?.forEach(fn => fn({})), abort: () => { (stats as any).speechAborts = ((stats as any).speechAborts || 0) + 1; },
};
(window as any).__speechEvent = (name: string, event: any) => speechListeners.get(name)?.forEach(fn => fn(event));
export function useSpeechRecognitionEvent(event: string, fn: (value: any) => void) {
  React.useEffect(() => {
    if (!speechListeners.has(event)) speechListeners.set(event, new Set()); speechListeners.get(event)!.add(fn);
    return () => { speechListeners.get(event)?.delete(fn); };
  }, [event, fn]);
}
export default { expoConfig: { version: "0.3.0-qa", extra: { apiBase: "", buildSha: "qa" } } };

export const LOCAL_MEMORY_SCHEMA_VERSION = 5;
export const localMemoryIdentity = async () => ({ databaseName: "qa.db", keyName: "qa" });
export const withLocalMemoryDatabase = async () => { throw new Error("Native SQLCipher backups require an actual phone."); };

export const copyAsync = async () => {};
export const writeAsStringAsync = async () => {};

// react-native-executorch, react-native-audio-api, react-native-blob-util: on-device
// Whisper is unsupported on the web, so these are never called in the browser check.
export const models = { speechToText: { WHISPER: {} }, textEmbeddings: { PARAPHRASE_MULTILINGUAL_MINILM_L12_V2: {} } };
export const createTextEmbedder = async () => { throw new Error("Embeddings are not available on the web"); };
export const setTelemetryEnabled = () => {};
export const download = async (config: unknown) => config;
export const createFsmnVoiceActivityDetector = async () => { throw new Error("VAD is not available on the web"); };
export const createWhisperSpeechToText = async () => { throw new Error("Whisper is not available on the web"); };
export const AudioManager = { requestRecordingPermissions: async () => "Denied", setAudioSessionOptions() {} };
export class AudioRecorder { onAudioReady() {} clearOnAudioReady() {} async start() { return { status: "error", message: "web" }; } async stop() {} }
export const fs = { unlink: async () => {} };
export class AsyncLocalStorage<T> { getStore(): T | undefined { return undefined; } run<R>(_store: T, fn: () => R): R { return fn(); } }


// New native media interfaces: browser checks do not claim codec/SQLCipher coverage.
export const Paths = { cache: "file:///qa-cache/" };
export const FileMode = { ReadOnly: "r", WriteOnly: "w" };
export class Directory { exists = false; constructor(..._parts: unknown[]) {} delete() {} }
export class File { constructor(..._parts: unknown[]) {} }
export const getSharedPayloads = () => [];
export const clearSharedPayloads = () => {};
export const getResolvedSharedPayloadsAsync = async () => [];
export const useVideoPlayer = () => null;
export const VideoView = () => null;
export const shareAsync = async () => { throw new Error('Native sharing requires an actual phone.'); };

export const manipulateAsync = async (uri: string) => ({ uri });
