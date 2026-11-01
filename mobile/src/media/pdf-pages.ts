import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ExtractionSegmentInput } from "../local-memory/extractions";
import type { ImportFile } from "./kinds";

type Page = { page: number; text: string };
type NativeDocument = { pages: Page[]; pageCount: number };
type NativePdf = { extractPages: (uri: string, limit: number) => Promise<unknown>; isAvailable?: () => boolean };
export type PdfPageCoverage = {
  /** Null for older readers; absence never counts as full PDF coverage. */
  totalPageCount: number | null;
  extractedPageCount: number;
  missingPages: number[];
  coverage: "partial";
};
export type PdfTextPages = PdfPageCoverage & {
  text: string;
  segments: ExtractionSegmentInput[];
};

const PAGE_LIMIT = 128;
const MAX_CHARS = 60_000;
const MAX_SEGMENTS = 128;

/** Android/native page indices are 0-based, all JS and SQLCipher evidence is 1-based.
 * Legacy native array responses remain valid, but have UNKNOWN total page count.
 * The new native contract contains total pageCount, including image-only pages.
 */
export function validateNativePdfPages(value: unknown): PdfTextPages {
  const structured = !Array.isArray(value);
  const doc = structured && value && typeof value === "object" ? value as Partial<NativeDocument> : null;
  const raw = structured ? doc?.pages : value;
  const totalPages = structured ? doc?.pageCount : null;
  if (structured && (!Number.isSafeInteger(totalPages) || (totalPages as number) < 1 ||
      (totalPages as number) > PAGE_LIMIT)) throw new Error("invalid_pdf_page_count");
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PAGE_LIMIT) {
    throw new Error("pdf_no_text_layer_or_page_limit");
  }
  const pages = raw as Page[], segments: ExtractionSegmentInput[] = [], parts: string[] = [];
  const seen = new Set<number>();
  let previous = 0, total = 0;
  for (const row of pages) {
    if (!row || !Number.isSafeInteger(row.page) || row.page < 1 ||
        row.page <= previous || row.page > PAGE_LIMIT ||
        (totalPages != null && row.page > totalPages) || seen.has(row.page) ||
        typeof row.text !== "string" || !row.text.trim()) throw new Error("invalid_pdf_page_evidence");
    previous = row.page; seen.add(row.page);
    const t = row.text.trim();
    total += t.length;
    if (total > MAX_CHARS) throw new Error("pdf_text_limit_exceeded");
    // Split by code points to avoid corrupting emoji/surrogate pairs in saved evidence.
    const characters = Array.from(t);
    for (let pos = 0; pos < characters.length; pos += 3000) {
      const text = characters.slice(pos, pos + 3000).join("");
      segments.push({ text, location: { kind: "page", page: row.page } });
      if (segments.length > MAX_SEGMENTS) throw new Error("pdf_segment_limit_exceeded");
    }
    parts.push("Страница " + row.page + ":\n" + t);
  }
  const text = parts.join("\n\n");
  if (text.length > MAX_CHARS) throw new Error("pdf_text_limit_exceeded");
  const missingPages: number[] = [];
  if (totalPages != null) {
    for (let p = 1; p <= totalPages; p++) if (!seen.has(p)) missingPages.push(p);
  }
  return { text, segments, coverage: "partial", totalPageCount: totalPages ?? null,
    extractedPageCount: pages.length, missingPages };
}

/** Bound OS errors are translated into fixed UI text. Never display a native
 * exception that might include the original's cache path or sensitive contents.
 */
export function pdfImportError(error: unknown): string {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (diagnostic.includes("pdf_password_or_permission_required"))
    return "PDF защищён паролем или доступ к нему ограничен. Сохраните оригинал без извлечения текста.";
  if (diagnostic.includes("pdf_corrupt_or_unreadable"))
    return "PDF повреждён или его формат не удалось прочитать. Оригинал можно сохранить.";
  if (diagnostic.includes("pdf_page_limit_exceeded"))
    return "В PDF больше 128 страниц. Разделите документ или сохраните оригинал без разбора.";
  if (diagnostic.includes("pdf_text_limit_exceeded") || diagnostic.includes("pdf_segment_limit_exceeded"))
    return "Текст PDF превышает ограничение 60 000 символов или 128 сегментов. Разделите документ; ничего не обрезано незаметно.";
  if (diagnostic.includes("pdf_file_unavailable_or_too_large"))
    return "PDF недоступен или превышает 80 МБ. Выберите файл повторно.";
  if (diagnostic.includes("pdf_no_text_layer"))
    return "В PDF не найден текстовый слой (возможно, это скан). Оригинал можно сохранить без распознавания; OCR запланирован отдельно.";
  if (diagnostic.includes("invalid_pdf_page") || diagnostic.includes("invalid_pdf_page_count"))
    return "Система вернула некорректные номера страниц PDF. Извлечение отклонено; оригинал можно сохранить.";
  return "Не удалось прочитать PDF системным средством. Возможно, файл повреждён или не поддерживается. Оригинал можно сохранить.";
}

/** Local digital PDF text layer only. No OCR, no network, no hidden upload.
 * Android 15+ or Android 12-14 with S Extension 13+.
 */
export async function extractPdfPages(
  file: ImportFile, signal?: AbortSignal,
  nativeReader?: NativePdf,
): Promise<PdfTextPages> {
  if (!/\.pdf$/i.test(file.name) && file.mimeType !== "application/pdf") throw new Error("not_pdf_file");
  if (!file.uri.startsWith("file://")) throw new Error("pdf_copy_to_app_cache_required");
  if (signal?.aborted) throw new Error("Разбор файла остановлен");
  if (!nativeReader && Platform.OS !== "android")
    throw new Error("Чтение страниц PDF пока доступно только на поддерживаемых Android. Оригинал можно сохранить без распознавания.");
  const reader = nativeReader || requireOptionalNativeModule<NativePdf>("PersaiPdfText");
  if (!reader) throw new Error("Чтение страниц PDF недоступно в этой сборке. Сохраните оригинал или обновите приложение.");
  if (reader.isAvailable ? !reader.isAvailable() : !nativeReader && Number(Platform.Version) < 35)
    throw new Error("На этом устройстве нет системного извлечения текста PDF (Android 15+ или расширение Android 12–14 S v13). Оригинал можно сохранить.");
  try {
    const result = await reader.extractPages(file.uri, PAGE_LIMIT);
    if (signal?.aborted) throw new Error("Разбор файла остановлен");
    return validateNativePdfPages(result);
  } catch (error) {
    if (signal?.aborted) throw new Error("Разбор файла остановлен");
    throw new Error(pdfImportError(error));
  }
}
