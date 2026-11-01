import { extractPdfPages, validateNativePdfPages, pdfCoverageMessage, pdfImportError } from "../pdf-pages";

const file={uri:"file:///cache/report.pdf",name:"report.pdf",mimeType:"application/pdf"};
test("native digital PDF page numbers remain real and create bounded segments",async()=>{
 const reader={extractPages:jest.fn(async()=>[
   {page:1,text:"Предисловие"},
   {page:3,text:"Сводка расходов"},
 ])};
 const result=await extractPdfPages(file,undefined,reader);
 expect(reader.extractPages).toHaveBeenCalledWith(file.uri,128);
 expect(result).toMatchObject({extractedPageCount:2,coverage:"partial"});
 expect(result.text).toContain("Страница 3:");
 expect(result.segments).toEqual([
   {text:"Предисловие",location:{kind:"page",page:1}},
   {text:"Сводка расходов",location:{kind:"page",page:3}},
 ]);
 expect(result.segments).not.toContainEqual(expect.objectContaining({location:{kind:"page",page:2}}));
});
test("broken PDF page positions, duplicates and fake text fail closed",()=>{
 for(const value of [
   [{page:0,text:"one"}],
   [{page:2,text:"one"},{page:2,text:"two"}],
   [{page:2,text:"one"},{page:1,text:"two"}],
   [{page:1,text:"  "}],
   [{page:129,text:"bad"}],
   [{page:1,text:"a".repeat(60_001)}],
   null,[],
 ]){
   expect(()=>validateNativePdfPages(value)).toThrow();
 }
});
test("emoji text split is UTF-16 safe without corrupting the original page",()=>{
 const text="🧾".repeat(3100);
 const result=validateNativePdfPages([{page:5,text}]);
 expect(result.segments).toHaveLength(2);
 expect(result.segments.map(s=>s.text).join("")).toBe(text);
 expect(result.segments.map(s=>s.location)).toEqual([{kind:"page",page:5},{kind:"page",page:5}]);
 expect(result.segments.every(s=>s.text.length<=6000)).toBe(true);
});
test("native reader remains local; remote/content URI rejected before native access",async()=>{
 const reader={extractPages:jest.fn(async()=>[])};
 for(const uri of ["https://example.org/a.pdf","content://downloads/10"]){
  await expect(extractPdfPages({...file,uri},undefined,reader)).rejects.toThrow("pdf_copy_to_app_cache_required");
 }
 const signal=new AbortController();signal.abort();
 await expect(extractPdfPages(file,signal.signal,reader)).rejects.toThrow("остановлен");
 expect(reader.extractPages).not.toHaveBeenCalled();
});
test("scanned document with no native text layer refuses fabricated OCR page",async()=>{
 await expect(extractPdfPages(file,undefined,{extractPages:async()=>[]})).rejects.toThrow("не найден текстовый слой");
});

test("native device capability gate prevents speculative page extraction",async()=>{
 const reader={isAvailable:jest.fn(()=>false),extractPages:jest.fn(async()=>[{page:1,text:"fake"}])};
 await expect(extractPdfPages(file,undefined,reader)).rejects.toThrow("нет системного извлечения");
 expect(reader.isAvailable).toHaveBeenCalledTimes(1);
 expect(reader.extractPages).not.toHaveBeenCalled();
});
test("native extension-supported device uses same validated pages",async()=>{
 const reader={isAvailable:jest.fn(()=>true),extractPages:jest.fn(async()=>[{page:2,text:"Текст второй страницы"}])};
 const result=await extractPdfPages(file,undefined,reader);
 expect(result.segments).toEqual([{text:"Текст второй страницы",location:{kind:"page",page:2}}]);
});

test("step 8 D: native pageCount includes missing scan pages (not fabricated source segments)", async () => {
  const reader = { extractPages: jest.fn(async () => ({ pageCount: 4, pages: [
    {page:1, text:"Начало инструкции"},
    {page:4, text:"Последняя страница: контрольная фраза XYZ"},
  ]})) };
  const pages = await extractPdfPages(file, undefined, reader);
  expect(pages).toMatchObject({totalPageCount:4, extractedPageCount:2, missingPages:[2,3], coverage:"partial"});
  expect(pages.segments.map(s => s.location)).toEqual([{kind:"page",page:1},{kind:"page",page:4}]);
  expect(pdfCoverageMessage(pages)).toMatch(/2 из 4 стр.*2, 3.*OCR пока не выполнялся/);
  expect(pages.text).toContain("Страница 4:\nПоследняя страница: контрольная фраза XYZ");
});
test("step 8 D: old native readers never infer a total from the highest page", () => {
  const pages = validateNativePdfPages([{page:2,text:"Середина"},{page:5,text:"Конец"}]);
  expect(pages.totalPageCount).toBeNull();
  expect(pages.missingPages).toEqual([]);
  expect(pdfCoverageMessage(pages)).toMatch(/неизвестно/);
});
test("step 8 D: inconsistent page count and source page indices fail closed", () => {
  const invalid = [
    {pageCount:0,pages:[{page:1,text:"A"}]},
    {pageCount:129,pages:[{page:1,text:"A"}]},
    {pageCount:1,pages:[{page:2,text:"B"}]},
    {pageCount:2,pages:[{page:1,text:"A"},{page:1,text:"B"}]},
    {pageCount:2,pages:[]},
    {pageCount:2,pages:[{page:2,text:"  "}]},
    {pages:[{page:1,text:"A"}]},
  ];
  for (const value of invalid) expect(() => validateNativePdfPages(value)).toThrow();
});
test("step 8 D: all pages with text still do not falsely guarantee completeness", () => {
  const pages=validateNativePdfPages({pageCount:2,pages:[{page:1,text:"Первая"},{page:2,text:"Вторая"}]});
  expect(pages.coverage).toBe("partial");
  expect(pages.missingPages).toEqual([]);
  expect(pdfCoverageMessage(pages)).toMatch(/не гарантирована полнота/);
});
test("step 8 D: password, corrupt, too many pages and unknown native errors have distinct safe messages", async () => {
  const cases:[string,RegExp][]=[
    ["pdf_password_or_permission_required",/защищён паролем/],
    ["pdf_corrupt_or_unreadable",/повреждён/],
    ["pdf_page_limit_exceeded",/128 страниц/],
    ["pdf_text_limit_exceeded",/60 000/],
    ["pdf_no_text_layer_or_page_limit",/текстовый слой/],
  ];
  for(const [code, expected] of cases){
    const native = {extractPages:async()=>{throw new Error("Native "+code+": /secret/private/other.pdf");}};
    await expect(extractPdfPages(file,undefined,native)).rejects.toThrow(expected);
  }
  const safe=pdfImportError(new Error("/private/secret-file.pdf exceptional crash"));
  expect(safe).not.toContain("/private/");
  expect(safe).toMatch(/Не удалось прочитать PDF/);
});
test("step 8 D: cancellation after native read prevents publishing stale evidence", async () => {
  const controller=new AbortController();
  const reader={extractPages:jest.fn(async()=>{controller.abort();return {pageCount:1,pages:[{page:1,text:"secret"}]};})};
  await expect(extractPdfPages(file,controller.signal,reader)).rejects.toThrow(/остановлен/);
});
