import type { ImportFile } from "./kinds";
import type { ExtractionSegmentInput } from "../local-memory/extractions";

export type FileRecognition = {
  index: number;
  name: string;
  status: "success" | "error";
  text?: string;
  /** Source-provided audio intervals only; absent for local Whisper. */
  segments?: ExtractionSegmentInput[];
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
