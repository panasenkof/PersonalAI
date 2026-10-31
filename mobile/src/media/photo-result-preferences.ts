import * as SecureStore from "expo-secure-store";

/** User-controlled number of ranked matches, not a similarity threshold. */
export const MAX_PHOTO_RESULT_COUNT = 20;
export type PhotoResultCount = number;
export const DEFAULT_PHOTO_RESULT_COUNT: PhotoResultCount = 6;
const key = (profile: string) => "persai.photo-result-count.v1." + profile;

export function validPhotoResultCount(value: unknown): value is PhotoResultCount {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PHOTO_RESULT_COUNT;
}
export async function loadPhotoResultCount(profile: string): Promise<PhotoResultCount> {
  const raw = await SecureStore.getItemAsync(key(profile));
  if (!raw) return DEFAULT_PHOTO_RESULT_COUNT;
  try {
    const value: unknown = JSON.parse(raw);
    return validPhotoResultCount(value) ? value : DEFAULT_PHOTO_RESULT_COUNT;
  } catch { return DEFAULT_PHOTO_RESULT_COUNT; }
}
export async function savePhotoResultCount(profile: string, count: PhotoResultCount): Promise<void> {
  if (!validPhotoResultCount(count)) throw new Error("photo_result_count_invalid");
  await SecureStore.setItemAsync(key(profile), JSON.stringify(count));
}
