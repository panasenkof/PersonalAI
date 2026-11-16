/** Android system exit history. No automatic transfer or persistence.
 * Diagnostic traces can contain private information: share only on explicit tap.
 */
import { requireOptionalNativeModule } from "expo-modules-core";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

export type AndroidCrash = {
  timestamp: number;
  reason: "native" | "java" | "anr";
  status: number;
  importance: number;
  description: string;
};
type NativeCrash = {
  recentCrashes(limit: number): unknown;
  getCrashReport(timestamp: number): unknown;
};

function bridge(): NativeCrash | null {
  return Platform.OS === "android"
    ? requireOptionalNativeModule<NativeCrash>("PersaiCrashDiagnostics")
    : null;
}
export function systemCrashDiagnosticsAvailable(): boolean { return bridge() !== null; }

export function validateAndroidCrash(value: unknown): AndroidCrash | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AndroidCrash>;
  if (!Number.isSafeInteger(row.timestamp) || (row.timestamp as number) < 0 ||
      !["native", "java", "anr"].includes(String(row.reason)) ||
      !Number.isInteger(row.status) || !Number.isInteger(row.importance) ||
      typeof row.description !== "string") return null;
  return { timestamp: row.timestamp as number, reason: row.reason as AndroidCrash["reason"],
    status: row.status as number, importance: row.importance as number,
    description: row.description.slice(0, 500) };
}

export function recentAndroidCrashes(): AndroidCrash[] {
  const native = bridge();
  if (!native) return [];
  const received = native.recentCrashes(10);
  if (!Array.isArray(received)) throw new Error("invalid_android_crash_list");
  return received.map(validateAndroidCrash).filter((row): row is AndroidCrash => row !== null);
}

export async function shareAndroidCrashReport(crash: AndroidCrash, buildSha?: string): Promise<void> {
  const checked = validateAndroidCrash(crash);
  if (!checked) throw new Error("invalid_android_crash");
  const native = bridge();
  if (!native) throw new Error("system_crash_diagnostics_unavailable");
  if (!await Sharing.isAvailableAsync()) throw new Error("share_unavailable");
  const report = native.getCrashReport(checked.timestamp);
  if (!report || typeof report !== "object" ||
      (report as { timestamp?: unknown }).timestamp !== checked.timestamp) {
    throw new Error("invalid_system_crash_report");
  }
  // Keep native tombstone protobuf and Java-uncaught UTF-8 fallback as opaque
  // Base64. The native report identifies the source and format; never assume
  // Android provides Java stacks via ApplicationExitInfo.traceInputStream.
  const raw = report as Record<string, unknown>;
  if (typeof raw.traceBase64 !== "string" || raw.traceBase64.length > 350000) {
    throw new Error("invalid_system_crash_trace");
  }
  const dest = new Directory(Paths.cache, "persai-crash-share");
  dest.create({ idempotent: true, intermediates: true });
  const file = new File(dest, "persai-android-crash-" + checked.timestamp + ".json");
  try {
    if (!file.exists) file.create({ intermediates: true });
    await file.write(JSON.stringify({
      ...raw, app: "PersAI", buildSha: typeof buildSha === "string" ? buildSha.slice(0, 40) : undefined,
      exportedAt: new Date().toISOString(), source: "ApplicationExitInfo",
    }, null, 2));
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json", dialogTitle: "Передать отчёт об аварии PersAI",
    });
  } finally {
    if (file.exists) file.delete();
  }
}
