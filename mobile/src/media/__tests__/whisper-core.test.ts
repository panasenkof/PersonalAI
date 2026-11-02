import { joinTranscript, resampleTo16k, whisperErrorMessage, whisperSupported, WHISPER_CHOICES, whisperFileChunks, WHISPER_RATE, MAX_WHISPER_FILE_SECONDS } from "../whisper-core";

test("only multilingual models are offered, base first", () => {
  expect(WHISPER_CHOICES.map(c => c.id)).toEqual(["base", "tiny"]);
});
test("Whisper needs Android 13+ or iOS 17+", () => {
  expect(whisperSupported("android", 33)).toBe(true);
  expect(whisperSupported("android", 32)).toBe(false);
  expect(whisperSupported("ios", "17.2")).toBe(true);
  expect(whisperSupported("ios", "16.7")).toBe(false);
  expect(whisperSupported("web", 1)).toBe(false);
});
test("audio at another rate is resampled to 16 kHz", () => {
  const input = new Float32Array(48000).map((_, i) => i / 48000);
  const out = resampleTo16k(input, 48000);
  expect(out.length).toBe(16000);
  expect(Math.abs(out[8000] - 0.5)).toBeLessThan(0.001);
  const same = new Float32Array([1, 2]);
  expect(resampleTo16k(same, 16000)).toBe(same);
});
test("streaming text joins the finalized and in-progress parts", () => {
  expect(joinTranscript(" Купить молоко ", " и хлеб")).toBe("Купить молоко и хлеб");
  expect(joinTranscript("", "")).toBe("");
});
test("errors name the stage, the reason and the code", () => {
  expect(whisperErrorMessage(new Error("Unable to resolve host huggingface.co"), "download")).toContain("нет связи с huggingface.co");
  expect(whisperErrorMessage(new Error("ENOSPC: no space left"), "download")).toContain("не хватает места");
  expect(whisperErrorMessage(Object.assign(new Error("busy"), { code: "RESOURCE_BUSY" }), "recognize")).toContain("Код: «RESOURCE_BUSY: busy»");
  expect(whisperErrorMessage(new Error("failed to allocate memory"), "load")).toContain("не хватает памяти");
});

test("F2a: chunk boundaries cover all audio exactly once without a lost tail", () => {
  const samples = 52 * WHISPER_RATE + 5;
  expect(whisperFileChunks(samples)).toEqual([
    { start: 0, end: 25 * WHISPER_RATE },
    { start: 25 * WHISPER_RATE, end: 50 * WHISPER_RATE },
    { start: 50 * WHISPER_RATE, end: samples },
  ]);
  const shortTail = 25 * WHISPER_RATE + 123;
  expect(whisperFileChunks(shortTail)).toEqual([{ start: 0, end: shortTail }]);
  expect(whisperFileChunks(0)).toEqual([]);
  expect(whisperFileChunks(MAX_WHISPER_FILE_SECONDS * WHISPER_RATE).at(-1)?.end)
    .toBe(MAX_WHISPER_FILE_SECONDS * WHISPER_RATE);
});
test("F2a: refuse oversized or invalid waveform lengths without truncating samples", () => {
  expect(() => whisperFileChunks(MAX_WHISPER_FILE_SECONDS * WHISPER_RATE + 1)).toThrow("20 минут");
  expect(() => whisperFileChunks(-1)).toThrow("invalid_whisper_sample_count");
  expect(() => whisperFileChunks(NaN)).toThrow("invalid_whisper_sample_count");
});
