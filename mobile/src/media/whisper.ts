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
    await SecureStore.setItemAsync(KEY, JSON.stringify({ id, resolved } satisfies Saved));
    engine?.model.dispose(); engine = null;
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
  if (saved) {
    const BlobUtil = (require("react-native-blob-util") as typeof import("react-native-blob-util")).default;
    for (const path of [saved.resolved.modelPath, saved.resolved.tokenizerPath, saved.resolved.vadModel?.modelPath]) {
      if (path && !/^https?:/.test(path)) await BlobUtil.fs.unlink(path.replace(/^file:\/\//, "")).catch(() => undefined);
    }
  }
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
