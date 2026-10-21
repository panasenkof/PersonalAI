import * as FileSystem from "expo-file-system/legacy";
import { createVideoPlayer } from "expo-video";
import { ImageManipulator } from "expo-image-manipulator";
import { extractMedia } from "../extract";
import { getWhisperStatus, transcribeAudioFile } from "../whisper";
import { defaultDirectPreferences } from "../../direct-agent/settings";
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(), deleteAsync: jest.fn(), EncodingType: { Base64: "base64" } }));
jest.mock("expo-video", () => ({ createVideoPlayer: jest.fn() }));
jest.mock("../video-audio", () => ({ videoAudio: jest.fn(async () => { throw new Error("Нет звуковой дорожки"); }) }));
jest.mock("../whisper", () => ({ getWhisperStatus: jest.fn(() => ({ state: "absent" })), transcribeAudioFile: jest.fn() }));
jest.mock("expo-image-manipulator", () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: "jpeg" } }));
const mockPlayer = { muted: false, release: jest.fn(), generateThumbnailsAsync: jest.fn(), replaceAsync: jest.fn(),
  listeners: {} as Record<string, (e: any) => void>,
  addListener(name: string, fn: (e: any) => void) { this.listeners[name] = fn; return { remove() {} }; } };
const settings = { ...defaultDirectPreferences, apiKey: "secret", webSearchKey: "" };
beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 1000 });
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("dGVzdA==");
  (createVideoPlayer as jest.Mock).mockReturnValue(mockPlayer);
  mockPlayer.replaceAsync.mockImplementation(async () => { mockPlayer.listeners.sourceLoad({ duration: 100 }); });
  mockPlayer.generateThumbnailsAsync.mockImplementation(async (times: number[]) => times.map(t => ({ requestedTime: t })));
  (ImageManipulator.manipulate as jest.Mock).mockImplementation((thumb: { requestedTime: number }) => ({
    renderAsync: async () => ({ saveAsync: async () => ({ uri: "file:///cache/frame-" + thumb.requestedTime + ".jpg", base64: "ZnJhbWU=" }) }) }));
});
test("unapproved images, audio and video never reach a provider", async () => {
  const transport = jest.fn();
  for (const [name, mimeType] of [["image.png", "image/png"], ["audio.mp3", "audio/mpeg"], ["video.mp4", "video/mp4"]]) {
    await expect(extractMedia({ uri: "file:///cache/" + name, name, mimeType }, settings, false, undefined, transport as unknown as typeof fetch)).rejects.toThrow("Разрешите");
  }
  expect(transport).not.toHaveBeenCalled(); expect(createVideoPlayer).not.toHaveBeenCalled();
});
test("text imports stay on-device and reject truncation", async () => {
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("Мой рецепт"); const transport = jest.fn();
  expect(await extractMedia({ uri: "file:///cache/note.txt", name: "note.txt" }, settings, false, undefined, transport as unknown as typeof fetch)).toBe("Мой рецепт");
  expect(transport).not.toHaveBeenCalled();
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("a".repeat(60_001));
  await expect(extractMedia({ uri: "file:///cache/note.txt", name: "note.txt" }, settings, false, undefined, transport as unknown as typeof fetch)).rejects.toThrow("Разделите");
});
test("images use the chosen vision protocol with no conversation store", async () => {
  const transport = jest.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ output_text: "Распознанный рецепт" }) }));
  const text = await extractMedia({ uri: "file:///cache/photo.png", name: "photo.png", mimeType: "image/png" }, settings, true, undefined, transport as unknown as typeof fetch);
  expect(text).toBe("Распознанный рецепт");
  const payload = JSON.parse(transport.mock.calls[0][1].body);
  expect(payload.store).toBe(false); expect(payload.input[0].content[1].image_url).toContain("data:image/png;base64,");
});
test("video samples across its duration and removes every extracted frame after failure", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 400 }));
  await expect(extractMedia({ uri: "file:///cache/video.mp4", name: "video.mp4", duration: 100_000 }, settings, true, undefined, transport as unknown as typeof fetch)).rejects.toThrow("HTTP 400");
  expect(mockPlayer.generateThumbnailsAsync.mock.calls[0][0]).toEqual([2, 25, 50, 75, 97]);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(5);
  expect(mockPlayer.release).toHaveBeenCalledTimes(2);
});
test("provider errors cannot expose an echoed key and cancellation prevents egress", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 401, text: async () => "secret" }));
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, undefined, transport as unknown as typeof fetch)).rejects.not.toThrow("secret");
  const aborter = new AbortController(); aborter.abort(); transport.mockClear();
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, aborter.signal, transport as unknown as typeof fetch)).rejects.toThrow("остановлен");
  expect(transport).not.toHaveBeenCalled();
});

test("with Whisper downloaded, audio is transcribed on the phone without approval and nothing is sent", async () => {
  (getWhisperStatus as jest.Mock).mockReturnValueOnce({ state: "ready", id: "base" });
  (transcribeAudioFile as jest.Mock).mockResolvedValueOnce("Купить молоко");
  const transport = jest.fn();
  expect(await extractMedia({ uri: "file:///cache/voice.m4a", name: "voice.m4a", mimeType: "audio/mp4" }, settings, false, undefined, transport as unknown as typeof fetch)).toBe("Купить молоко");
  expect(transport).not.toHaveBeenCalled();
});
test("without Whisper a service that cannot transcribe points to the on-device model", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 404 }));
  await expect(extractMedia({ uri: "file:///cache/voice.m4a", name: "voice.m4a" }, { ...settings, provider: "openai-compatible", baseUrl: "https://api.deepseek.com" }, true, undefined, transport as unknown as typeof fetch))
    .rejects.toThrow("Голос без интернета");
});

test("video retains visual result when audio fails and labels missing speech", async () => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => ({ output_text: "На кадре рецепт" }) }));
  const text = await extractMedia({ uri: "file:///clip.mp4", name: "clip.mp4" }, settings, true, undefined, transport as unknown as typeof fetch);
  expect(text).toContain("Речь не распознана"); expect(text).toContain("На кадре рецепт");
  expect(text).toContain("выборочных кадров");
});
