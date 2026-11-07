import { describeSourceProvenance, validSourceCoverage, validTelegramTextObservation } from "../source-provenance";

test("source card: URL-only Telegram is syntactic, never a verified post",()=>{
  const source=describeSourceProvenance({
    sourceUrl:"https://t.me/public_news/123",coverage:"url_only",
    sourceRef:"android-share",
  });
  expect(source).toMatchObject({title:"Ссылка · без текста страницы",
    url:"https://t.me/public_news/123"});
  expect(source?.details).toContain("Формат публичного поста");
  expect(source?.details).toContain("не проверены");
  expect(source?.publication).toBeUndefined();
});

test("source card: exact Telegram text claims neither media nor post date/author/version",()=>{
  const source=describeSourceProvenance({
    sourceUrl:"https://t.me/s/public_news/123",coverage:"telegram_post_text_only",
    publicationDate:"2026-11-07",publicationEvidence:"html_meta",
    publicationAttribute:"article:published_time",
  });
  expect(source?.title).toBe("Источник · текст публичного поста");
  expect(source?.details).toContain("именно этого публичного поста");
  expect(source?.details).toContain("Фото, видео, другие вложения, автор, дата и версия не подтверждены");
  expect(source?.publication).toBeUndefined();
});

test("source card: verified text flag on a generic site or MAX is NOT a Telegram proof",()=>{
  for (const url of ["https://example.org/article","https://max.ru/channel"]) {
    const source=describeSourceProvenance({
      sourceUrl:url,coverage:"telegram_post_text_only",
    });
    expect(source?.details).toContain("Доказательств чтения");
    expect(source?.title).toBe("Источник · ссылка");
  }
});

test("source card: generic HTML date is only the website's unverified metadata claim",()=>{
  const source=describeSourceProvenance({
    sourceUrl:"https://example.org/article",coverage:"web_text_unverified",
    publicationDate:"2026-11-07",publicationEvidence:"html_meta",
    publicationAttribute:"datePublished",
  });
  expect(source).toMatchObject({
    title:"Источник · текст страницы",
    publication:expect.stringContaining("2026-11-07"),
  });
  expect(source?.publication).toContain("независимо не подтверждено");
  expect(source?.details).toContain("Полнота");
});

test("source card: invalid dates, forged or partial evidence never show publication time",()=>{
  for (const entry of [
    {date:"2026-02-30",ev:"html_meta",attr:"datePublished"},
    {date:"2026-11-07",ev:"guessed",attr:"datePublished"},
    {date:"2026-11-07",ev:"html_meta",attr:"updated_time"},
  ]) {
    expect(describeSourceProvenance({sourceUrl:"https://example.org/article",
      publicationDate:entry.date,publicationEvidence:entry.ev,
      publicationAttribute:entry.attr,
    })?.publication).toBeUndefined();
  }
});

test("source card: an ordinary download only claims downloaded bytes; no extracted HTML",()=>{
  const source=describeSourceProvenance({sourceUrl:"https://example.org/sound.mp3",coverage:"file_downloaded"});
  expect(source?.title).toBe("Источник · скачанный файл");
  expect(source?.details).toContain("Файл скачан");
  expect(source?.details).not.toContain("Извлечён");
});

test("source card: old notes preserve UNKNOWN evidence, not silently upgraded on reopen",()=>{
  const source=describeSourceProvenance({sourceUrl:"https://t.me/public_news/123"});
  expect(source?.title).toBe("Источник · ссылка");
  expect(source?.details).toContain("Доказательств чтения");
  expect(source?.publication).toBeUndefined();
  expect(validSourceCoverage("full_content_verified")).toBe(false);
});

test("source card: Android Share file/text without URL never claims sender app",()=>{
  const source=describeSourceProvenance({sourceRef:"android-share"});
  expect(source?.title).toBe("Источник · Android Share");
  expect(source?.details).toContain("Отправившее приложение");
  expect(source?.url).toBeUndefined();
  expect(describeSourceProvenance({sourceRef:"device-import"})).toBeNull();
});

test("source card: private/invalid/untrusted URLs are never external buttons",()=>{
  for (const raw of ["http://example.org/a","https://127.0.0.1/","https://example.local/a",
    "file:///data/secret","https://user:pw@example.org/"]) {
    expect(describeSourceProvenance({sourceUrl:raw})).toBeNull();
  }
});

test("MSG-6.C: verified HTML data-post observation labels ID and local snapshot, never Telegram revision",()=>{
  const observation={messageKey:"public_news/123",
    textSha256:"a".repeat(64),textLength:24,
    evidence:"telegram_html_data_post_v1" as const};
  const url="https://t.me/public_news/123";
  expect(validTelegramTextObservation(url,"telegram_post_text_only",observation)).toBe(true);
  const card=describeSourceProvenance({sourceUrl:url,coverage:"telegram_post_text_only",observation});
  expect(card?.details).toContain("ID сообщения по data-post: public_news/123");
  expect(card?.details).toContain("Отпечаток полученного текста SHA-256: aaaaaaaaaaaa");
  expect(card?.details).toContain("не версия Telegram");
});
test("MSG-6.C: URL syntax, other message or unverified body cannot impersonate HTML observation",()=>{
  const observation={messageKey:"public_news/123",textSha256:"b".repeat(64),
    textLength:12,evidence:"telegram_html_data_post_v1" as const};
  for(const [url,coverage,obs] of [
    ["https://t.me/public_news/123","url_only",observation],
    ["https://t.me/public_news/124","telegram_post_text_only",observation],
    ["https://example.org/story","telegram_post_text_only",observation],
    ["https://t.me/public_news/123","telegram_post_text_only",{...observation,textSha256:"wrong"}],
    ["https://t.me/public_news/123","telegram_post_text_only",{...observation,evidence:"guessed"}],
    ["https://t.me/public_news/123","telegram_post_text_only",{...observation,textLength:60001}],
  ] as const){
    expect(validTelegramTextObservation(url,coverage,obs)).toBe(false);
    const card=describeSourceProvenance({sourceUrl:url,coverage,observation:obs});
    expect(card?.details).not.toContain("ID сообщения по data-post");
  }
  expect(describeSourceProvenance({sourceUrl:"https://t.me/public_news/123",
    coverage:"telegram_post_text_only"})?.details).not.toContain("Отпечаток");
});
