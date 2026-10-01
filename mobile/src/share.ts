import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { fromByteArray } from "base64-js";

/** Keep exported private data only until the system share sheet closes. */
export async function sharePrivateFile(name: string, bytes: Uint8Array | string, mimeType: string): Promise<void> {
  if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error("Сохранение файлов недоступно на этом устройстве. Используйте экспорт в веб-версии.");
  const path = `${FileSystem.cacheDirectory}${Date.now()}-${name}`;
  try {
    await FileSystem.writeAsStringAsync(path, typeof bytes === "string" ? bytes : fromByteArray(bytes), { encoding: typeof bytes === "string" ? FileSystem.EncodingType.UTF8 : FileSystem.EncodingType.Base64 });
    await Sharing.shareAsync(path, { mimeType, dialogTitle: "Сохранить файл PIA Agent" });
  } finally { await FileSystem.deleteAsync(path, { idempotent: true }); }
}
