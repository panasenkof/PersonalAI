import {verifiedTelegramMessageMarkup} from "../telegram-post";
import {articleText} from "../link-import";

const target='<div class="tgme_widget_message js-widget_message" data-post="public_news/42">'+
  '<div class="tgme_widget_message_author">Может быть имя канала</div>'+
  '<div class="tgme_widget_message_text js-message_text"><b>Нужная статья</b>'+
  '<br>Первый абзац о научном открытии и подробностях.</div>'+
  '<div class="tgme_widget_message_photo_wrap" style="background-image:url(x)"></div>'+
  '</div>';
const neighbour='<div data-post="public_news/43" class="tgme_widget_message">'+
  '<div class="tgme_widget_message_text">Чужая следующая статья</div></div>';
const preceding='<div class="tgme_widget_message" data-post="public_news/41">'+
  '<div class="tgme_widget_message_text">Соседняя старая статья</div></div>';
const feed='<html><head><meta property="article:published_time" content="2026-01-01"/>'+
  '</head><body><nav>Реклама канала</nav>'+preceding+target+neighbour+'</body></html>';

test("MSG-1: exact public Telegram post is isolated from surrounding channel text and metadata",()=>{
  const matched=verifiedTelegramMessageMarkup("https://t.me/s/public_news/42",feed);
  expect(matched).toMatchObject({messageKey:"public_news/42",
    title:"Telegram · public_news/42",mediaMayBeMissing:true});
  const result=articleText("<article>"+matched.textHtml+"</article>");
  expect(result.text).toContain("Нужная статья");
  expect(result.text).toContain("Первый абзац");
  expect(result.text).not.toMatch(/Соседняя|Чужая|Реклама|Может быть имя канала|2026/);
});
test.each([
  "https://t.me/public_news/42",
  "https://public_news.t.me/42",
  "https://telegram.me/public_news/42?single",
])("MSG-1: different official public permalink syntaxes verify the same post identity",link=>{
  expect(verifiedTelegramMessageMarkup(link,feed).messageKey).toBe("public_news/42");
});

test("MSG-1: surrounding fake data-post strings in scripts or comments cannot pass",()=>{
  const forged='<script><div class="tgme_widget_message" data-post="public_news/42">'+
    '<div class="tgme_widget_message_text">Подделка</div></div></script>'+
    '<!-- <div class="tgme_widget_message" data-post="public_news/42">подмена</div> -->'+neighbour;
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",forged))
    .toThrow(/не найдено именно это сообщение/);
});
test("MSG-1: duplicated target and malformed/truncated target fail closed",()=>{
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",target+target))
    .toThrow(/не найдено именно это сообщение/);
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",
    '<div class="tgme_widget_message" data-post="public_news/42"><div>Нет закрытия'))
    .toThrow(/не найдено именно это сообщение/);
});
test("MSG-1: a media-only post must not borrow the text of the next post",()=>{
  const mediaOnly='<div class="tgme_widget_message" data-post="public_news/42">'+
    '<div class="tgme_widget_message_photo_wrap"></div></div>'+neighbour;
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",mediaOnly))
    .toThrow(/нет доступного текста/);
});
test("MSG-1: a post with multiple candidate text fields fails rather than assembling an unrelated claim",()=>{
  const ambiguous='<div class="tgme_widget_message" data-post="public_news/42">'+
    '<div class="tgme_widget_message_text">Пост А</div>'+
    '<div class="tgme_widget_message_text">Пост Б</div></div>';
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",ambiguous))
    .toThrow(/нет доступного текста/);
});
test.each(["https://t.me/c/123/42","https://max.ru/channel_news",
  "https://t.me/public_news/43"])("MSG-1: wrong source or ID %s cannot authorize requested post extraction",link=>{
  expect(()=>verifiedTelegramMessageMarkup(link,target)).toThrow();
});
test("MSG-1: post identity is case-insensitive, irrelevant metadata cannot change scope",()=>{
  expect(verifiedTelegramMessageMarkup("https://t.me/s/Public_News/42",target).messageKey)
    .toBe("Public_News/42");
});
test("MSG-1: unsupported oversized HTML cannot consume unbounded parser resources",()=>{
  expect(()=>verifiedTelegramMessageMarkup("https://t.me/public_news/42",
    "x".repeat(1_048_577))).toThrow(/публичная ссылка/);
});
