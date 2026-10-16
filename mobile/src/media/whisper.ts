import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import type { WhisperSpeechToText, WhisperSttModel } from "react-native-executorch";
import { WHISPER_RATE, isWhisperId, joinTranscript, resampleTo16k, whisperErrorMessage, whisperSupported } from "./whisper-core";
import type { WhisperId } from "./whisper-core";

/** On-device dictation: the model is downloaded once, only when the user asks,
 * and speech never leaves the phone. */
export type WhisperStatus =
  | { state: "unsupported" }
  | { state: "absent" }
  | { state: "downloading"; id: WhisperId; progress: number }
  | { state: "ready"; id: WhisperId }
  | { state: "error"; id?: WhisperId; message: string };

const KEY = "pia.voice.whisper.v1";
type Saved = { id: WhisperId; resolved: WhisperSttModel };

let status: WhisperStatus = { state: whisperSupported(Platform.OS, Platform.Version) ? "absent" : "unsupported" };
let initialized: Promise<void> | null = null;
let engine: { id: WhisperId; model: WhisperSpeechToText } | null = null;
let aborter: AbortController | null = null;
const listeners = new Set<() => void>();
const set = (next: WhisperStatus) => { status = next; listeners.forEach(l => l()); };

const executorch = () => require("react-native-executorch") as typeof import("react-native-executorch");
const configFor = (id: WhisperId): WhisperSttModel => {
  const family = executorch().models.speechToText.WHISPER;
  const group = id === "tiny" ? family.TINY : family.BASE;
  // CPU (XNNPACK) on Android works on every phone; Core ML on iOS.
  return Platform.OS === "ios" ? group.COREML_FP16 : group.XNNPACK_FP32;
};
const pathsOf = (m?: WhisperSttModel) => m ? [m.modelPath, m.tokenizerPath, m.vadModel?.modelPath].filter((p): p is string => Boolean(p) && !/^https?:/.test(p!)) : [];
async function unlink(paths: string[]) {
  if (!paths.length) return;
  const BlobUtil = (require("react-native-blob-util") as typeof import("react-native-blob-util")).default;
  for (const path of paths) await BlobUtil.fs.unlink(path.replace(/^file:\/\//, "")).catch(() => undefined);
}
async function readSaved(): Promise<Saved | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const saved = raw ? JSON.parse(raw) as Saved : null;
    return saved && isWhisperId(saved.id) && saved.resolved?.modelPath ? saved : null;
  } catch { return null; }
}

export function initWhisper(): Promise<void> {
  if (status.state === "unsupported") return Promise.resolve();
  return initialized ??= readSaved().then(saved => { if (saved && status.state === "absent") set({ state: "ready", id: saved.id }); });
}
export const getWhisperStatus = () => status;
export function useWhisperStatus(): WhisperStatus {
  return useSyncExternalStore(l => { listeners.add(l); void initWhisper(); return () => { listeners.delete(l); }; }, getWhisperStatus, getWhisperStatus);
}

export async function downloadWhisper(id: WhisperId): Promise<void> {
  if (status.state === "unsupported" || status.state === "downloading") return;
  aborter?.abort(); aborter = new AbortController();
  const signal = aborter.signal;
  set({ state: "downloading", id, progress: 0 });
  try {
    const rne = executorch();
    // The library sends anonymous download statistics unless told not to.
    rne.setTelemetryEnabled(false);
    const resolved = await rne.download(configFor(id), { signal, onProgress: progress => {
      if (!signal.aborted) set({ state: "downloading", id, progress: Math.round(progress * 100) });
    } });
    const previous = await readSaved();
    await SecureStore.setItemAsync(KEY, JSON.stringify({ id, resolved } satisfies Saved));
    engine?.model.dispose(); engine = null;
    // Replacing a model frees the old files (the shared voice detector stays).
    const keep = new Set(pathsOf(resolved));
    await unlink(pathsOf(previous?.resolved).filter(p => !keep.has(p)));
    set({ state: "ready", id });
  } catch (e) {
    if (signal.aborted) { const saved = await readSaved(); set(saved ? { state: "ready", id: saved.id } : { state: "absent" }); return; }
    set({ state: "error", id, message: whisperErrorMessage(e, "download") });
  }
}
export function cancelWhisperDownload() { aborter?.abort(); }

export async function deleteWhisper(): Promise<void> {
  aborter?.abort();
  engine?.model.dispose(); engine = null;
  const saved = await readSaved();
  await SecureStore.deleteItemAsync(KEY);
  await unlink(pathsOf(saved?.resolved));
  if (status.state !== "unsupported") set({ state: "absent" });
}

async function loadEngine(): Promise<WhisperSpeechToText> {
  const saved = await readSaved();
  if (!saved) throw new Error("Модель распознавания не скачана. Скачайте её: Настройки → Голос без интернета.");
  if (engine?.id === saved.id) return engine.model;
  engine?.model.dispose(); engine = null;
  try { engine = { id: saved.id, model: await executorch().createWhisperSpeechToText(saved.resolved) }; }
  catch (e) { throw new Error(whisperErrorMessage(e, "load")); }
  return engine.model;
}

export type DictationSession = { stop: () => Promise<void> };
/** Records 16 kHz mono and streams it into Whisper; `onText` receives the whole
 * transcript so far. Resolves once the microphone is running. */
export async function startWhisperDictation(onText: (text: string) => void, onError: (message: string) => void, onEnd: () => void): Promise<DictationSession> {
  const model = await loadEngine();
  const { AudioManager, AudioRecorder } = require("react-native-audio-api") as typeof import("react-native-audio-api");
  const permission = await AudioManager.requestRecordingPermissions();
  if (permission !== "Granted") throw new Error("Голос на телефоне: нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона.");
  AudioManager.setAudioSessionOptions({ iosCategory: "playAndRecord", iosMode: "spokenAudio", iosOptions: ["allowBluetoothHFP", "defaultToSpeaker"] });
  let ended = false;
  const finish = () => { if (!ended) { ended = true; onEnd(); } };
  void (async () => {
    try { for await (const part of model.stream({ language: "ru" })) onText(joinTranscript(part.committed, part.nonCommitted)); }
    catch (e) { onError(whisperErrorMessage(e, "recognize")); }
    finally { finish(); }
  })();
  const recorder = new AudioRecorder();
  recorder.onAudioReady({ sampleRate: WHISPER_RATE, bufferLength: 1600, channelCount: 1 }, event => {
    model.streamInsert(resampleTo16k(new Float32Array(event.buffer.getChannelData(0)), event.buffer.sampleRate));
  });
  const started = await recorder.start();
  if (started.status === "error") {
    recorder.clearOnAudioReady(); model.streamStop();
    throw new Error(whisperErrorMessage(new Error(started.message), "record"));
  }
  return { stop: async () => {
    recorder.clearOnAudioReady();
    await recorder.stop().catch(() => undefined);
    model.streamStop();
  } };
}

/** Transcribes an audio file on the phone: decoded to 16 kHz mono and passed
 * to Whisper. The file never leaves the device. */
export async function transcribeAudioFile(uri: string, signal?: AbortSignal): Promise<string> {
  const model = await loadEngine();
  const FileSystem = require("expo-file-system/legacy") as typeof import("expo-file-system/legacy");
  const { toByteArray } = require("base64-js") as typeof import("base64-js");
  const { decodeAudioData } = require("react-native-audio-api") as typeof import("react-native-audio-api");
  let samples: Float32Array;
  try {
    const bytes = toByteArray(await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }));
    const audio = await decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, WHISPER_RATE);
    // Stereo files are mixed down to mono.
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    samples = channels.length === 1 ? new Float32Array(channels[0]) : new Float32Array(audio.length).map((_, i) => channels.reduce((sum, ch) => sum + ch[i], 0) / channels.length);
    samples = resampleTo16k(samples, audio.sampleRate);
  } catch (e) { throw new Error("Голос на телефоне: не удалось прочитать аудиофайл — поддерживаются MP3, M4A, WAV, OGG, FLAC, AAC. Код: «" + String((e as Error)?.message || e).slice(0, 120) + "»."); }
  if (signal?.aborted) throw new Error("Разбор файла остановлен");
  const stop = () => model.transcribeStop();
  signal?.addEventListener("abort", stop, { once: true });
  try { return (await model.transcribe(samples, { language: "ru" })).trim(); }
  catch (e) { if (signal?.aborted) throw new Error("Разбор файла остановлен"); throw new Error(whisperErrorMessage(e, "recognize")); }
  finally { signal?.removeEventListener("abort", stop); }
}
