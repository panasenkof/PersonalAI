import * as SecureStore from "expo-secure-store";

/** UI-only choice, scoped to the active profile. Never stores note contents. */
export type MemoryLibraryView = "grid" | "list";
const key = (profile: string) => "persai.memory-library-view.v1." + profile;

export async function loadMemoryLibraryView(profile: string): Promise<MemoryLibraryView | null> {
  if (!profile) return null;
  const value = await SecureStore.getItemAsync(key(profile));
  return value === "grid" || value === "list" ? value : null;
}

export async function saveMemoryLibraryView(profile: string, view: MemoryLibraryView): Promise<void> {
  if (!profile || (view !== "grid" && view !== "list")) throw new Error("memory_view_preference_invalid");
  await SecureStore.setItemAsync(key(profile), view);
}
