import React from "react";
import { AppState } from "./native";
const stats = (window as any).__qa = { auth: 0, closes: 0, sends: 0, authorized: false, deletes: [] as string[] };
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "device";
const vault = new Map<string, string>();
export const getItemAsync = async (k: string) => vault.get(k) || null;
export const setItemAsync = async (k: string, v: string) => { vault.set(k, v); };
export const deleteItemAsync = async (k: string) => { vault.delete(k); };
export const isAvailableAsync = async () => true;
export const hasHardwareAsync = async () => true;
export const isEnrolledAsync = async () => true;
export const authenticateAsync = async () => { stats.auth++; return { success: true }; };
export const authenticateExistingMemory = async () => false;
export const authorizeLocalMemorySession = () => { stats.authorized = true; };
export const revokeLocalMemorySession = () => { stats.authorized = false; };
export const closeLocalMemory = async () => { stats.closes++; };
export const cacheDirectory = "file:///qa-cache/";
export const EncodingType = { Base64: "base64" };
export const getInfoAsync = async () => ({ exists: true, isDirectory: false, size: 100 });
export const readAsStringAsync = async (_uri: string, options?: any) => options?.encoding === "base64" ? "dGVzdA==" : "Рецепт: индейка, чеснок, паприка. Запекать до готовности.";
export const deleteAsync = async (uri: string) => { stats.deletes.push(uri); };
export const getDocumentAsync = async () => {
  (window as any).__state("background"); await new Promise(resolve => setTimeout(resolve, 20)); (window as any).__state("active");
  return { canceled: false, assets: [{ uri: "file:///qa-cache/note.txt", name: "note.txt", mimeType: "text/plain", size: 100 }] };
};
export const getThumbnailAsync = async () => ({ uri: "file:///qa-cache/frame.jpg" });
export const createVideoPlayer = () => ({ release() {}, muted: true, addListener() { return { remove() {} }; }, replaceAsync: async () => {} });
const speechListeners = new Map<string, Set<(value: any) => void>>();
export const ExpoSpeechRecognitionModule = {
  isRecognitionAvailable: () => true, supportsOnDeviceRecognition: () => true,
  requestPermissionsAsync: async () => ({ granted: true }),
  start: () => { speechListeners.get("result")?.forEach(fn => fn({ results: [{ transcript: "Купить молоко и хлеб" }], isFinal: true })); speechListeners.get("end")?.forEach(fn => fn({})); },
  stop: () => speechListeners.get("end")?.forEach(fn => fn({})), abort: () => {},
};
export function useSpeechRecognitionEvent(event: string, fn: (value: any) => void) {
  React.useEffect(() => {
    if (!speechListeners.has(event)) speechListeners.set(event, new Set()); speechListeners.get(event)!.add(fn);
    return () => { speechListeners.get(event)?.delete(fn); };
  }, [event, fn]);
}
export default { expoConfig: { version: "0.3.0-qa", extra: { apiBase: "", buildSha: "qa" } } };

export const LOCAL_MEMORY_SCHEMA_VERSION = 1;
export const localMemoryIdentity = async () => ({ databaseName: "qa.db", keyName: "qa" });
export const withLocalMemoryDatabase = async () => { throw new Error("Native SQLCipher backups require an actual phone."); };

export const copyAsync = async () => {};
export const writeAsStringAsync = async () => {};
