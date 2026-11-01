import { Platform } from "react-native";
import * as Blob from "react-native-blob-util";
import { requireOptionalNativeModule } from "expo-modules-core";
import { cancelRussianOcrDownload, getRussianOcrStatus, installRussianOcr,
  recognizeRussianPhoto, recognizeRussianPdf, refreshRussianOcrStatus, removeRussianOcrModel } from "../russian-ocr";

const mockFiles = new Map<string,number>();
let mockChecksum = "e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225";
const mockEngine = {
  isRussianOcrInstalled: jest.fn(() => true),
  recognizeRussianImage: jest.fn(async () => "Счёт 25 г, ½ л"),
  recognizeRussianPdf: jest.fn(async (_uri:string,start:number) =>
    start === 1 ? {pageCount:4,pages:[{page:1,text:"Текстовый слой",source:"text"},{page:3,text:"Рецепт 200 г",source:"ocr"}],nextPage:4} :
      {pageCount:4,pages:[{page:1,text:"Текстовый слой",source:"text"},{page:4,text:"№ 314",source:"ocr"}],nextPage:5}),
};
jest.mock("expo-modules-core", () => ({ requireOptionalNativeModule: jest.fn(() => mockEngine) }));
jest.mock("react-native-blob-util", () => {
  const fs = {
    dirs: { DocumentDir: "/app-private" },
    exists: jest.fn(async (p:string) => mockFiles.has(p)),
    stat: jest.fn(async (p:string) => ({size:String(mockFiles.get(p) ?? -1)})),
    hash: jest.fn(async () => mockChecksum),
    mkdir: jest.fn(async (p:string) => { mockFiles.set(p,0); }),
    unlink: jest.fn(async (p:string) => { mockFiles.delete(p); }),
    mv: jest.fn(async (p:string,q:string) => {mockFiles.set(q,mockFiles.get(p)!);mockFiles.delete(p);}),
  };
  return { __esModule:true, default:{
    fs,
    config: jest.fn(({path}:{path:string}) => ({
      fetch: jest.fn(() => {
        mockFiles.set(path,3861738);
        const promise:any = Promise.resolve({info:()=>({status:200})});
        promise.progress = (_:unknown,fn:(n:number)=>void) => {fn(3861738);return promise;};
        promise.cancel = jest.fn(async () => {});
        return promise;
      }),
    })),
  }};
});
beforeEach(async()=>{
  jest.clearAllMocks();
  Object.defineProperty(Platform,"OS",{value:"android",configurable:true});
  mockFiles.clear();
  mockChecksum="e16e5e036cce1d9ec2b00063cf8b54472625b9e14d893a169e2b0dedeb4df225";
  await removeRussianOcrModel();
  mockEngine.isRussianOcrInstalled.mockReturnValue(true);
});
const photo = {uri:"file:///cache/scan.jpg",name:"scan.jpg",mimeType:"image/jpeg"};
const pdf = {uri:"file:///cache/scan.pdf",name:"scan.pdf",mimeType:"application/pdf"};
test("no model download without an explicit install click; no network is contacted",async()=>{
  await refreshRussianOcrStatus();
  expect(getRussianOcrStatus().ready).toBe(false);
  expect(Blob.default.config).not.toHaveBeenCalled();
  await expect(recognizeRussianPhoto(photo)).rejects.toThrow("установите");
});
test("explicit Russian model install uses pinned revision and verifies actual SHA256 + byte count",async()=>{
  await installRussianOcr();
  expect(getRussianOcrStatus().ready).toBe(true);
  expect(Blob.default.config).toHaveBeenCalledTimes(1);
  const url=(Blob.default.config as jest.Mock).mock.results[0].value.fetch.mock.calls[0][1];
  expect(url).toContain("/83ff76b97461395f257255720bf7f3957606dbb5/rus.traineddata");
  expect(mockFiles.has("/app-private/tessdata/rus.traineddata")).toBe(true);
  expect(await recognizeRussianPhoto(photo)).toBe("Счёт 25 г, ½ л");
  expect(mockEngine.recognizeRussianImage).toHaveBeenCalledWith(photo.uri);
  await removeRussianOcrModel();
  expect(getRussianOcrStatus().ready).toBe(false);
});
test("wrong SHA fails closed; never permits untrusted OCR model at final path",async()=>{
  mockChecksum="f".repeat(64);
  await installRussianOcr();
  expect(getRussianOcrStatus().ready).toBe(false);
  expect(getRussianOcrStatus().error).toMatch(/проверить/);
  expect(mockFiles.has("/app-private/tessdata/rus.traineddata")).toBe(false);
  expect([...mockFiles.keys()].every(p=>!p.endsWith(".partial"))).toBe(true);
});
test("mixed PDF merges 8-page batches by native 1-based page without duplicating text layer",async()=>{
  await installRussianOcr();
  const progress=jest.fn();
  const output=await recognizeRussianPdf(pdf,undefined,progress);
  expect(output.totalPageCount).toBe(4);
  expect(output.extractedPageCount).toBe(3);
  expect(output.missingPages).toEqual([2]);
  expect(output.text.match(/Текстовый слой/g)).toHaveLength(1);
  expect(output.text).toContain("Страница 3:\nРецепт 200 г");
  expect(output.text).toContain("Страница 4:\n№ 314");
  expect(mockEngine.recognizeRussianPdf).toHaveBeenNthCalledWith(1,pdf.uri,1);
  expect(mockEngine.recognizeRussianPdf).toHaveBeenNthCalledWith(2,pdf.uri,4);
});
test("false page numbers, misleading continuation, abort are not saved",async()=>{
  await installRussianOcr();
  mockEngine.recognizeRussianPdf.mockResolvedValueOnce({pageCount:2,pages:[{page:3,text:"BAD",source:"ocr"}],nextPage:3});
  await expect(recognizeRussianPdf(pdf)).rejects.toThrow();
  const c=new AbortController();c.abort();
  await expect(recognizeRussianPhoto(photo,c.signal)).rejects.toThrow("остановлено");
  expect(mockEngine.recognizeRussianImage).not.toHaveBeenCalled();
});
