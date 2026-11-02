import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ImportFile } from "./kinds";
import { pdfImportError } from "./pdf-pages";

/** Additive H-DOC1b extractor. The existing save-note PDF path is untouched. */
export type PdfTextPage = {page:number;text:string};
export type PdfRangeSource = {
  pageCount: number;
  firstPage: number;
  processedPageCount: number;
  pages: PdfTextPage[];
};
export type PdfTextWindow = PdfRangeSource & {
  /** True source page indices without native text; NEVER label scanned/OCR. */
  missingPages: number[];
};
export type PdfWindowNative = {
  extractPageRange:(uri:string,firstPage:number,count:number)=>Promise<unknown>;
  isAvailable?:()=>boolean;
};
export const PDF_WINDOW_SIZE=16;
export const MAX_PDF_CHAT_PAGES=4096;

export function validatePdfTextWindow(
  payload:unknown, expectedStart:number, requestedCount:number,
  previousTotal:number|null,
):PdfTextWindow {
  if(!payload || typeof payload!=="object" || Array.isArray(payload))throw new Error("invalid_pdf_window");
  const row=payload as Partial<PdfRangeSource>;
  const total=row.pageCount;
  const from=row.firstPage;
  const count=row.processedPageCount;
  if(!Number.isSafeInteger(total) || (total as number)<1 ||
    !Number.isSafeInteger(from) || from!==expectedStart ||
    !Number.isSafeInteger(count) || (count as number)<1 ||
    (count as number)>requestedCount || from! <= (total as number) ||
    (count as number)!==Math.min(requestedCount,(total as number)-from!+1) ||
    (previousTotal!==null && total!==previousTotal) || !Array.isArray(row.pages))
      throw new Error("invalid_pdf_window");
  const end=from!+count!-1,missingPages:number[]=[],seen=new Set<number>();
  let last=from!-1,chars=0;
  for(const p of row.pages){
    if(!p || !Number.isSafeInteger(p.page) || p.page<from! ||
      p.page>end || p.page<=last || typeof p.text!=="string" ||
      !p.text.trim() || p.text.includes("\0") || p.text.includes("\uFFFD"))
      throw new Error("invalid_pdf_window_evidence");
    last=p.page; seen.add(p.page);chars+=p.text.length;
    if(chars>128_000)throw new Error("invalid_pdf_window_evidence");
  }
  for(let p=from!;p<=end;p++)if(!seen.has(p))missingPages.push(p);
  return {pageCount:total!,firstPage:from!,processedPageCount:count!,pages:row.pages,missingPages};
}

/** One page window at a time; there is no 128-page or 60k-char *global*
 * limit here. A global resource bound is visible to the caller and fails
 * BEFORE any source text is presented as complete. No OCR, upload or storage.
 */
export async function* readPdfTextWindows(
  file:ImportFile, check:()=>void, reader?:PdfWindowNative,
  maxPages=MAX_PDF_CHAT_PAGES,
):AsyncGenerator<PdfTextWindow> {
  if(!/\.pdf$/i.test(file.name) && file.mimeType!=="application/pdf")throw new Error("not_pdf_file");
  if(!file.uri.startsWith("file://"))throw new Error("pdf_copy_to_app_cache_required");
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>MAX_PDF_CHAT_PAGES)
    throw new Error("invalid_pdf_page_budget");
  if(!reader && Platform.OS!=="android")throw new Error("pdf_reader_not_available");
  const native=reader||requireOptionalNativeModule<PdfWindowNative>("PersaiPdfText");
  if(!native?.extractPageRange || native.isAvailable?.()===false)
    throw new Error("pdf_reader_not_available");
  let total:number|null=null;
  for(let from=1;total===null||from<=total;){
    check();
    let window:PdfTextWindow;
    try {
      window=validatePdfTextWindow(
        await native.extractPageRange(file.uri,from,Math.min(PDF_WINDOW_SIZE,maxPages-from+1)),
        from,Math.min(PDF_WINDOW_SIZE,maxPages-from+1),total,
      );
    } catch(e) {
      check();
      throw new Error(pdfImportError(e));
    }
    check();
    total=window.pageCount;
    if(total>maxPages)throw new Error("PDF содержит "+total+
      " страниц, что превышает согласованный бюджет чтения "+maxPages+
      ". Ничего не пропущено незаметно; расширьте бюджет или сохраните оригинал.");
    yield window;
    from+=window.processedPageCount;
  }
}
