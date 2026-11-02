import { File, FileMode } from "expo-file-system";

/** H-DOC1b source-side building block; never guesses the LLM's context window.
 * Callers must supply a provider-aware per-request budget and explicit consent
 * before any external synthesis. No code here performs network or persistence.
 */
export type DocumentPart = {
  index: number;
  startChar: number;
  endChar: number;
  text: string;
  location: { kind: "char"; start: number; end: number } | { kind: "page"; page: number };
};

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;
const LOW_SURROGATE = /[\uDC00-\uDFFF]/;

function nextBoundary(text: string, start: number, capacity: number): number {
  let end = Math.min(text.length, start + capacity);
  // Never split a UTF-16 surrogate pair in half.
  if (end < text.length && HIGH_SURROGATE.test(text[end - 1]) && LOW_SURROGATE.test(text[end])) end--;
  if (end <= start) throw new Error("doc_chunk_budget_too_small");
  return end;
}

/** Exact, reversible segmentation for a single source or one real PDF page.
 * No truncation, token estimation, hidden summary, or inferred source pages.
 */
export function splitDocumentText(
  text: string, maxChunkChars: number, location: { kind: "char" } | { kind: "page"; page: number } = { kind: "char" },
): DocumentPart[] {
  if (!Number.isSafeInteger(maxChunkChars) || maxChunkChars < 256 || maxChunkChars > 100_000)
    throw new Error("invalid_doc_chunk_budget");
  if (typeof text !== "string" || !text.length || text.includes("\0") || text.includes("\uFFFD"))
    throw new Error("invalid_doc_source_text");
  if (location.kind === "page" && (!Number.isSafeInteger(location.page) || location.page < 1))
    throw new Error("invalid_doc_source_page");
  const parts: DocumentPart[] = [];
  for (let start = 0; start < text.length;) {
    const end = nextBoundary(text, start, maxChunkChars);
    parts.push({index:parts.length, startChar:start, endChar:end, text:text.slice(start,end),
      location: location.kind === "page" ? {kind:"page",page:location.page} : {kind:"char",start,end}});
    start = end;
  }
  return parts;
}

/** Validated source coverage; only mark a document fully *read* if the
 * consecutive segments reproduce its entire source. Reading != LLM analysis.
 */
export function documentPartsCoverSource(text: string, parts: readonly DocumentPart[]): boolean {
  if (typeof text !== "string" || !parts.length) return false;
  let offset = 0;
  for(let i=0;i<parts.length;i++){
    const part=parts[i];
    if(part.index!==i || part.startChar!==offset || part.endChar<=offset ||
      part.endChar>text.length || text.slice(offset,part.endChar)!==part.text)return false;
    offset=part.endChar;
  }
  return offset===text.length;
}

export const MAX_CHAT_DOCUMENT_SOURCE_BYTES = 6 * 1024 * 1024;
export const DOCUMENT_READ_BYTES = 64 * 1024;

export type SourceTextSlice = {text:string;startChar:number;endChar:number};

/** Read UTF-8 incrementally from the picked LOCAL cache file. No giant initial
 * readAsStringAsync, no replacement characters, no external upload.
 * Consumer should re-check unlocked/profile state through check() at each yield.
 */
export async function* readUtf8SourceSlices(
  uri: string, check: () => void,
  maxFileBytes = MAX_CHAT_DOCUMENT_SOURCE_BYTES,
): AsyncGenerator<SourceTextSlice> {
  if (!uri.startsWith("file://")) throw new Error("doc_requires_local_cache_file");
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      maxFileBytes > MAX_CHAT_DOCUMENT_SOURCE_BYTES) throw new Error("invalid_doc_file_budget");
  check();
  const file = new File(uri);
  if (!file.exists || !file.size || file.size > maxFileBytes)
    throw new Error("doc_file_unavailable_or_too_large");
  const handle=file.open(FileMode.ReadOnly);
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let offset=0, consumed=0;
  try{
    while (consumed < file.size) {
      check();
      const bytes=await handle.readBytes(Math.min(DOCUMENT_READ_BYTES,file.size-consumed));
      if(!bytes.length)throw new Error("doc_short_read");
      consumed+=bytes.length;
      if(consumed>maxFileBytes)throw new Error("doc_file_overflow");
      const text=decoder.decode(bytes,{stream:true});
      if(text.includes("\0") || text.includes("\uFFFD"))throw new Error("invalid_doc_source_text");
      if(text.length){
        check();
        yield {text,startChar:offset,endChar:offset+text.length};
        offset+=text.length;
      }
    }
    check();
    const final=decoder.decode();
    if(final.includes("\0") || final.includes("\uFFFD"))throw new Error("invalid_doc_source_text");
    if(final)yield {text:final,startChar:offset,endChar:offset+final.length};
  } finally {handle.close();}
}
