import {sharedLinkPreview} from "../messenger-share-links";

test.each([
  ["https://t.me/public_ch/123",{platform:"telegram",kind:"public_post_candidate",canFetch:true}],
  ["https://t.me/s/public_ch/123",{platform:"telegram",kind:"public_post_candidate",canFetch:true}],
  ["https://public_ch.t.me/123",{platform:"telegram",kind:"public_post_candidate",canFetch:true}],
  ["https://telegram.me/public_ch/123?single",{platform:"telegram",kind:"public_post_candidate",canFetch:true}],
  ["https://t.me/public_ch",{platform:"telegram",kind:"link_only",canFetch:false}],
  ["https://t.me/c/1200121/55",{platform:"telegram",kind:"restricted",canFetch:false}],
  ["https://t.me/+inviteToken",{platform:"telegram",kind:"restricted",canFetch:false}],
  ["https://t.me/joinchat/secret",{platform:"telegram",kind:"restricted",canFetch:false}],
  ["https://max.ru/channel_test",{platform:"max",kind:"link_only",canFetch:false}],
  ["https://max.ru/join/secret",{platform:"max",kind:"restricted",canFetch:false}],
  ["https://web.max.ru/-12345",{platform:"max",kind:"link_only",canFetch:false}],
])("MSG-0: %s is URL-form classified, NEVER proof of page access", (value, expected)=>{
  expect(sharedLinkPreview({shareType:"url",value})).toMatchObject(expected);
});

test("MSG-1: caption + exactly one public Telegram link has same source identity; user text is untouched",()=>{
  const payload={shareType:"text",value:"Нужно сохранить для завтра!\nhttps://t.me/public_ch/123?single"};
  const parsed=sharedLinkPreview(payload);
  expect(parsed).toMatchObject({platform:"telegram",kind:"public_post_candidate",
    url:"https://t.me/public_ch/123?single",canFetch:true});
  expect(payload.value).toContain("Нужно сохранить для завтра!");
});

test.each([
  "Ссылка без HTTPS",
  "tg://resolve?domain=public_ch&post=55",
  "https://t.me/public_ch/123\nhttps://max.ru/channel_test",
  "Вот личная пометка https://t.me/public_ch/123 и https://example.com",
  "https://t.me.evil.com/public_ch/123",
  "https://evil.com/t.me/public_ch/123",
  "https://127.0.0.1/private",
  "https://[::1]/private",
  "https://user:pass@t.me/public_ch/123",
  "https://t.me:444/public_ch/123",
  "http://t.me/public_ch/123",
])("MSG-0: untrusted Share text %s must not be auto-assigned Telegram provenance",value=>{
  const result=sharedLinkPreview({shareType:"text",value});
  expect(result?.platform).not.toBe("telegram");
});
test("MSG-0: several URLs are ambiguous even if first is eligible",()=>{
  expect(sharedLinkPreview({shareType:"url",
    value:"https://t.me/public_ch/12 https://t.me/public_ch/13"})).toBeNull();
});
test("MSG-0: private invite URL is never a remotely fetched post",()=>{
  for(const value of ["https://t.me/c/123/55","https://max.ru/joinchannel/xyz"]){
    expect(sharedLinkPreview({shareType:"text",value})?.canFetch).toBe(false);
  }
});
test("MSG-0: general HTTPS URLs shared explicitly still use current generic importer",()=>{
  expect(sharedLinkPreview({shareType:"url",value:"https://example.org/page"}))
    .toMatchObject({platform:"web",kind:"link_only",canFetch:true});
  expect(sharedLinkPreview({shareType:"text",value:"Read https://example.org/page"}))
    .toBeNull();
});
test("MSG-0: malformed, oversize and file shares never trigger URL parsing",()=>{
  expect(sharedLinkPreview({shareType:"file",value:"content://x"})).toBeNull();
  expect(sharedLinkPreview({shareType:"text",value:"a".repeat(60001)})).toBeNull();
  expect(sharedLinkPreview({shareType:"url",value:"https://t.me/"})).toMatchObject({
    kind:"link_only",canFetch:false,
  });
});
