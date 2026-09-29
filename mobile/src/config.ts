import Constants from "expo-constants";

/** EXPO_PUBLIC_API_BASE wins, then app.json extra.apiBase. */
export const DEFAULT_API_BASE: string =
  process.env.EXPO_PUBLIC_API_BASE ||
  ((Constants.expoConfig?.extra as { apiBase?: string } | undefined)?.apiBase ?? "http://localhost:8000");
