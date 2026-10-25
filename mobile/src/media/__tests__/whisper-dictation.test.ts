import * as SecureStore from "expo-secure-store";
import { DRAIN_TIMEOUT_MS, VAD_WINDOW_SAMPLES, startWhisperDictation } from "../whisper";

const mockVad = { detectVoiceOnStream: jest.fn(), dispose: jest.fn() };
let mockAudio: ((event: any) => void) | undefined;
let mockClosed = false;
let mockWake: (() => void) | undefined;
let mockFinish: Promise<void> | null = null;
let mockParts: { committed: string; nonCommitted: string }[] = [];
const mockModel = {
  stream: jest.fn(async function* () {
    while (!mockClosed) {
      if (!mockParts.length) await new Promise<void>(resolve => { mockWake = resolve; });
      while (mockParts.length) yield mockParts.shift()!;
    }
    if (mockFinish) await mockFinish;
    if (mockModel.streamInsert.mock.calls.length) yield { committed: "Последняя фраза", nonCommitted: "" };
  }),
  streamInsert: jest.fn(),
  streamStop: jest.fn(() => { mockClosed = true; mockWake?.(); }),
  transcribeStop: jest.fn(), dispose: jest.fn(),
};
const mockRecorder = {
  onAudioReady: jest.fn((_options: any, fn: any) => { mockAudio = fn; }),
  clearOnAudioReady: jest.fn(), start: jest.fn(async () => ({ status: "success" })), stop: jest.fn(async () => ({})),
};
jest.mock("react-native-executorch", () => ({
  createWhisperSpeechToText: jest.fn(async () => mockModel),
  createFsmnVoiceActivityDetector: jest.fn(async () => mockVad),
}));
jest.mock("react-native-audio-api", () => ({
  AudioManager: { checkRecordingPermissions: jest.fn(async () => "Granted"), requestRecordingPermissions: jest.fn(async () => "Granted"), setAudioSessionOptions: jest.fn() },
  AudioRecorder: jest.fn(() => mockRecorder),
}));
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn() }));
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
// One full detector window per event; the batching test below sends 0.1 s buffers.
const audio = (samples = VAD_WINDOW_SAMPLES) => mockAudio!({ buffer: { sampleRate: 16_000, getChannelData: () => new Float32Array(samples) } });
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); mockClosed = false; mockWake = undefined; mockParts = []; mockFinish = null;
  mockVad.detectVoiceOnStream.mockReturnValue(undefined);
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(JSON.stringify({ id: "base", resolved: { modelPath: "/model", vadModel: { modelPath: "/vad", defaultOptions: {} } } }));
});
afterEach(() => { jest.useRealTimers(); });

test("a neural speech end stops the microphone once and flushes the last phrase before ending", async () => {
  const text = jest.fn(), error = jest.fn(), end = jest.fn(), finishing = jest.fn();
  await startWhisperDictation(text, error, end, { onFinishing: finishing });
  mockVad.detectVoiceOnStream.mockReturnValueOnce("speechStart"); audio();
  // Brief pauses are left to the VAD margin; no result timeout cuts off speech.
  jest.advanceTimersByTime(9000); audio();
  expect(mockRecorder.stop).not.toHaveBeenCalled();
  mockVad.detectVoiceOnStream.mockReturnValueOnce("speechEnd"); audio();
  await tick();
  expect(finishing).toHaveBeenCalledTimes(1);
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenLastCalledWith("Последняя фраза");
  expect(end).toHaveBeenCalledTimes(1); expect(error).not.toHaveBeenCalled();
  expect(mockVad.dispose).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60_000); expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
});

test("silence before the first word times out without inventing a transcript", async () => {
  const text = jest.fn(), error = jest.fn(), end = jest.fn();
  await startWhisperDictation(text, error, end);
  jest.advanceTimersByTime(7999); expect(mockRecorder.stop).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); await tick();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("речь не обнаружена"));
  expect(text).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1);
});

test("a repeated manual stop and abort release recording once; cancelled results never refill the draft", async () => {
  const text = jest.fn(), error = jest.fn(), end = jest.fn(); const aborter = new AbortController();
  const session = await startWhisperDictation(text, error, end, { signal: aborter.signal });
  mockVad.detectVoiceOnStream.mockReturnValueOnce("speechStart"); audio();
  aborter.abort(); await Promise.all([session.stop(), session.stop()]); await tick();
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1); expect(mockModel.transcribeStop).toHaveBeenCalledTimes(1);
  expect(text).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(end).toHaveBeenCalledTimes(1);
});

test("clearing during model loading cancels before the microphone starts", async () => {
  const aborter = new AbortController(); aborter.abort();
  await expect(startWhisperDictation(jest.fn(), jest.fn(), jest.fn(), { signal: aborter.signal })).rejects.toThrow("отменена");
  expect(mockRecorder.start).not.toHaveBeenCalled();
});

test("a decoder error also releases the microphone and detector", async () => {
  const error = jest.fn(), end = jest.fn();
  mockModel.stream.mockImplementationOnce(async function* () { throw new Error("decoder failed"); });
  await startWhisperDictation(jest.fn(), error, end); await tick();
  expect(error).toHaveBeenCalledWith(expect.stringContaining("decoder failed"));
  expect(mockRecorder.stop).toHaveBeenCalledTimes(1); expect(mockVad.dispose).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
});

test("a new dictation waits for the cancelled decoder to release its stream state", async () => {
  const aborter = new AbortController(); const firstEnd = jest.fn();
  await startWhisperDictation(jest.fn(), jest.fn(), firstEnd, { signal: aborter.signal });
  let finishDecoder!: () => void;
  mockFinish = new Promise<void>(resolve => { finishDecoder = resolve; });
  aborter.abort(); await tick();
  const next = startWhisperDictation(jest.fn(), jest.fn(), jest.fn());
  await tick();
  expect(mockRecorder.start).toHaveBeenCalledTimes(1);
  mockClosed = false; mockFinish = null; finishDecoder();
  const nextSession = await next;
  expect(firstEnd).toHaveBeenCalledTimes(1);
  expect(mockRecorder.start).toHaveBeenCalledTimes(2);
  await nextSession.stop(); await tick();
});

test("the detector runs once per 0.3 s window, while every buffer still reaches Whisper", async () => {
  const session = await startWhisperDictation(jest.fn(), jest.fn(), jest.fn());
  for (let i = 0; i < 6; i++) audio(1600);
  expect(mockModel.streamInsert).toHaveBeenCalledTimes(6);
  expect(mockVad.detectVoiceOnStream).toHaveBeenCalledTimes(2);
  expect(mockVad.detectVoiceOnStream.mock.calls[0][0]).toHaveLength(VAD_WINDOW_SAMPLES);
  await session.stop(); await tick();
});

test("a decoder that never ends after stop does not block the next dictation forever", async () => {
  const { createWhisperSpeechToText } = require("react-native-executorch");
  const aborter = new AbortController();
  await startWhisperDictation(jest.fn(), jest.fn(), jest.fn(), { signal: aborter.signal });
  const loads = createWhisperSpeechToText.mock.calls.length;
  mockFinish = new Promise<void>(() => {}); // the native stream hangs
  aborter.abort(); await tick();
  const next = startWhisperDictation(jest.fn(), jest.fn(), jest.fn());
  await tick();
  expect(mockRecorder.start).toHaveBeenCalledTimes(1);
  mockClosed = false; mockFinish = null;
  jest.advanceTimersByTime(DRAIN_TIMEOUT_MS); await tick();
  const session = await next;
  expect(mockModel.dispose).toHaveBeenCalled();
  expect(createWhisperSpeechToText.mock.calls.length).toBe(loads + 1);
  expect(mockRecorder.start).toHaveBeenCalledTimes(2);
  await session.stop(); await tick();
});

test("a live dictation is never released by the drain timeout", async () => {
  const session = await startWhisperDictation(jest.fn(), jest.fn(), jest.fn());
  jest.advanceTimersByTime(DRAIN_TIMEOUT_MS * 3);
  expect(mockModel.dispose).not.toHaveBeenCalled();
  await session.stop(); await tick();
});

test("Whisper reuses the granted recording permission without reopening a native dialog", async () => {
 const session = await startWhisperDictation(jest.fn(), jest.fn(), jest.fn());
 const { AudioManager } = require("react-native-audio-api");
 expect(AudioManager.checkRecordingPermissions).toHaveBeenCalled();
 expect(AudioManager.requestRecordingPermissions).not.toHaveBeenCalled();
 await session.stop();
});
