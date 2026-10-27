import { extractPdfPages, validateNativePdfPages } from "../pdf-pages";

jest.mock("expo-modules-core", () => ({ requireOptionalNativeModule: jest.fn(() => null) }));

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
