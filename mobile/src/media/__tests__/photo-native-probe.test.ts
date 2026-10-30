import { runPhotoProbe83 } from "../photo-native-probe";
import { localMemorySessionUnlocked } from "../../local-memory/storage";

jest.mock("react-native", () => ({ Platform: { OS: "android" } }));
jest.mock("../../local-memory/storage", () => ({ localMemorySessionUnlocked: jest.fn() }));
// Keep Expo's own requireNativeModule for its test runtime/fetch polyfill.
jest.mock("expo-modules-core", () => ({
  ...jest.requireActual("expo-modules-core"),
  requireOptionalNativeModule: jest.fn(),
}));

const { requireOptionalNativeModule } = require("expo-modules-core") as {
  requireOptionalNativeModule: jest.Mock;
};
const unlocked = localMemorySessionUnlocked as jest.Mock;
const input = { modelName: "vision.litertlm", modelSha256: "a".repeat(64),
  imageName: "fixture.jpg", query: "красный велосипед" };

beforeEach(() => {
  jest.clearAllMocks();
  unlocked.mockReturnValue(true);
});

test("83.1: not having the native module leaves existing memory untouched", async () => {
  requireOptionalNativeModule.mockReturnValue(null);
  await expect(runPhotoProbe83(input)).rejects.toThrow("vision_native_unavailable");
});

test("83.1: AppLock and unsupported files reject BEFORE native call", async () => {
  unlocked.mockReturnValue(false);
  await expect(runPhotoProbe83(input)).rejects.toThrow("application_locked");
  expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  unlocked.mockReturnValue(true);
  await expect(runPhotoProbe83({ ...input, imageName: "../private.jpg" }))
    .rejects.toThrow("invalid_vision_probe_input");
  await expect(runPhotoProbe83({ ...input, modelName: "../weights.litertlm" }))
    .rejects.toThrow("invalid_vision_probe_input");
  await expect(runPhotoProbe83({ ...input, modelSha256: "unknown" }))
    .rejects.toThrow("invalid_vision_probe_input");
  expect(requireOptionalNativeModule).not.toHaveBeenCalled();
});

test("83.1: only validated score metadata returns; no image bytes or vectors in JS", async () => {
  const scoreTextAgainstImage = jest.fn(async () =>
    ({ cosine: 0.42, elapsedMs: 920, model: "embeddinggemma2-text-vision-spike" }));
  requireOptionalNativeModule.mockReturnValue({ isSupported: () => true, scoreTextAgainstImage });
  const result = await runPhotoProbe83(input);
  expect(result).toEqual({ cosine: 0.42, elapsedMs: 920, model: "embeddinggemma2-text-vision-spike" });
  expect(scoreTextAgainstImage).toHaveBeenCalledWith(
    "vision.litertlm", "a".repeat(64), "fixture.jpg", "красный велосипед");
  expect(Object.keys(result).sort()).toEqual(["cosine", "elapsedMs", "model"]);
});

test("83.1: native invalid confidence/clock data is not accepted as a search proof", async () => {
  requireOptionalNativeModule.mockReturnValue({ isSupported: () => true,
    scoreTextAgainstImage: async () => ({ cosine: Number.NaN, elapsedMs: -1, model: "fake" }) });
  await expect(runPhotoProbe83(input)).rejects.toThrow("invalid_vision_probe_result");
});
