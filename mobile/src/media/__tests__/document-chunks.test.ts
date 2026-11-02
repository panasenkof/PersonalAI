import { documentPartsCoverSource, readUtf8SourceSlices, splitDocumentText, DOCUMENT_READ_BYTES } from "../document-chunks";

let mockBytes = new Uint8Array(), mockOffset=0;
const mockClose=jest.fn();
jest.mock("expo-file-system",()=>({
  FileMode:{ReadOnly:"r"},
  File:class {
    exists=true;
    constructor(_uri:string){}
    get size(){return mockBytes.length;}
    open(){mockOffset=0;return {
      readBytes:jest.fn(async(n:number)=>{
        const bytes=mockBytes.slice(mockOffset,mockOffset+n);
        mockOffset+=bytes.length;return bytes;
      }),close:mockClose,
    };}
  },
}));
beforeEach(()=>{mockBytes=new Uint8Array();mockOffset=0;mockClose.mockReset();});

test("H-DOC1b: 24,001 Russian chars + emoji stay lossless, not 24k hard-truncated",()=>{
  const source="Н".repeat(24_000)+"🧾"+"Конец";
  const parts=splitDocumentText(source,5_000);
  expect(parts.length).toBeGreaterThan(4);
  expect(documentPartsCoverSource(source,parts)).toBe(true);
  expect(parts.map(p=>p.text).join("")).toBe(source);
  expect(parts.at(-1)?.endChar).toBe(source.length);
  expect(parts.every(p=>p.text.length<=5000)).toBe(true);
});
test("H-DOC1b: no splitting of a surrogate pair or invented page locator",()=>{
  const text="а".repeat(255)+"😀"+"б".repeat(260);
  const parts=splitDocumentText(text,256,{kind:"page",page:143});
  expect(parts.map(p=>p.text).join("")).toBe(text);
  expect(parts.every(p=>p.location.kind==="page"&&p.location.page===143)).toBe(true);
  expect(parts[0].text.endsWith("\uD83D")).toBe(false);
  expect(parts[1].text.startsWith("\uDE00")).toBe(false);
  expect(documentPartsCoverSource(text,[...parts].reverse())).toBe(false);
  expect(()=>splitDocumentText(text,100,{kind:"page",page:143})).toThrow("invalid_doc_chunk_budget");
  expect(()=>splitDocumentText(text,256,{kind:"page",page:0})).toThrow("invalid_doc_source_page");
});
test("H-DOC1b: incremental UTF-8 decoding handles a Cyrillic boundary across 64KiB bytes",async()=>{
  const source="A".repeat(DOCUMENT_READ_BYTES-1)+"Я"+"😀"+"LAST";
  mockBytes=new TextEncoder().encode(source);
  const result:string[]=[];
  for await (const part of readUtf8SourceSlices("file:///cache/large.txt",()=>{})){
    result.push(part.text);
  }
  expect(result.join("")).toBe(source);
  expect(result.length).toBeGreaterThan(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
test("H-DOC1b: cancellation closes file descriptor and rejects late plaintext",async()=>{
  mockBytes=new TextEncoder().encode("x".repeat(DOCUMENT_READ_BYTES+2));
  let calls=0;
  const run=async()=>{
    for await (const _part of readUtf8SourceSlices("file:///cache/input.txt",()=>{
      if(++calls>=3)throw new Error("locked");
    })){/* do not retain */ }
  };
  await expect(run()).rejects.toThrow("locked");
  expect(mockClose).toHaveBeenCalledTimes(1);
});
test("H-DOC1b: rejects malformed UTF-8, missing source and nonlocal URIs",async()=>{
  mockBytes=new Uint8Array([0xD0,0x20]);
  const run=async(uri:string)=>{
    for await(const _ of readUtf8SourceSlices(uri,()=>{})) {/* nothing */}
  };
  await expect(run("file:///cache/fake.txt")).rejects.toThrow();
  expect(mockClose).toHaveBeenCalledTimes(1);
  await expect(run("https://example.org/private.txt")).rejects.toThrow("doc_requires_local_cache_file");
  mockBytes=new Uint8Array();
  await expect(run("file:///cache/empty.txt")).rejects.toThrow("doc_file_unavailable");
});
