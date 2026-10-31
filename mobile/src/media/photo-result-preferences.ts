import * as SecureStore from "expo-secure-store";

/** User-controlled number of ranked matches, not a similarity threshold. */
export const PHOTO_RESULT_COUNTS = [1, 3, 6, 10, 20] as const;
export type PhotoResultCount = typeof PHOTO_RESULT_COUNTS[number];
export const DEFAULT_PHOTO_RESULT_COUNT: PhotoResultCount = 6;
const key = (profile: string) => "persai.photo-result-count.v1." + profile;

export function validPhotoResultCount(value: unknown): value is PhotoResultCount {
  return typeof value === "number" && PHOTO_RESULT_COUNTS.some(x => x === value);
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
