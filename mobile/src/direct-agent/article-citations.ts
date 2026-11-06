import type { ChatArticleReadReport } from "./conversations";

/** Model-side notation is never an authorization. A click becomes possible only
 * for one bounded range actually delivered by the canonical note reader in
 * this assistant turn. Numbers are UTF-16 offsets in the saved note text. */
export const ARTICLE_CITATION_GUIDE =
  "При выжимке выбранных сохранённых статей ставь после каждого фактического вывода " +
  "ссылку вида [[S1:0-250]]: S1 — первый элемент выбранной подборки, 0-250 — " +
  "точный диапазон startChar-endChar из фактически прочитанного evidence. " +
  "Для другого материала используй S2, S3 и так далее; диапазоны не угадывай, " +
  "не ссылайся на unread, устаревшие, пустые и link-only материалы. " +
  "Если не нашлось проверенного прочитанного диапазона, прямо укажи, что вывод без источника. " +
  "Ссылка подтверждает только чтение диапазона сохранённой заметки, не проверку " +
  "содержания вывода и не чтение оригинальной веб-страницы. ";

export type ArticleCitationPointer = {
  index:number; startChar:number; endChar:number;
};
export type ResolvedArticleCitation = ArticleCitationPointer & {
  id:string;version:number;title:string;
};

export const ARTICLE_CITATION_RE = /\[\[S([0-9]{1,2}):([0-9]{1,7})-([0-9]{1,7})\]\]/g;

export function resolveArticleCitation(
  report:ChatArticleReadReport | undefined, citation:ArticleCitationPointer,
):ResolvedArticleCitation | null {
  if(!report || !Number.isSafeInteger(citation.index) ||
      citation.index<1 || citation.index>report.selectedCount ||
      !Number.isSafeInteger(citation.startChar) ||
      !Number.isSafeInteger(citation.endChar) ||
      citation.startChar<0 || citation.endChar<=citation.startChar)
    return null;
  const entry=report.entries[citation.index-1];
  if(!entry || entry.selectedIndex!==citation.index-1 ||
    (entry.status!=="complete_saved_note_text" &&
     entry.status!=="partial_saved_note") ||
    !entry.ranges || !entry.ranges.some(range=>
      range.startChar<=citation.startChar && range.endChar>=citation.endChar))
    return null;
  return { ...citation,id:entry.id,version:entry.version,
    title:entry.title || "Материал без названия" };
}

/** Used only for a neutral provenance hint; not a factual verifier.
 * Invalid markers stay unlinked, never open a model-invented note ID. */
export function articleCitationCounts(text:string,report:ChatArticleReadReport){
  let valid=0,invalid=0;
  for(const match of text.matchAll(ARTICLE_CITATION_RE)) {
    const citation={index:Number(match[1]),startChar:Number(match[2]),
      endChar:Number(match[3])};
    if(resolveArticleCitation(report,citation))valid++;
    else invalid++;
  }
  return {valid,invalid};
}
