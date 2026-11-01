import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as FileSystem from "expo-file-system/legacy";

type NativePage = { uri: string; page: number; pageCount: number };
type NativeReader = {
  isPagePreviewAvailable?: () => boolean;
  renderPage: (sourceUri: string, page: number, maxWidth: number) => Promise<unknown>;
};

const MAX_PAGES = 128;
const RENDER_WIDTH = 1200;
/** Only cleanup our own cache files, never an arbitrary source pathname. */
function isTemporaryPdfPage(uri: string): boolean {
  return /^file:\/\/\/[^?#]*\/persai-pdf-page-previews\/page-[a-zA-Z0-9_-]+\.jpg$/.test(uri);
}
export async function deletePdfPagePreview(uri: string): Promise<void> {
  if (!isTemporaryPdfPage(uri)) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/** One real PDF page as a temporary bitmap; no OCR, no cloud, no text evidence. */
export async function renderPdfPage(
  sourceUri: string, page: number, signal?: AbortSignal, nativeReader?: NativeReader,
): Promise<NativePage> {
  if (!sourceUri.startsWith("file://")) throw new Error("Для просмотра нужен локально сохранённый PDF.");
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES)
    throw new Error("Недопустимый номер страницы PDF.");
  if (signal?.aborted) throw new Error("Просмотр PDF остановлен.");
  if (!nativeReader && Platform.OS !== "android")
    throw new Error("Локальный просмотр страниц PDF пока доступен только на Android 15+.");
  const reader = nativeReader || requireOptionalNativeModule<NativeReader>("PersaiPdfText");
  if (!reader || (reader.isPagePreviewAvailable && !reader.isPagePreviewAvailable()))
    throw new Error("На этом устройстве просмотр страниц PDF недоступен. Оригинал сохранён.");
  let response: unknown;
  try {
    response = await reader.renderPage(sourceUri, page, RENDER_WIDTH);
  } catch {
    if (signal?.aborted) throw new Error("Просмотр PDF остановлен.");
    throw new Error("Не удалось открыть страницу PDF: файл защищён, повреждён или недоступен.");
  }
  const result = response as Partial<NativePage> | null;
  if (signal?.aborted) {
    if (result && typeof result.uri === "string") await deletePdfPagePreview(result.uri);
    throw new Error("Просмотр PDF остановлен.");
  }
  if (!result || !Number.isSafeInteger(result.pageCount) ||
      result.pageCount! < 1 || result.pageCount! > MAX_PAGES ||
      result.page !== page || page > result.pageCount! ||
      typeof result.uri !== "string" || !isTemporaryPdfPage(result.uri)) {
    if (result && typeof result.uri === "string") await deletePdfPagePreview(result.uri);
    throw new Error("Системный просмотр PDF вернул некорректную страницу.");
  }
  return result as NativePage;
}
