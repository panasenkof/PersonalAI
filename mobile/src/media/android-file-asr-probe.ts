import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { monoWav } from "./video-audio";

/** Feasibility only: a speech service may ignore EXTRA_AUDIO_SOURCE and turn on
 * the microphone. Never expose this experiment as a normal ASR engine. */
export type AndroidFileProbeResult =
  | { status: "observed"; transcript: string }
  | { status: "unsupported"; reason: string }
  | { status: "error"; reason: string };

export const PROBE_MAX_INPUT_BYTES = 1024 * 1024;
export const PROBE_MAX_SECONDS = 12;
export const PROBE_TIMEOUT_MS = 20_000;

export function androidFileProbeEligible(os: string, api: number, uri: string, bytes: number): boolean {
  return os === "android" && api >= 33 && /^file:\/\//.test(uri) &&
    Number.isSafeInteger(bytes) && bytes > 0 && bytes <= PROBE_MAX_INPUT_BYTES;
}

function reason(e: unknown): string {
  // Do not include URI, filename, credentials, original transcript or stack trace.
  return e instanceof Error && /permission|denied/i.test(e.message) ? "Нет разрешения на системную службу речи." :
    "Системная служба не смогла обработать тестовый аудиофайл.";
}

/** Only call after a developer explicitly acknowledges microphone/network risk.
 * This uses the EXISTING expo-speech-recognition native module, not a second
 * recognizer, data writer, credential store or transmission endpoint.
 * An observed transcript is NOT proof that the recognizer read the file.
 */
export async function runAndroidFileProbe(uri: string, signal?: AbortSignal): Promise<AndroidFileProbeResult> {
  if (!__DEV__ || Platform.OS !== "android" || Number(Platform.Version) < 33)
    return { status: "unsupported", reason: "Эксперимент доступен только в отладочной Android 13+ сборке." };
  if (signal?.aborted) return { status: "error", reason: "Проверка отменена." };
  let temporary: File | undefined;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!androidFileProbeEligible(Platform.OS, Number(Platform.Version), uri, info.exists && !info.isDirectory ? info.size ?? 0 : 0))
      return { status: "unsupported", reason: "Выберите небольшой аудиофайл из локального кэша (не более 1 МБ)." };
    const { decodeAudioData } = require("react-native-audio-api") as typeof import("react-native-audio-api");
    const decoded = await decodeAudioData(uri, 16_000);
    if (signal?.aborted) return { status: "error", reason: "Проверка отменена." };
    if (!decoded.numberOfChannels || !Number.isFinite(decoded.duration) || decoded.duration < 1 || decoded.duration > PROBE_MAX_SECONDS)
      return { status: "unsupported", reason: "Для проверки требуется запись речи длительностью от 1 до 12 секунд." };
    if (decoded.sampleRate !== 16_000)
      return { status: "unsupported", reason: "Аудиодекодер не подготовил 16 кГц PCM; передача некорректных данных в системную службу запрещена." };
    const pcm = monoWav(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)), 16_000);
    const dir = new Directory(Paths.cache, "persai-asr-probe");
    dir.create({ intermediates: true, idempotent: true });
    temporary = new File(dir, Crypto.randomUUID() + ".wav");
    temporary.create();
    const handle = temporary.open(FileMode.WriteOnly);
    try { handle.writeBytes(pcm); }
    finally { handle.close(); }

    if (signal?.aborted) return { status: "error", reason: "Проверка отменена." };
    const { ExpoSpeechRecognitionModule: speech } =
      require("expo-speech-recognition") as typeof import("expo-speech-recognition");
    if (!speech.isRecognitionAvailable())
      return { status: "unsupported", reason: "На устройстве нет доступной системной службы распознавания." };
    const permission = await speech.requestPermissionsAsync();
    if (!permission.granted) return { status: "unsupported", reason: "Разрешение на системное распознавание не предоставлено." };
    if (signal?.aborted) return { status: "error", reason: "Проверка отменена." };

    let complete!: (result: AndroidFileProbeResult) => void;
    const completed = new Promise<AndroidFileProbeResult>(resolve => { complete = resolve; });
    const subscriptions: Array<{ remove: () => void }> = [];
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: AndroidFileProbeResult) => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      for (const item of subscriptions) item.remove();
      try { speech.abort(); } catch { /* the service may already have ended */ }
      complete(result);
    };
    const onAbort = () => finish({ status: "error", reason: "Проверка отменена." });
    signal?.addEventListener("abort", onAbort, { once: true });
    subscriptions.push(speech.addListener("result", event => {
      const text = event.results?.[0]?.transcript?.trim();
      if (text) finish({ status: "observed", transcript: text.slice(0, 2000) });
    }));
    subscriptions.push(speech.addListener("error", event => {
      finish({ status: "unsupported", reason: "Распознаватель вернул ошибку: " + String(event.error || "unknown").slice(0, 50) });
    }));
    subscriptions.push(speech.addListener("end", () => {
      finish({ status: "unsupported", reason: "Системный распознаватель завершил работу без текста." });
    }));
    timer = setTimeout(() => finish({ status: "unsupported", reason: "Служба не ответила за 20 секунд." }), PROBE_TIMEOUT_MS);
    try {
      speech.start({
        lang: "ru-RU",
        interimResults: false,
        continuous: false,
        requiresOnDeviceRecognition: true,
        audioSource: {
          uri: temporary.uri,
          sampleRate: 16_000,
          audioChannels: 1,
          audioEncoding: 2,
        },
      });
    } catch (e) { finish({ status: "error", reason: reason(e) }); }
    return await completed;
  } catch (e) {
    return { status: "error", reason: reason(e) };
  } finally {
    // This isolated test never writes to notes, SQLCipher, network adapters or logs.
    try { if (temporary?.exists) temporary.delete(); } catch { /* app lock / cleanup race */ }
  }
}
