import {telegramLinkedText,telegramBotLinks,validTelegramLinks} from "../links";
test("hidden HTML-style text link is appended once; visible link is not duplicated",()=>{
  const u="https://example.com/article";
  expect(telegramLinkedText("Статья",[u])).toEqual({
    body:"Статья\n\nСсылки:\n"+u,sourceUrl:u,sourceCoverage:"url_only",
  });
  expect(telegramLinkedText("Статья "+u,[u])).toEqual({
    body:"Статья "+u,sourceUrl:u,sourceCoverage:"url_only",
  });
});
test("two distinct URLs don't create a misleading unique source",()=>{
  expect(telegramLinkedText("Ссылки",["https://one.test","https://two.test"]).sourceUrl).toBeUndefined();
  expect(telegramLinkedText("",["https://one.test"]).body).toContain("Ссылки:");
});
test("bot UTF-16 offsets work and invalid or insecure links are ignored",()=>{
  const text="📚 https://example.com/a";
  const offset=text.indexOf("https");
  expect(telegramBotLinks(text,[{type:"url",offset,length:text.length-offset}]))
    .toEqual(["https://example.com/a"]);
  expect(telegramBotLinks(text,[{type:"url",offset:999,length:100}])).toEqual([]);
  expect(telegramBotLinks(text,[{type:"text_link",offset:0,length:3,url:"http://bad.test"}])).toEqual([]);
  expect(validTelegramLinks(["https://x.test"])).toBe(true);
  expect(validTelegramLinks(["http://x.test"])).toBe(false);
  expect(validTelegramLinks(["https://x.test".repeat(1000)])).toBe(false);
  expect(validTelegramLinks(Array.from({length:11},(_,i)=>"https://x.test/"+i))).toBe(false);
});
