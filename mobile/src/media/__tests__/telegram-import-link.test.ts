/** Integration of the original bounded HTTPS import path with MSG-1 scoped
 * Telegram post verification, using in-memory native file + fetch doubles.
 * A mock response is NOT a real public Telegram or Android device PASS. */
import {importLink} from "../link-import";
import {fetch as nativeFetch} from "expo/fetch";

let mockBytes=Buffer.alloc(0);
const mockDelete=jest.fn();
jest.mock("expo/fetch",()=>({fetch:jest.fn()}));
jest.mock("expo-crypto",()=>({
  randomUUID:()=> "synthetic-telegram-file",
  CryptoDigestAlgorithm:{SHA256:"sha256"},
  digestStringAsync:async (_a:string,text:string)=>require("node:crypto").createHash("sha256").update(text).digest("hex"),
}));
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
function serve(html:string,contentType="text/html",responseUrl="https://t.me/s/public_news/42",redirected=false){
  let read=0;
  const reader={read:jest.fn(async()=>read++===0
    ? {value:new Uint8Array(Buffer.from(html)),done:false}
    : {value:undefined,done:true}),cancel:jest.fn(async()=>{})};
  (nativeFetch as unknown as jest.Mock).mockResolvedValue({
    ok:true,status:200,url:responseUrl,redirected,headers:{get:(key:string)=>key==="content-type"?contentType:null},
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
    expect.objectContaining({redirect:"error",credentials:"omit",cache:"no-store"}));
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
  expect(result.telegramObservation).toMatchObject({
    messageKey:"public_news/42",evidence:"telegram_html_data_post_v1",
    textLength:result.text?.length,
    textSha256:require("node:crypto").createHash("sha256").update(result.text).digest("hex"),
  });
});

test("MSG-1: ordinary t.me/<channel>/<id> uses the fixed /s/ reader without redirecting or changing provenance",async()=>{
  serve('<html><body>'+current+unrelated+'</body></html>');
  const result=await importLink("https://t.me/public_news/42?single");
  expect(result.source).toBe("https://t.me/public_news/42?single");
  expect(nativeFetch).toHaveBeenCalledWith("https://t.me/s/public_news/42",
    expect.objectContaining({redirect:"error",credentials:"omit"}));
  expect(result.text).toContain("Нужный пост");
  expect(result.text).not.toContain("Другая публикация");
  expect(result.telegramObservation?.messageKey).toBe("public_news/42");
});
test("MSG-1: username.t.me alias still reads same t.me public preview, not user-supplied second host",async()=>{
  serve('<html><body>'+current+'</body></html>');
  const result=await importLink("https://public_news.t.me/42");
  expect(nativeFetch).toHaveBeenCalledWith("https://t.me/s/public_news/42",
    expect.objectContaining({redirect:"error"}));
  expect(result.source).toBe("https://public_news.t.me/42");
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
    .rejects.toThrow("Публичный пост Telegram не вернул проверяемый HTML");
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

test("MSG-6C9: URL-mismatched or redirected 200 cannot masquerade as same Telegram post",async()=>{
  serve('<html><body>'+current+'</body></html>',"text/html","https://other.example/public_news/42");
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("Ответ получен с другого адреса");
  expect(mockDelete).not.toHaveBeenCalled();
  serve('<html><body>'+current+'</body></html>',"text/html","https://t.me/s/public_news/42",true);
  await expect(importLink("https://t.me/public_news/42"))
    .rejects.toThrow("перенаправлению запрещены");
  expect(mockDelete).not.toHaveBeenCalled();
  expect(nativeFetch).toHaveBeenCalledTimes(2);
});

test("MSG-6C9: same-origin response with same path is accepted without URL fragments",async()=>{
  serve('<html><body>'+current+'</body></html>',"text/html","https://t.me/s/public_news/42#fragment");
  const result=await importLink("https://t.me/public_news/42");
  expect(result.textCoverage).toBe("telegram_post_text_only");
});
