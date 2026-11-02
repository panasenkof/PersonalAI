import { PDF_WINDOW_SIZE, readPdfTextWindows, validatePdfTextWindow } from "../pdf-window-reader";
const file={uri:"file:///cache/report.pdf",name:"report.pdf",mimeType:"application/pdf"};
test("H-DOC1b: 130-page PDF can read beyond legacy 128-page boundary without inventing scan text",async()=>{
  const reader={isAvailable:()=>true,extractPageRange:jest.fn(async(_uri:string,first:number,count:number)=>({
    pageCount:130,firstPage:first,processedPageCount:Math.min(count,130-first+1),
    pages:first<=1&&first+count>1 ? [{page:1,text:"Начало"}] :
      first<=129&&first+count>129 ? [{page:129,text:"Текст 129-й страницы"},{page:130,text:"Конец"}] : [],
  }))};
  const received:number[]=[];const missing:number[]=[];
  for await (const w of readPdfTextWindows(file,()=>{},reader)){
    received.push(...w.pages.map(p=>p.page));
    missing.push(...w.missingPages);
  }
  expect(received).toEqual([1,129,130]);
  expect(missing).toHaveLength(127);
  expect(reader.extractPageRange).toHaveBeenCalledTimes(Math.ceil(130/PDF_WINDOW_SIZE));
  expect(reader.extractPageRange).toHaveBeenLastCalledWith(file.uri,129,16);
});
test("H-DOC1b: only native-reported pages inside exact window can become evidence",()=>{
  const valid=validatePdfTextWindow({
    pageCount:4,firstPage:2,processedPageCount:2,pages:[{page:3,text:"Русский"}],
  },2,2,4);
  expect(valid.missingPages).toEqual([2]);
  expect(valid.pages).toEqual([{page:3,text:"Русский"}]);
  for(const invalid of [
    {pageCount:4,firstPage:1,processedPageCount:2,pages:[{page:3,text:"X"}]},
    {pageCount:4,firstPage:2,processedPageCount:2,pages:[{page:3,text:"X"},{page:3,text:"Y"}]},
    {pageCount:4,firstPage:2,processedPageCount:2,pages:[{page:4,text:"Wrong range"}]},
    {pageCount:5,firstPage:2,processedPageCount:2,pages:[{page:3,text:"Changed total"}]},
    {pageCount:4,firstPage:2,processedPageCount:2,pages:[{page:2,text:" "}]},
    {pageCount:4,firstPage:2,processedPageCount:1,pages:[]},
  ])expect(()=>validatePdfTextWindow(invalid,2,2,4)).toThrow();
});
test("H-DOC1b: cancellation blocks late native results",async()=>{
  const abort=new AbortController();
  const reader={extractPageRange:jest.fn(async()=>{
    abort.abort();
    return {pageCount:1,firstPage:1,processedPageCount:1,pages:[{page:1,text:"PRIVATE"}]};
  })};
  const consume=async()=>{for await(const _ of readPdfTextWindows(file,()=>{
    if(abort.signal.aborted)throw new Error("locked");
  },reader)) {/* no results may escape */}};
  await expect(consume()).rejects.toThrow("locked");
});
test("H-DOC1b: resource budget, missing parser and remote PDF are rejected, not silently skipped",async()=>{
  const reader={extractPageRange:jest.fn(async()=>({pageCount:300,firstPage:1,
    processedPageCount:1,pages:[{page:1,text:"X"}]}))};
  const consume=async(f=file,max=10)=>{
    const items=[];for await(const w of readPdfTextWindows(f,()=>{},reader,max))items.push(w);return items;
  };
  await expect(consume()).rejects.toThrow();
  await expect(consume({...file,uri:"https://example.com/f.pdf"})).rejects.toThrow("pdf_copy_to_app_cache_required");
  expect(()=>validatePdfTextWindow({pageCount:2,firstPage:1,processedPageCount:0,pages:[]},1,16,null)).toThrow();
});
