import { renderPdfPage, deletePdfPagePreview } from "../pdf-page-preview";
import * as FileSystem from "expo-file-system/legacy";

jest.mock("expo-file-system/legacy", () => ({
  deleteAsync: jest.fn(async () => {}),
}));
const source = "file:///data/user/0/com.persai/cache/source.pdf";
const image = "file:///data/user/0/com.persai/cache/persai-pdf-page-previews/page-1234.jpg";
beforeEach(() => jest.clearAllMocks());

test("E2a local renderer returns only the actual requested 1-based page, no OCR", async () => {
  const reader = {
    isPagePreviewAvailable: () => true,
    renderPage: jest.fn(async () => ({ uri: image, page: 3, pageCount: 6 })),
  };
  expect(await renderPdfPage(source, 3, undefined, reader)).toEqual({
    uri: image, page: 3, pageCount: 6,
  });
  expect(reader.renderPage).toHaveBeenCalledWith(source, 3, 1200);
  expect(FileSystem.deleteAsync).not.toHaveBeenCalled();
});

test("E2a rejects invalid source and page before native operation", async () => {
  const reader = { renderPage: jest.fn() };
  for (const uri of ["https://example.org/secret.pdf", "content://media/file/4"])
    await expect(renderPdfPage(uri, 1, undefined, reader)).rejects.toThrow("локально");
  for (const n of [0,-1,129,1.5,NaN])
    await expect(renderPdfPage(source, n, undefined, reader)).rejects.toThrow("номер");
  expect(reader.renderPage).not.toHaveBeenCalled();
});

test("E2a never allows a native response to expose arbitrary file URI or invented page", async () => {
  for(const output of [
    {uri:"file:///data/user/0/com.persai/cache/secret.pdf",page:1,pageCount:1},
    {uri:image,page:2,pageCount:3},
    {uri:image,page:1,pageCount:0},
    {uri:image,page:1,pageCount:129},
  ]) {
    await expect(renderPdfPage(source,1,undefined,{renderPage:async()=>output}))
      .rejects.toThrow("некорректную страницу");
  }
  expect(FileSystem.deleteAsync).not.toHaveBeenCalledWith("file:///data/user/0/com.persai/cache/secret.pdf",expect.anything());
});

test("E2a cancellation during native rasterization discards temporary plaintext image", async () => {
  const c=new AbortController();
  const reader={renderPage:async()=>{c.abort();return {uri:image,page:1,pageCount:5};}};
  await expect(renderPdfPage(source,1,c.signal,reader)).rejects.toThrow("остановлен");
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(image,{idempotent:true});
  const before=(FileSystem.deleteAsync as jest.Mock).mock.calls.length;
  await deletePdfPagePreview(source);
  await deletePdfPagePreview("content://other/cache.jpg");
  expect((FileSystem.deleteAsync as jest.Mock).mock.calls.length).toBe(before);
});

test("E2a unsupported device cannot be mistaken for successful OCR or viewer",async()=>{
  const reader={isPagePreviewAvailable:()=>false,renderPage:jest.fn()};
  await expect(renderPdfPage(source,1,undefined,reader)).rejects.toThrow("недоступен");
  expect(reader.renderPage).not.toHaveBeenCalled();
});

test("E2a never leaks raw native paths or PDF metadata in error messages",async()=>{
  const reader={renderPage:async()=>{throw new Error("secret account 123 at /data/cache/private.pdf");}};
  await expect(renderPdfPage(source,1,undefined,reader)).rejects.not.toThrow("123");
});
