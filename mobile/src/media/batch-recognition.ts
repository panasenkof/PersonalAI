import type { ImportFile } from "./kinds";
import type { ImageExtractionMode } from "./extract";
import type { ExtractionSegmentInput } from "../local-memory/extractions";
import type { PdfPageCoverage } from "./pdf-pages";

export type FileRecognition = {
  index: number;
  name: string;
  status: "success" | "error";
  text?: string;
  /** Explicit verified ASR producer; never inferred from absent time intervals. */
  asrProducerId?: string;
  /** Source-provided audio intervals only; absent for local Whisper. */
  segments?: ExtractionSegmentInput[];
  /** Native-reported page count, never inferred from flattened text. */
  pdfCoverage?: PdfPageCoverage;
  /** Explicit image intent, not evidence that the provider read every character. */
  imageMode?: ImageExtractionMode;
  error?: string;
};

/** Files are processed in selection order, never concurrently. One failure
 * does not discard earlier successful recognition; abort stops the entire batch. */
export async function recognizeFilesSequentially(
  files: ImportFile[],
  recognize: (file: ImportFile, index: number, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
  onProgress?: (done: FileRecognition[], current: number) => void,
): Promise<FileRecognition[]> {
  const results: FileRecognition[] = [];
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new Error("Распознавание остановлено.");
    onProgress?.([...results], i);
    try {
      const text = await recognize(files[i], i, signal);
      if (signal?.aborted) throw new Error("Распознавание остановлено.");
      if (!text.trim()) throw new Error("Не удалось получить текст.");
      results.push({ index: i, name: files[i].name, status: "success", text: text.trim() });
    } catch (e) {
      if (signal?.aborted) throw new Error("Распознавание остановлено.");
      results.push({ index: i, name: files[i].name, status: "error", error: e instanceof Error ? e.message : "Ошибка распознавания" });
    }
    onProgress?.([...results], i + 1);
  }
  return results;
}

/** A single searchable note, with a clear source header for every successful
 * file when multiple originals were supplied. Failed recognitions are UI state,
 * never represented as factual extracted content. */
export function combinedRecognitionText(results: FileRecognition[], total: number): string {
  const blocks = results.filter(r => r.status === "success" && r.text)
    .map(r => total === 1 ? r.text! : "Файл " + (r.index + 1) + ": " + r.name + "\n" + r.text!);
  const combined = blocks.join("\n\n");
  if (combined.length > 60_000) throw new Error("Общий распознанный текст превышает 60 000 символов. Обработайте меньше файлов или сократите текст.");
  return combined;
}

// Imported notes have one editable text field. Replace only a uniquely located
// file block. If its boundaries were edited, preserve the draft and original.
export function replaceFileText(current: string, names: string[], index: number, replacement: string): string {
  if (names.length <= 1) return replacement;
  const headers = names.map((name, i) => "Файл " + (i + 1) + ": " + name + "\n");
  const header = headers[index];
  if (!header) throw new Error("Не удалось определить исходный файл.");
  const position = current.indexOf(header);
  if (position < 0 || position !== current.lastIndexOf(header) ||
      (position > 0 && !current.slice(0, position).endsWith("\n\n")))
    throw new Error("Заголовки файлов изменились. Текущий текст сохранён.");
  const start = position + header.length;
  // A missing or edited following header could make a neighbour look like
  // part of this file. Refuse automatic replacement in that case.
  let end = current.length;
  if (index + 1 < names.length) {
    const next = "\n\n" + headers[index + 1];
    end = current.indexOf(next, start);
    if (end < 0 || end !== current.lastIndexOf(next))
      throw new Error("Не удалось отделить соседний файл. Текущий текст сохранён.");
  }
  const analysis = current.indexOf("\n\nСовместный анализ материалов:\n", start);
  if (analysis >= 0) end = Math.min(end, analysis);
  const updated = current.slice(0, start) + replacement + current.slice(end);
  if (updated.length > 60_000) throw new Error("Результат превышает 60 000 символов.");
  return updated;
}
