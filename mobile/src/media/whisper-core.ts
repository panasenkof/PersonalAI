/** Pure parts of on-device dictation with Whisper (react-native-executorch). */

export type WhisperId = "base" | "tiny";
export type WhisperChoice = { id: WhisperId; name: string; approxMb: number; hint: string };
/** Multilingual models: the English-only variants cannot hear Russian. */
export const WHISPER_CHOICES: WhisperChoice[] = [
  { id: "base", name: "Whisper base", approxMb: 400, hint: "Точнее; рекомендуется." },
  { id: "tiny", name: "Whisper tiny", approxMb: 150, hint: "Меньше и быстрее, но чаще ошибается в русском." },
];
export const isWhisperId = (value: unknown): value is WhisperId => value === "base" || value === "tiny";
export const WHISPER_RATE = 16000;
export const WHISPER_FILE_CHUNK_SECONDS = 25;
export const MAX_WHISPER_FILE_SECONDS = 20 * 60;
/** Whisper's pre-recorded inference uses a <=30 s window. Return *exact*
 * nonoverlapping 16 kHz sample intervals: no missing tail and no invented
 * source timestamps. Very short trailing audio joins the preceding chunk.
 * Files beyond the bounded decoded-memory budget fail explicitly.
 */
export function whisperFileChunks(sampleCount: number): Array<{ start: number; end: number }> {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) throw new Error("invalid_whisper_sample_count");
  if (sampleCount > MAX_WHISPER_FILE_SECONDS * WHISPER_RATE) {
    throw new Error("Локальное распознавание поддерживает записи до 20 минут. Длинную запись разделите на файлы; ни одна часть не будет обрезана автоматически.");
  }
  const size = WHISPER_FILE_CHUNK_SECONDS * WHISPER_RATE;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < sampleCount;) {
    let end = Math.min(sampleCount, start + size);
    if (sampleCount - end > 0 && sampleCount - end < WHISPER_RATE) end = sampleCount;
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}


/** react-native-executorch needs Android 13+ (API 33) or iOS 17+. */
export function whisperSupported(os: string, version: string | number): boolean {
  const v = typeof version === "number" ? version : parseFloat(version);
  if (os === "android") return Number.isFinite(v) && v >= 33;
  if (os === "ios") return Number.isFinite(v) && v >= 17;
  return false;
}

/** The recorder may deliver another rate than asked for; Whisper needs 16 kHz mono. */
export function resampleTo16k(samples: Float32Array, rate: number): Float32Array {
  if (!rate || rate === WHISPER_RATE || !samples.length) return samples;
  const ratio = rate / WHISPER_RATE;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio; const left = Math.floor(pos); const right = Math.min(left + 1, samples.length - 1);
    out[i] = samples[left] + (samples[right] - samples[left]) * (pos - left);
  }
  return out;
}

/** Whisper's streaming text: finalized part plus the part still being heard. */
export function joinTranscript(committed: string, nonCommitted: string): string {
  return [committed.trim(), nonCommitted.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

/** Plain-language reason for a model download or recognition failure. */
export function whisperErrorMessage(error: unknown, stage: "download" | "load" | "record" | "recognize"): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  const message = String((error as Error)?.message || error || "").replace(/\s+/g, " ").slice(0, 160);
  const offline = /network|internet|offline|unable to resolve|timed? ?out|connection|ENOTFOUND|SocketTimeout|UnknownHost/i.test(message);
  const space = /space|ENOSPC|storage|disk/i.test(message);
  const what =
    stage === "download" ? (space ? "на телефоне не хватает места для модели" : offline ? "не удалось скачать модель — нет связи с huggingface.co" : "не удалось скачать модель") :
    stage === "load" ? (/memory|OOM|alloc/i.test(message) ? "не хватает памяти, чтобы загрузить модель — закройте другие приложения или выберите Whisper tiny" : "не удалось загрузить модель — скачайте её заново в настройках") :
    stage === "record" ? "микрофон недоступен — разрешите его для PersAI или закройте приложение, которое его занимает" :
    code === "RESOURCE_BUSY" ? "модель ещё занята предыдущей диктовкой — подождите секунду" : "не удалось распознать речь";
  const detail = [code, message].filter(Boolean).join(": ");
  return `Голос на телефоне: ${what}.${detail ? ` Код: «${detail}».` : ""}`;
}
