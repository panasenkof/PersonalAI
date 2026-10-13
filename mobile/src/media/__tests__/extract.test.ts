import * as FileSystem from "expo-file-system/legacy";
import * as Thumbnails from "expo-video-thumbnails";
import { extractMedia } from "../extract";
import { defaultDirectPreferences } from "../../direct-agent/settings";
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(), deleteAsync: jest.fn(), EncodingType: { Base64: "base64" } }));
jest.mock("expo-video-thumbnails", () => ({ getThumbnailAsync: jest.fn() }));
jest.mock("expo-video", () => ({ createVideoPlayer: jest.fn() }));
const settings = { ...defaultDirectPreferences, apiKey: "secret", webSearchKey: "" };
beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 1000 });
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("dGVzdA==");
  (Thumbnails.getThumbnailAsync as jest.Mock).mockImplementation(async (_uri, { time }) => ({ uri: "file:///cache/frame-" + time + ".jpg" }));
});
test("unapproved images, audio and video never reach a provider", async () => {
  const transport = jest.fn();
  for (const [name, mimeType] of [["image.png", "image/png"], ["audio.mp3", "audio/mpeg"], ["video.mp4", "video/mp4"]]) {
    await expect(extractMedia({ uri: "file:///cache/" + name, name, mimeType }, settings, false, undefined, transport as unknown as typeof fetch)).rejects.toThrow("Разрешите");
  }
  expect(transport).not.toHaveBeenCalled(); expect(Thumbnails.getThumbnailAsync).not.toHaveBeenCalled();
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
  expect((Thumbnails.getThumbnailAsync as jest.Mock).mock.calls.map(c => c[1].time)).toEqual([2000, 25000, 50000, 75000, 97000]);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(5);
});
test("provider errors cannot expose an echoed key and cancellation prevents egress", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 401, text: async () => "secret" }));
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, undefined, transport as unknown as typeof fetch)).rejects.not.toThrow("secret");
  const aborter = new AbortController(); aborter.abort(); transport.mockClear();
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, aborter.signal, transport as unknown as typeof fetch)).rejects.toThrow("остановлен");
  expect(transport).not.toHaveBeenCalled();
});
