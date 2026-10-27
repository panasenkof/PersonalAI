import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ExtractionSegmentInput } from "../local-memory/extractions";
import type { ImportFile } from "./kinds";

type Page = { page: number; text: string };
type NativePdf = { extractPages: (uri: string, limit: number) => Promise<unknown>; isAvailable?: () => boolean };
export type PdfTextPages = {
  text: string; segments: ExtractionSegmentInput[];
  coverage: "partial"; extractedPageCount: number;
};

const PAGE_LIMIT = 128;
const MAX_CHARS = 60_000;
const MAX_SEGMENTS = 128;
/** Keep the PDF page number supplied by the operating system. Never infer
 * pages from the layout of flattened text and never allow arbitrary PDF ops.
 */
export function validateNativePdfPages(value: unknown): PdfTextPages {
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGE_LIMIT) {
    throw new Error("pdf_no_text_layer_or_page_limit");
  }
  const seen=new Set<number>(), segments: ExtractionSegmentInput[]=[];
  const parts:string[]=[];
  let previous=0, total=0;
  for(const row of value as Page[]) {
    if (!row || !Number.isSafeInteger(row.page) || row.page < 1 ||
        row.page <= previous || row.page > PAGE_LIMIT || seen.has(row.page) ||
        typeof row.text !== "string" || !row.text.trim()) throw new Error("invalid_pdf_page_evidence");
    previous=row.page; seen.add(row.page);
    const t=row.text.trim();
    total+=t.length;
    if (total>MAX_CHARS) throw new Error("pdf_text_limit_exceeded");
    const characters=Array.from(t);
    for(let pos=0;pos<characters.length;pos+=3000){
      const text=characters.slice(pos,pos+3000).join("");
      segments.push({text,location:{kind:"page",page:row.page}});
      if(segments.length>MAX_SEGMENTS)throw new Error("pdf_segment_limit_exceeded");
    }
    parts.push("Страница "+row.page+":\n"+t);
  }
  const text=parts.join("\n\n");
  if(text.length>MAX_CHARS)throw new Error("pdf_text_limit_exceeded");
  return {text,segments,coverage:"partial",extractedPageCount:value.length};
}
/** Local digital PDF text layer only. No OCR, no network, no hidden upload.
 * Supports Android 15+ and Android 12–14 only with system S Extensions 13+.
 * Android 9–11 and unsupported devices still retain encrypted originals.
 */
export async function extractPdfPages(
  file:ImportFile, signal?:AbortSignal,
  nativeReader?:NativePdf,
):Promise<PdfTextPages>{
  if(!/\.pdf$/i.test(file.name) && file.mimeType!=="application/pdf")throw new Error("not_pdf_file");
  if(!file.uri.startsWith("file://"))throw new Error("pdf_copy_to_app_cache_required");
  if(signal?.aborted)throw new Error("Разбор файла остановлен");
  if(!nativeReader && Platform.OS!=="android")
    throw new Error("Чтение страниц PDF пока доступно только на поддерживаемых Android. Оригинал можно сохранить без распознавания.");
  const reader=nativeReader||requireOptionalNativeModule<NativePdf>("PersaiPdfText");
  if(!reader)throw new Error("Чтение страниц PDF недоступно в этой сборке. Сохраните оригинал или обновите приложение.");
  // Android 12–14 may expose this system API via S Extensions 13; an Android
  // version number alone is not a reliable availability check.
  if (reader.isAvailable ? !reader.isAvailable() : !nativeReader && Number(Platform.Version)<35)
    throw new Error("На этом устройстве нет системного извлечения текста PDF (Android 15+ или расширение Android 12–14 S v13). Оригинал можно сохранить.");
  const result=await reader.extractPages(file.uri,PAGE_LIMIT);
  if(signal?.aborted)throw new Error("Разбор файла остановлен");
  try{return validateNativePdfPages(result);}
  catch(e){if(String(e).includes("pdf_no_text_layer"))throw new Error(
    "В PDF не найден текстовый слой (возможен скан). Оригинал можно сохранить без распознавания; OCR запланирован отдельно.");
    throw e;
  }
}
