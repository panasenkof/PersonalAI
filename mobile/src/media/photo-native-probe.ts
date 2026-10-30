/**
 * №83.1 opt-in Android experiment. NOT a production search provider.
 * No upload, no auto-download, no SQLCipher writes or user-visible result.
 */
import { Platform } from "react-native";
import { localMemorySessionUnlocked } from "../local-memory/storage";

export type PhotoProbeRequest = {
  /** App-private files/persai-vision-models/<name>, never an arbitrary URI. */
  modelName: string;
  /** SHA-256 of exactly the local .litertlm bytes. */
  modelSha256: string;
  /** App-private cache/persai-vision-probe/<name>, not a gallery/content URI. */
  imageName: string;
  /** Test query, not transmitted to any network service. */
  query: string;
};

export type PhotoProbeResult = {
  cosine: number;
  elapsedMs: number;
  model: string;
};

type NativeProbe = {
  isSupported(): boolean;
  scoreTextAgainstImage(modelName: string, sha: string, imageName: string, query: string): Promise<PhotoProbeResult>;
};

/** No native code is loaded during regular application boot. */
export async function runPhotoProbe83(request: PhotoProbeRequest): Promise<PhotoProbeResult> {
  if (Platform.OS !== "android") throw new Error("vision_android_only");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.litertlm$/.test(request.modelName) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.(jpg|jpeg|png|webp)$/i.test(request.imageName) ||
      !/^[a-f0-9]{64}$/.test(request.modelSha256) ||
      !request.query.trim() || request.query.length > 256)
    throw new Error("invalid_vision_probe_input");
  const { requireOptionalNativeModule } =
    require("expo-modules-core") as typeof import("expo-modules-core");
  const native = requireOptionalNativeModule<NativeProbe>("PersaiVisionProbe");
  if (!native?.isSupported()) throw new Error("vision_native_unavailable");
  const result = await native.scoreTextAgainstImage(
    request.modelName, request.modelSha256, request.imageName, request.query);
  if (!Number.isFinite(result.cosine) || result.cosine < -1.00001 || result.cosine > 1.00001 ||
      !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0)
    throw new Error("invalid_vision_probe_result");
  return result;
}
