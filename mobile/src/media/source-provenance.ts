import { sharedLinkPreview } from "./messenger-share-links";
import { publicImportUrl } from "./link-import";

/** Source evidence in the canonical note payload; not an upstream revision ID. */
export type SourceCoverage =
  "url_only" | "telegram_post_text_only" | "web_text_unverified" | "file_downloaded";
export type SourceProvenanceInput = {
  sourceUrl?: unknown; coverage?: unknown; sourceRef?: unknown;
  publicationDate?: unknown; publicationEvidence?: unknown;
  publicationAttribute?: unknown;
};
export type SourceProvenance = {
  title: string; details: string; url?: string; publication?: string;
};

export function validSourceCoverage(coverage: unknown): coverage is SourceCoverage {
  return coverage === "url_only" || coverage === "telegram_post_text_only" ||
    coverage === "web_text_unverified" || coverage === "file_downloaded";
}
function validPublication(date: unknown, evidence: unknown, attribute: unknown): date is string {
  if (typeof date !== "string" || evidence !== "html_meta" ||
    !["article:published_time","datePublished"].includes(String(attribute))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number(match[1]) >= 1000 &&
    d.getUTCFullYear() === Number(match[1]) &&
    d.getUTCMonth() === Number(match[2]) - 1 &&
    d.getUTCDate() === Number(match[3]);
}

/** One read-only interpretation for draft and saved notes, using ONLY the
 * canonical source_url / source_* fields already present in SQLCipher.
 * A Telegram link is never proof of author, publication date or revision. */
export function describeSourceProvenance(input: SourceProvenanceInput): SourceProvenance | null {
  let url: string | undefined;
  if (typeof input.sourceUrl === "string") {
    try { url = publicImportUrl(input.sourceUrl); } catch { /* Invalid old source is not an external link. */ }
  }
  if (!url) return input.sourceRef === "android-share" ? {
    title: "Источник · Android Share",
    details: "Материал передан через системное меню «Поделиться». Отправившее приложение, автор, дата и версия публикации не подтверждены.",
  } : null;

  const preview = sharedLinkPreview({shareType:"url",value:url});
  const platform = preview?.platform === "telegram" ? "Telegram" :
    preview?.platform === "max" ? "MAX" : "Веб-ссылка";
  const coverage = validSourceCoverage(input.coverage) ? input.coverage : undefined;
  const verifiedPostText = coverage === "telegram_post_text_only" &&
    preview?.platform === "telegram" && preview.kind === "public_post_candidate";
  const details = verifiedPostText ?
    "Прочитан текст именно этого публичного поста Telegram. Фото, видео, другие вложения, автор, дата и версия не подтверждены." :
    coverage === "file_downloaded" ?
      "Файл скачан по этому адресу. Автор, дата и версия материала не подтверждены." :
    coverage === "web_text_unverified" ?
      "Извлечён доступный текст страницы. Полнота, автор и версия не подтверждены." :
    coverage === "url_only" ?
      (preview?.platform === "telegram" && preview.kind === "public_post_candidate"
        ? "Формат публичного поста. Доступность и автор не проверены. Сохранится только ссылка."
        : preview?.platform === "max"
          ? "Сохранится только ссылка. Это не подтверждённый текст публикации."
          : "Сохранится только ссылка. Содержание сайта не получено.") :
    "Сохранён URL источника. Доказательств чтения его содержимого в этой записи нет.";
  // HTML page-level dates are never used for a particular Telegram message.
  const publication = preview?.platform !== "telegram" &&
    validPublication(input.publicationDate,input.publicationEvidence,input.publicationAttribute)
      ? "Дата по метаданным сайта: " + input.publicationDate +
        " (заявление сайта, независимо не подтверждено)." : undefined;
  return {
    title: coverage === "url_only" ? "Ссылка · без текста страницы" :
      coverage === "telegram_post_text_only" && verifiedPostText ?
        "Источник · текст публичного поста" :
      coverage === "web_text_unverified" ? "Источник · текст страницы" :
      coverage === "file_downloaded" ? "Источник · скачанный файл" :
        "Источник · ссылка",
    details: platform + " · " + details,
    url,
    ...(publication ? {publication} : {}),
  };
}
