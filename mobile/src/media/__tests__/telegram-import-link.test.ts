/** Integration of the original bounded HTTPS import path with MSG-1 scoped
 * Telegram post verification, using in-memory native file + fetch doubles.
 * A mock response is NOT a real public Telegram or Android device PASS. */
import {importLink} from "../link-import";
import {fetch as nativeFetch} from "expo/fetch";

let mockBytes=Buffer.alloc(0);
const mockDelete=jest.fn();
jest.mock("expo/fetch",()=>({fetch:jest.fn()}));
jest.mock("expo-crypto",()=>({randomUUID:()=> "synthetic-telegram-file"}));
jest.mock("expo-file-system",()=>({
  Paths:{cache:"file:///cache"},
  FileMode:{WriteOnly:"write"},
  Directory:class{
    uri:string;
    constructor(root:string,name:string){this.uri=root+"/"+name;}
    create(){}
  },
  File:class{
    uri:string; exists=true;
    constructor(folder:{uri:string},name:string){this.uri=folder.uri+"/"+name;}
    create(){mockBytes=Buffer.alloc(0);}
    open(){return {writeBytes:(value:Uint8Array)=>{
      mockBytes=Buffer.concat([mockBytes,Buffer.from(value)]);
    },close:()=>{}};}
    async text(){return mockBytes.toString("utf8");}
    delete(){this.exists=false;mockDelete(this.uri);}
  },
}));
const current='<div class="tgme_widget_message js-widget_message" data-post="public_news/42">'+
  '<div class="tgme_widget_message_text js-message_text"><p>Нужный пост о космической миссии</p>'+
  '<p>Вторая строка с подробностями.</p></div>'+
  '<div class="tgme_widget_message_photo_wrap"></div></div>';
const unrelated='<div class="tgme_widget_message" data-post="public_news/43">'+
  '<div class="tgme_widget_message_text">Другая публикация, ошибочно похожая на искомую.</div></div>';
function serve(html:string,contentType="text/html"){
  let read=0;
  const reader={read:jest.fn(async()=>read++===0
    ? {value:new Uint8Array(Buffer.from(html)),done:false}
    : {value:undefined,done:true}),cancel:jest.fn(async()=>{})};
  (nativeFetch as unknown as jest.Mock).mockResolvedValue({
    ok:true,status:200,headers:{get:(key:string)=>key==="content-type"?contentType:null},
    body:{getReader:()=>reader},
  });
  return reader;
}
beforeEach(()=>{jest.clearAllMocks();mockBytes=Buffer.alloc(0);});

test("MSG-1: importLink still uses native HTTPS/no-redirect and returns only scoped post text",async()=>{
  const fakeHtml='<html><head><meta property="article:published_time" content="2026-10-01">'+
    '</head><body><nav>Не имеет отношения к сообщению</nav>'+unrelated+current+'</body></html>';
  const reader=serve(fakeHtml);
  const result=await importLink("https://t.me/s/public_news/42");
  expect(nativeFetch).toHaveBeenCalledWith("https://t.me/s/public_news/42",
    expect.objectContaining({redirect:"error",credentials:"omit"}));
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(reader.cancel).toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({source:"https://t.me/s/public_news/42",
    title:"Telegram · public_news/42",partial:true,
    textCoverage:"telegram_post_text_only"});
  expect(result.text).toContain("Нужный пост");
  expect(result.text).toContain("Вторая строка");
  expect(result.text).not.toMatch(/Другая публикация|Не имеет отношения/);
  expect(result.publicationClaim).toBeUndefined();
});

test("MSG-1: target missing from channel feed is NOT successful article import",async()=>{
  serve("<html><body><main><h1>Канал</h1></main>"+unrelated+"</body></html>");
  await expect(importLink("https://t.me/s/public_news/42"))
    .rejects.toThrow("не найдено именно это сообщение");
  expect(mockDelete).toHaveBeenCalled();
});
test("MSG-1: fake login/JS channel page cannot become a saved post",async()=>{
  serve('<html><body><form><input type="password"></form>'+
    '<script>window.runTelegram()</script></body></html>');
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("не найдено именно это сообщение");
});
test("MSG-1: non-HTML response is not treated as post bytes or stored file",async()=>{
  serve("not a post","application/json");
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("Telegram не вернул HTML");
  expect(mockDelete).not.toHaveBeenCalled();
});
test("MSG-1: exact message may be media only; no fallthrough to next text",async()=>{
  serve('<div class="tgme_widget_message" data-post="public_news/42">'+
    '<div class="tgme_widget_message_photo_wrap"></div></div>'+unrelated);
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("нет доступного текста");
});
test("MSG-1: no implicit redirects, including public Telegram URL aliases",async()=>{
  (nativeFetch as unknown as jest.Mock).mockResolvedValue({ok:false,status:302});
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("перенаправляет");
  expect(nativeFetch).toHaveBeenCalledTimes(1);
});
