import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as Blob from "react-native-blob-util";
import { useSyncExternalStore } from "react";
import type { ImportFile } from "./kinds";
import { validateNativePdfPages, type PdfTextPages } from "./pdf-pages";

type NativePdf = {
  isRussianOcrInstalled(): boolean;
  recognizeRussianImage(uri: string): Promise<string>;
  recognizeRussianPdf(uri: string, startPage: number): Promise<unknown>;
};
const native = () => requireOptionalNativeModule<NativePdf>("PersaiPdfText");
const SHA = "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225";
const SIZE = 3_861_738;
const MODEL_URL = "https://huggingface.co/lm-kit/tessdata-fast/resolve/83ff76b97461395f257255720bf7f3957606dbb5/rus.traineddata";
const MODEL_DIR = () => Blob.default.fs.dirs.DocumentDir + "/tessdata";
const MODEL = () => MODEL_DIR() + "/rus.traineddata";
type Status = { checked: boolean; ready: boolean; busy: boolean; percent: number; error: string };
let state: Status = { checked: false, ready: false, busy: false, percent: 0, error: "" };
const listeners = new Set<() => void>();
let transfer: { cancel(): Promise<unknown> | unknown } | null = null;
let counter = 0;
function emit(next: Status) { state = next; for (const listener of listeners) listener(); }
export function getRussianOcrStatus() { return state; }
export function useRussianOcrStatus() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getRussianOcrStatus, getRussianOcrStatus);
}
async function modelExistsAndVerified() {
  if (!(await Blob.default.fs.exists(MODEL()))) return false;
  const info = await Blob.default.fs.stat(MODEL());
  if (Number(info.size) !== SIZE) return false;
  return (await Blob.default.fs.hash(MODEL(), "sha256")).toLowerCase() === SHA;
}
export async function refreshRussianOcrStatus() {
  if (state.busy) return;
  try {
    const reader = Platform.OS === "android" ? native() : null;
    const ready = Boolean(reader && await modelExistsAndVerified() && reader.isRussianOcrInstalled());
    emit({ ...state, checked: true, ready, error: "" });
  } catch {
    emit({ ...state, checked: true, ready: false, error: "Не удалось проверить локальную модель OCR." });
  }
}
export async function installRussianOcr(): Promise<void> {
  if (state.busy) return;
  if (Platform.OS !== "android" || !native()) {
    emit({ ...state, checked: true, ready: false, error: "Локальное OCR недоступно в этой версии приложения." });
    return;
  }
  const id = ++counter;
  emit({ ...state, busy: true, percent: 0, error: "" });
  let temporary = "";
  try {
    if (!(await Blob.default.fs.exists(MODEL_DIR()))) await Blob.default.fs.mkdir(MODEL_DIR());
    temporary = MODEL_DIR() + "/rus." + id + ".partial";
    const responseTask = Blob.default.config({ path: temporary, overwrite: true }).fetch("GET", MODEL_URL);
    transfer = responseTask;
    const response = await responseTask.progress({ interval: 300 }, (received: number) => {
      if (counter === id) emit({ ...state, percent: Math.floor(Math.min(99, received * 100 / SIZE)) });
    });
    if (counter === id) transfer = null;
    if (counter !== id) throw new Error("cancelled");
    if (response.info().status !== 200 ||
        Number((await Blob.default.fs.stat(temporary)).size) !== SIZE ||
        (await Blob.default.fs.hash(temporary, "sha256")).toLowerCase() !== SHA)
      throw new Error("integrity");
    // No unverified binary ever becomes the active runtime model.
    if (await Blob.default.fs.exists(MODEL())) await Blob.default.fs.unlink(MODEL());
    await Blob.default.fs.mv(temporary, MODEL());
    temporary = "";
    if (!native()?.isRussianOcrInstalled()) throw new Error("native-check");
    emit({ ...state, checked: true, ready: true, percent: 100, error: "" });
  } catch {
    if (counter === id) emit({ ...state, ready: false, error: "Не удалось установить или проверить русскую модель OCR. Оригиналы не затронуты." });
  } finally {
    if (counter === id) transfer = null;
    if (temporary) await Blob.default.fs.unlink(temporary).catch(() => {});
    if (counter === id) emit({ ...state, busy: false, percent: 0 });
  }
}
export function cancelRussianOcrDownload() {
  if (!state.busy) return;
  counter++;
  void transfer?.cancel();
  emit({ ...state, busy: false, percent: 0, error: "Загрузка отменена." });
}
export async function removeRussianOcrModel() {
  if (state.busy) return;
  if (await Blob.default.fs.exists(MODEL())) await Blob.default.fs.unlink(MODEL());
  emit({ ...state, checked: true, ready: false, error: "" });
}
function ensureReady() {
  if (!state.ready || Platform.OS !== "android" || !native()?.isRussianOcrInstalled()) throw new Error("Сначала установите русскую модель OCR в настройках.");
}
export async function recognizeRussianPhoto(file: ImportFile, signal?: AbortSignal): Promise<string> {
  ensureReady();
  if (signal?.aborted) throw new Error("Распознавание остановлено.");
  let result: string;
  try { result = await native()!.recognizeRussianImage(file.uri); }
  catch { throw new Error("Не удалось локально прочитать фотографию. Проверьте модель и оригинал."); }
  if (signal?.aborted) throw new Error("Распознавание остановлено.");
  if (typeof result !== "string" || !result.trim()) throw new Error("На фото не удалось прочитать текст. Оригинал можно сохранить.");
  if (result.length > 60_000) throw new Error("OCR вернул больше 60 000 символов. Нельзя сохранять обрезанный текст.");
  return result.trim();
}
export async function recognizeRussianPdf(file: ImportFile, signal?: AbortSignal,
  onProgress?: (count: number, total: number) => void): Promise<PdfTextPages> {
  ensureReady();
  let start = 1, totalPages = 0;
  const accumulated = new Map<number, string>();
  for (let part = 0; part < 16; part++) {
    if (signal?.aborted) throw new Error("Распознавание остановлено.");
    let nativeResult: unknown;
    try { nativeResult = await native()!.recognizeRussianPdf(file.uri, start); }
    catch { throw new Error("Локальное OCR не смогло прочитать страницу PDF. Оригинал сохранён."); }
    const obj = nativeResult as {
      pageCount?: unknown; pages?: unknown; nextPage?: unknown;
    };
    if (signal?.aborted) throw new Error("Распознавание остановлено.");
    if (!obj || !Number.isSafeInteger(obj.pageCount) || (obj.pageCount as number) < 1 ||
      (obj.pageCount as number) > 128 || !Array.isArray(obj.pages)) throw new Error("Некорректный ответ локального OCR.");
    if (totalPages && obj.pageCount !== totalPages) throw new Error("PDF изменился во время чтения. Повторите импорт.");
    totalPages = obj.pageCount as number;
    if (obj.pages.length) {
      const checked = validateNativePdfPages({pageCount:totalPages,pages:obj.pages});
      const partPages = new Map<number,string>();
      for (const segment of checked.segments) {
        if (segment.location.kind !== "page") throw new Error("Отсутствует настоящий номер страницы PDF.");
        partPages.set(segment.location.page, (partPages.get(segment.location.page) || "") + segment.text);
      }
      for(const [page,text] of partPages) {
        if (!accumulated.has(page)) accumulated.set(page,text);
      }
    }
    onProgress?.(Math.min(totalPages, start + 7), totalPages);
    if (!Number.isSafeInteger(obj.nextPage) || (obj.nextPage as number) <= start ||
        (obj.nextPage as number) > totalPages + 1) throw new Error("Некорректное продолжение OCR.");
    start = obj.nextPage as number;
    if (start > totalPages) {
      const pages = [...accumulated.entries()].sort((a,b) => a[0]-b[0]).map(([page,text]) => ({page,text}));
      return validateNativePdfPages({pageCount:totalPages,pages});
    }
  }
  throw new Error("OCR не завершило PDF за 16 порций; сохраните оригинал.");
}
