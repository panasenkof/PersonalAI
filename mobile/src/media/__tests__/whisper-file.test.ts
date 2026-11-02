import * as SecureStore from "expo-secure-store";
import { decodeAudioData } from "react-native-audio-api";
import { transcribeAudioFile } from "../whisper";
import { MAX_WHISPER_FILE_SECONDS, WHISPER_RATE } from "../whisper-core";

const mockTranscribe = jest.fn<Promise<string>, [Float32Array, { language: string }]>();
const mockStop = jest.fn();
const mockModel = { transcribe: mockTranscribe, transcribeStop: mockStop, dispose: jest.fn() };

jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn() }));
jest.mock("react-native-executorch", () => ({
  createWhisperSpeechToText: jest.fn(async () => mockModel),
  setTelemetryEnabled: jest.fn(),
}));
jest.mock("react-native-audio-api", () => ({ decodeAudioData: jest.fn() }));

const audio = (seconds: number) => {
  const samples = new Float32Array(seconds * WHISPER_RATE);
  (decodeAudioData as jest.Mock).mockResolvedValue({
    sampleRate: WHISPER_RATE, length: samples.length, numberOfChannels: 1,
    getChannelData: (_channel: number) => samples,
  });
};
beforeEach(() => {
  jest.clearAllMocks();
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(JSON.stringify({
    id: "base", resolved: { modelPath: "/existing-model", tokenizerPath: "/tokenizer" },
  }));
  audio(52);
  mockTranscribe.mockResolvedValue("Речь");
});

test("F2a: a 52-second local recording reaches the model as 25+25+2 seconds, in order", async () => {
  mockTranscribe.mockResolvedValueOnce("Начало").mockResolvedValueOnce("Середина").mockResolvedValueOnce("Конец");
  const text = await transcribeAudioFile("file:///private/long.m4a");
  expect(text).toBe("Начало\n\nСередина\n\nКонец");
  expect(mockTranscribe).toHaveBeenCalledTimes(3);
  expect(mockTranscribe.mock.calls.map(call => call[0].length)).toEqual([
    25 * WHISPER_RATE, 25 * WHISPER_RATE, 2 * WHISPER_RATE,
  ]);
  expect(mockTranscribe.mock.calls.every(call => call[1].language === "ru")).toBe(true);
});

test("F2a: a silent part is not filled with invented words", async () => {
  mockTranscribe.mockResolvedValueOnce("Первое").mockResolvedValueOnce("").mockResolvedValueOnce("Последнее");
  expect(await transcribeAudioFile("file:///private/long.m4a")).toBe("Первое\n\nПоследнее");
});

test("F2a: mid-recording inference failure rejects the entire result, never saves partial as complete", async () => {
  mockTranscribe.mockResolvedValueOnce("Успешно").mockRejectedValueOnce(new Error("decoder failed"));
  await expect(transcribeAudioFile("file:///private/long.m4a")).rejects.toThrow("часть 2 из 3");
  expect(mockTranscribe).toHaveBeenCalledTimes(2);
});

test("F2a: cancellation between windows stops native work and does not return a partial transcript", async () => {
  const controller = new AbortController();
  mockTranscribe.mockImplementationOnce(async () => { controller.abort(); return "Начало"; });
  await expect(transcribeAudioFile("file:///private/long.m4a", controller.signal)).rejects.toThrow("остановлен");
  expect(mockStop).toHaveBeenCalledTimes(1);
  expect(mockTranscribe).toHaveBeenCalledTimes(1);
});

test("F2a: unsupported duration is rejected before allocating or transcribing a full buffer", async () => {
  const getChannelData = jest.fn();
  (decodeAudioData as jest.Mock).mockResolvedValue({
    sampleRate: WHISPER_RATE,
    length: (MAX_WHISPER_FILE_SECONDS + 1) * WHISPER_RATE,
    numberOfChannels: 1, getChannelData,
  });
  await expect(transcribeAudioFile("file:///private/too-long.mp3")).rejects.toThrow("20 минут");
  expect(mockTranscribe).not.toHaveBeenCalled();
  expect(getChannelData).not.toHaveBeenCalled();
});
