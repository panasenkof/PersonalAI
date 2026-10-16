import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";
import type { FsmnVoiceActivityDetector, WhisperSpeechToText, WhisperSttModel } from "react-native-executorch";
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

let engineLoad: Promise<WhisperSpeechToText> | null = null;
async function loadEngine(): Promise<WhisperSpeechToText> {
  if (engineLoad) return engineLoad;
  const loading = loadEngineOnce();
  engineLoad = loading;
  try { return await loading; }
  finally { if (engineLoad === loading) engineLoad = null; }
}
async function loadEngineOnce(): Promise<WhisperSpeechToText> {
  const saved = await readSaved();
  if (!saved) throw new Error("Модель распознавания не скачана. Скачайте её: Настройки → Голос без интернета.");
  if (engine?.id === saved.id) return engine.model;
  engine?.model.dispose(); engine = null;
  try { engine = { id: saved.id, model: await executorch().createWhisperSpeechToText(saved.resolved) }; }
  catch (e) { throw new Error(whisperErrorMessage(e, "load")); }
  return engine.model;
}

export type DictationSession = { stop: () => Promise<void> };
export const DICTATION_PAUSE_MS = 1800;
export const NO_SPEECH_TIMEOUT_MS = 8000;
const MAX_DICTATION_MS = 60_000;
type DictationOptions = { signal?: AbortSignal; onFinishing?: () => void };
let dictationDrain: Promise<void> = Promise.resolve();
/** A new draft waits for an aborted decoder's final cleanup before reusing the
 * same model. Otherwise the old generator can reset the new stream's state. */
export async function startWhisperDictation(onText: (text: string) => void, onError: (message: string) => void,
  onEnd: () => void, options: DictationOptions = {}): Promise<DictationSession> {
  const previous = dictationDrain;
  let release!: () => void;
  dictationDrain = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await beginWhisperDictation(onText, onError, () => { release(); onEnd(); }, options); }
  catch (e) { release(); throw e; }
}
/** A neural VAD observes microphone audio independently of the slower Whisper
 * decoder. Finishing releases the microphone, then flushes the last phrase.
 * The detector reuses the already downloaded VAD model; nothing is fetched. */
async function beginWhisperDictation(onText: (text: string) => void, onError: (message: string) => void,
  onEnd: () => void, { signal, onFinishing }: DictationOptions = {}): Promise<DictationSession> {
  const checkCancelled = () => { if (signal?.aborted) throw new Error("Диктовка отменена."); };
  checkCancelled();
  const model = await loadEngine();
  checkCancelled();
  const { AudioManager, AudioRecorder } = require("react-native-audio-api") as typeof import("react-native-audio-api");
  const permission = await AudioManager.requestRecordingPermissions();
  checkCancelled();
  if (permission !== "Granted") throw new Error("Голос на телефоне: нет разрешения на микрофон. Разрешите микрофон для PersAI в настройках телефона.");
  const saved = await readSaved();
  checkCancelled();
  if (!saved) throw new Error("Модель распознавания не скачана.");
  let vad: FsmnVoiceActivityDetector;
  try { vad = await executorch().createFsmnVoiceActivityDetector(saved.resolved.vadModel); }
  catch (e) { throw new Error(whisperErrorMessage(e, "load")); }
  if (signal?.aborted) { vad.dispose(); checkCancelled(); }
  let recorder: InstanceType<typeof AudioRecorder>;
  try { recorder = new AudioRecorder(); }
  catch (e) { vad.dispose(); throw new Error(whisperErrorMessage(e, "record")); }
  let ended = false;
  let speechDetected = false;
  let stopping: Promise<void> | null = null;
  let recordingStart: ReturnType<typeof recorder.start> | undefined;
  let noSpeechTimer: ReturnType<typeof setTimeout> | undefined;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const heardSpeech = () => { clearTimeout(noSpeechTimer); noSpeechTimer = undefined; };
  const stop = (): Promise<void> => stopping ??= (async () => {
    heardSpeech(); clearTimeout(limitTimer);
    recorder.clearOnAudioReady();
    // A cancellation may arrive while the native recorder is still starting.
    await recordingStart?.catch(() => undefined);
    try { await recorder.stop(); } catch { /* already stopped */ }
    finally { model.streamStop(); vad.dispose(); }
  })();
  const finish = () => { if (!stopping && !ended) { onFinishing?.(); void stop(); } };
  const cancel = () => { model.transcribeStop(); void stop(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const stream = (async () => {
    try {
      for await (const part of model.stream({ language: "ru" })) {
        const text = joinTranscript(part.committed, part.nonCommitted);
        if (!signal?.aborted && text) onText(text);
      }
    } catch (e) { if (!signal?.aborted) onError(whisperErrorMessage(e, "recognize")); }
    finally { await stop(); signal?.removeEventListener("abort", cancel); ended = true; onEnd(); }
  })();
  try {
    AudioManager.setAudioSessionOptions({ iosCategory: "playAndRecord", iosMode: "spokenAudio", iosOptions: ["allowBluetoothHFP", "defaultToSpeaker"] });
    recorder.onAudioReady({ sampleRate: WHISPER_RATE, bufferLength: 1600, channelCount: 1 }, event => {
      if (stopping || ended) return;
      try {
        const samples = resampleTo16k(new Float32Array(event.buffer.getChannelData(0)), event.buffer.sampleRate);
        model.streamInsert(samples);
        // A 2.5-second rolling neural window distinguishes speech from noise.
        // The margin tolerates breaths and thinking pauses before ending input.
        const activity = vad.detectVoiceOnStream(samples, {
          detectionMargin: DICTATION_PAUSE_MS, minSpeechDurationMs: 150,
          minSilenceDurationMs: 300, speechPadMs: 100, mergeGapMs: 300,
        });
        if (activity === "speechStart") { speechDetected = true; heardSpeech(); }
        if (activity === "speechEnd") finish();
      } catch (e) { onError(whisperErrorMessage(e, "recognize")); void stop(); }
    });
    const started = await (recordingStart = recorder.start());
    if (started.status === "error") throw new Error(whisperErrorMessage(new Error(started.message), "record"));
    if (!stopping && !ended) {
      if (!speechDetected) noSpeechTimer = setTimeout(() => {
        onError("Голосовой ввод: речь не обнаружена за 8 секунд. Нажмите микрофон и повторите.");
        finish();
      }, NO_SPEECH_TIMEOUT_MS);
      limitTimer = setTimeout(finish, MAX_DICTATION_MS);
    }
    return { stop: async () => { finish(); await stop(); } };
  } catch (e) {
    await stop(); await stream;
    throw e;
  }
}

/** Transcribes an audio file on the phone: decoded to 16 kHz mono and passed
 * to Whisper. The file never leaves the device. */
export async function transcribeAudioFile(uri: string, signal?: AbortSignal): Promise<string> {
  await dictationDrain;
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
