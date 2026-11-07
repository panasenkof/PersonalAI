import { fetch as nativeFetch } from 'expo/fetch';
import { File, Directory, Paths, FileMode } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { mediaKind, type ImportFile } from './kinds';
import { sharedLinkPreview } from './messenger-share-links';
import { verifiedTelegramMessageMarkup } from './telegram-post';

export function publicImportUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); }
  catch { throw new Error('Введите полный адрес публичной HTTPS-ссылки.'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.') ||
      host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') ||
      /^[\d.]+$/.test(host) || host.includes(':')) throw new Error('Нужна публичная HTTPS-ссылка без логина и пароля.');
  return u.toString();
}
/** Do not pass raw native network errors to memoryErrorMessage: it describes
 * a failed import as a damaged/locked SQLite database and hides the cause.
 * Only app-authored, safe messages may be shown (no signed URLs or headers).
 */
export function linkImportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[А-ЯЁ]/u.test(message) && message.length <= 500 && !/[a-f0-9]{64}/i.test(message)) return message;
  return 'Не удалось загрузить ссылку: сетевая ошибка или ограничения сайта. Проверьте соединение, доступность адреса в браузере и попробуйте другой публичный файл.';
}

/** Only safe status codes and fixed explanations are exposed to the UI. */
export function linkHttpError(status: number): string {
  if (status === 401 || status === 403) return "Доступ к материалу закрыт (HTTP " + status + "). Возможно, требуется вход на сайт. Сохраните ссылку без текста.";
  if (status === 404 || status === 410) return "Материал по адресу не найден (HTTP " + status + "). Проверьте ссылку или сохраните её без текста.";
  if (status === 408 || status === 504) return "Сайт не ответил вовремя (HTTP " + status + "). Повторите загрузку позже или сохраните ссылку.";
  if (status === 413) return "Сайт отклонил большой файл (HTTP 413). Сохраните ссылку без файла.";
  if (status === 429) return "Сайт временно ограничил загрузки (HTTP 429). Повторите позже.";
  if (status >= 500 && status <= 599) return "Ошибка на стороне сайта (HTTP " + status + "). Повторите позже или сохраните ссылку.";
  return "Сайт отказал в загрузке (HTTP " + status + "). Проверьте доступ в браузере или сохраните ссылку.";
}

/** HTML is untrusted text, never executed. All output stays bounded by importLink.
 * The lightweight token walk is shared by preview and persistence; it preserves
 * text/list/table order while skipping nested page chrome. No DOM/WebView/LLM.
 */
function htmlEntities(text: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", laquo: "«", raquo: "»",
    mdash: "—", ndash: "–", hellip: "…", bull: "•", thinsp: " ", copy: "©",
    frac12: "½", frac14: "¼", frac34: "¾", times: "×", deg: "°", rsquo: "’", lsquo: "‘",
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (entity, value: string) => {
    if (value.startsWith("#")) {
      const n = value[1].toLowerCase() === "x" ? parseInt(value.slice(2), 16) : parseInt(value.slice(1), 10);
      return Number.isSafeInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
        ? String.fromCodePoint(n) : "";
    }
    return named[value.toLowerCase()] ?? entity;
  });
}
type HtmlCandidate = { tag: "article" | "main"; parts: string[]; active: boolean };
type HtmlNode = { tag: string; suppressed: boolean; candidate?: HtmlCandidate; listIndex?: number; cells?: number };
export type ArticleText = { text: string; title?: string; partial: boolean; scope: "article" | "main" | "fallback" };
function cleanArticleText(parts: string[]): string {
  return parts.join("").replace(/\r/g, "").replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n").trim();
}
const BLOCK_TAG = /^(article|main|section|div|p|h[1-6]|ul|ol|li|blockquote|tr|table|pre)$/;
const VOID_TAG = /^(br|hr|img|input|meta|link|source|wbr|area|base)$/;
export function articleText(html: string): ArticleText {
  // Strip raw script/style content first; otherwise "<" inside scripts can
  // masquerade as markup or break the lightweight tokenizer.
  const safe = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const stack: HtmlNode[] = [], candidates: HtmlCandidate[] = [], all: string[] = [];
  const emit = (text: string) => {
    all.push(text);
    for (const candidate of candidates) if (candidate.active) candidate.parts.push(text);
  };
  const hidden = (tag: string, attrs: string, withinArticle: boolean) =>
    /^(nav|footer|aside|form|title|button|select|textarea|input|meta|link|canvas)$/.test(tag) ||
    (tag === "header" && !withinArticle) ||
    /\s(?:hidden\b|aria-hidden\s*=\s*["']?true\b)/i.test(attrs) ||
    /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attrs) ||
    /^(div|section|ul|ol)$/.test(tag) && /\b(?:id|class)\s*=\s*["'][^"']*(?:cookie|advert|ads-|banner|sidebar|breadcrumb|newsletter|popup|subscribe|social|related-posts|recommend|navigation|masthead|comments)[^"']*["']/i.test(attrs);
  const tokens = safe.match(/<\/?[a-z][^>]*>|[^<]+|</gi) || [];
  for (const token of tokens) {
    if (token[0] !== "<" || token === "<") {
      if (!stack.some(node => node.suppressed)) emit(htmlEntities(token));
      continue;
    }
    const match = /^<(\/?)\s*([a-z][a-z0-9:-]*)\b/i.exec(token);
    if (!match) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.map(node => node.tag).lastIndexOf(tag);
      if (index < 0) continue; // A malformed unmatched closing tag is harmless.
      for (const node of stack.splice(index).reverse()) {
        if (!node.suppressed && BLOCK_TAG.test(node.tag)) emit("\n");
        if (node.candidate) node.candidate.active = false;
      }
      continue;
    }
    const attrs = token.slice(match[0].length, token.length - 1);
    const parentHidden = stack.some(node => node.suppressed);
    const withinArticle = stack.some(node => node.tag === "article" && !node.suppressed);
    const suppressed = parentHidden || hidden(tag, attrs, withinArticle);
    const node: HtmlNode = { tag, suppressed };
    if (!suppressed) {
      if (tag === "article" || tag === "main") {
        const candidate: HtmlCandidate = { tag, parts: [], active: true };
        node.candidate = candidate; candidates.push(candidate);
      }
      if (tag === "li") {
        const list = [...stack].reverse().find(item => item.tag === "ol" || item.tag === "ul");
        if (list?.tag === "ol") { list.listIndex = (list.listIndex || 0) + 1; emit("\n" + list.listIndex + ". "); }
        else emit("\n• ");
      } else if (tag === "td" || tag === "th") {
        const row = [...stack].reverse().find(item => item.tag === "tr");
        if (row) { emit((row.cells || 0) ? " | " : ""); row.cells = (row.cells || 0) + 1; }
      } else if (tag === "br" || tag === "hr" || BLOCK_TAG.test(tag)) emit("\n");
      if (tag === "ol") {
        const start = /\bstart\s*=\s*["']?(\d+)/i.exec(attrs);
        node.listIndex = start ? Math.max(0, Number(start[1]) - 1) : 0;
      }
      if (tag === "tr") node.cells = 0;
    }
    if (!VOID_TAG.test(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  const best = (tag: "article" | "main") => candidates
    .filter(item => item.tag === tag).map(item => ({ candidate: item, text: cleanArticleText(item.parts) }))
    .filter(item => item.text.length >= 24).sort((a, b) => b.text.length - a.text.length)[0];
  const selected = best("article") || best("main");
  const text = selected?.text || cleanArticleText(all);
  // Extract a title only when the heading is part of the selected content.
  const h1 = /<h1\b[^>]*>([\s\S]{0,600}?)<\/h1\s*>/i.exec(safe);
  const heading = h1 && htmlEntities(h1[1].replace(/<[^>]*>/g, "")).trim();
  const documentTitle = /<title\b[^>]*>([\s\S]{0,600}?)<\/title\s*>/i.exec(html);
  const rawTitle = documentTitle && htmlEntities(documentTitle[1].replace(/<[^>]*>/g, "")).trim();
  const title = (heading && text.includes(heading) ? heading : rawTitle || "")?.slice(0, 160) || undefined;
  // A closed <article> does not prove the network response included the full
  // article; this flag only indicates a concrete incomplete markup signal.
  const partial = selected ? selected.candidate.active :
    /<body\b/i.test(html) && !/<\/body\s*>/i.test(html);
  return { text, title, partial, scope: selected?.candidate.tag || "fallback" };
}

/** A source-asserted publication DAY, not an independently verified event date.
 * Only explicit <meta> attributes are considered. Conflicts/ambiguous dates are
 * unknown, so the saved timestamp is never silently substituted.
 */
export type HtmlPublicationClaim = { date: string; evidence: "html_meta"; sourceAttribute: "article:published_time" | "datePublished" };
export function htmlPublicationClaim(html: string): HtmlPublicationClaim | undefined {
  const values: HtmlPublicationClaim[]=[];
  const head=/<head\b[^>]*>([\s\S]{0,100000}?)<\/head\s*>/i.exec(html)?.[1] || "";
  const safeHead=head.replace(/<!--[\s\S]*?-->/g,"").replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"");
  const tags=safeHead.match(/<meta\b[^>]{0,2000}>/gi) || [];
  for(const tag of tags.slice(0,150)) {
    const attributes=new Map<string,string>();
    const pattern=/([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]{0,250})"|'([^']{0,250})')/gi;
    let match:RegExpExecArray|null;
    while((match=pattern.exec(tag)))attributes.set(match[1].toLowerCase(),htmlEntities(match[2]??match[3]));
    const name=(attributes.get("property")||attributes.get("name")||"").toLowerCase();
    if(name!=="article:published_time" && name!=="datepublished")continue;
    const raw=(attributes.get("content")||"").trim();
    // Explicit ISO calendar day or ISO datetime with timezone. Never accept
    // locale-dependent Date.parse or timezone-less timestamps.
    const matchDay=/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/i.exec(raw);
    if(!matchDay || (raw.includes("T") && !Number.isFinite(Date.parse(raw)))) return undefined;
    const [year,month,day]=matchDay[1].split("-").map(Number);
    const exact=new Date(Date.UTC(year,month-1,day));
    if(year<1000 || exact.getUTCFullYear()!==year || exact.getUTCMonth()!==month-1 || exact.getUTCDate()!==day)
      return undefined;
    values.push({date:matchDay[1],evidence:"html_meta",sourceAttribute:name==="datepublished"?"datePublished":"article:published_time"});
  }
  if(!values.length || values.some(v=>v.date!==values[0].date))return undefined;
  return values[0];
}

/** Backwards-compatible text-only entry point for existing callers/tests. */
export function pageText(html: string): string {
  return articleText(html).text;
}

/** An access gate or client-rendered shell is not successful extraction. */
export function articleReadError(html: string, result: ArticleText): string | null {
  const substantive = result.scope === "article" && result.text.length >= 200;
  if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html) && !substantive)
    return "Страница требует входа. Содержимое не получено — сохраните ссылку без текста.";
  if (!result.text.trim() || result.text.length < 12 && /<body\b/i.test(html))
    return "Страница не содержит читаемого текста (возможно, загружает статью через JavaScript). Сохраните ссылку без текста.";
  return null;
}

/** Explicit user action only; no cookies/keys; streaming bound before allocation. */
export async function importLink(raw: string, signal?: AbortSignal): Promise<{ file?: ImportFile; text?: string; source: string; title?: string; partial?: boolean;
  textCoverage?: "telegram_post_text_only"; publicationClaim?: HtmlPublicationClaim }> {
  const source = publicImportUrl(raw);
  // Source identity is URL-form only; the HTML must independently identify
  // the EXACT Telegram message. Generic page text is not post evidence.
  const messenger=sharedLinkPreview({shareType:'url',value:source});
  const telegramMessage=messenger?.platform==='telegram' &&
    messenger.kind==='public_post_candidate';
  // Standard t.me/<channel>/<post> can be a landing page. The documented
  // public /s/ view is the ONLY fixed, same-service alternate reader URL;
  // never follow arbitrary HTTP redirects or user-controlled hostnames.
  const readerUrl=telegramMessage&&messenger?.messageKey
    ? "https://t.me/s/"+messenger.messageKey
    : source;
  const controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel);
  const timer = setTimeout(cancel, 60_000);
  let file: File | undefined;
  let stage: 'соединение' | 'получение ответа' | 'чтение файла' | 'обработка содержимого' = 'соединение';
  try {
    if (signal?.aborted) throw new Error('Загрузка отменена.');
    // Deliberately reject HTTP redirects: native URL following could reach a
    // private host or send a user-selected URL to an unexpected endpoint.
    // Do not add cookies, Referer spoofing or site-specific VPN workarounds.
    const response = await nativeFetch(readerUrl, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
    stage = 'получение ответа';
    if (response.status >= 300 && response.status < 400 || response.status === 0)
      throw new Error('Сайт перенаправляет запрос на другой адрес. Автоматические перенаправления для импорта отключены.');
    if (!response.ok) throw new Error(linkHttpError(response.status));
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const looksLikeMediaFile = /\.(mp3|m4a|wav|ogg|flac|aac|mp4|mov|webm|mkv)$/i.test(new URL(source).pathname);
    if (looksLikeMediaFile && (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/plain'))
      throw new Error('Вместо медиафайла сайт вернул страницу или текст. Возможна проверка VPN, авторизация или недействительная прямая ссылка.');
    const html = mime === 'text/html' || mime === 'application/xhtml+xml';
    if(telegramMessage && !html)
      throw new Error('Telegram не вернул HTML нужного публичного сообщения. Сохраните только ссылку или передайте оригинал через «Поделиться».');
    const text = html || mime.startsWith('text/') || mime === 'application/json';
    const limit = text ? 1024 * 1024 : 80 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Слишком большой материал по ссылке.');
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() || 'download');
    if (!text) mediaKind({ uri: source, name, mimeType: mime });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Сервис не вернул содержимое.');
    const dir = new Directory(Paths.cache, 'persai-incoming'); dir.create({ intermediates: true, idempotent: true });
    file = new File(dir, Crypto.randomUUID()); file.create();
    stage = 'чтение файла';
    const handle = file.open(FileMode.WriteOnly); let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.length;
        if (total > limit || controller.signal.aborted) throw new Error('Загрузка остановлена или материал слишком большой.');
        handle.writeBytes(value);
      }
    } finally { handle.close(); await reader.cancel().catch(() => {}); }
    if (controller.signal.aborted) throw new Error('Загрузка отменена.');
    if (!total) throw new Error('Материал пуст.');
    if (text) {
      stage = 'обработка содержимого';
      const rawText = await file.text();
      const telegram=telegramMessage ? verifiedTelegramMessageMarkup(source,rawText) : null;
      // The text renderer is the SAME canonical articleText as before, but
      // restricted to one verified Telegram message subtree, not whole feed.
      const page = telegram ? articleText('<article>'+telegram.textHtml+'</article>') :
        html ? articleText(rawText) : null;
      if (page) {
        const failure = articleReadError(rawText, page);
        if (failure) throw new Error(failure);
      }
      const content = page ? page.text : rawText;
      if (!content.trim() || content.length > 60_000) throw new Error('Текст пуст или длиннее 60 000 символов. Сохраните нужный фрагмент вручную.');
      // Page-level metadata must never be attributed to an individual
      // Telegram post. No guessed source author/date. Media in the post is
      // NOT downloaded; public HTML extraction is always partial coverage.
      const publicationClaim=html && !telegram ? htmlPublicationClaim(rawText) : undefined;
      file.delete(); return { text: content, source,
        ...(telegram ? {title:telegram.title,partial:true,
          textCoverage:"telegram_post_text_only" as const} :
          {...(page?.title ? { title: page.title } : {}),
           ...(page ? { partial: page.partial } : {})}),
        ...(publicationClaim ? {publicationClaim} : {}) };
    }
    return { file: { uri: file.uri, name, mimeType: mime }, source };
  } catch (error) {
    if (file?.exists) file.delete();
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'Загрузка отменена.' : 'Загрузка превысила 60 секунд и была остановлена.');
    const safe = linkImportErrorMessage(error);
    if (safe !== linkImportErrorMessage(null)) throw new Error(safe);
    throw new Error('Не удалось загрузить ссылку (этап: ' + stage + '). Возможно, сайт блокирует запрос, перенаправляет его или произошла сетевая ошибка.');
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
