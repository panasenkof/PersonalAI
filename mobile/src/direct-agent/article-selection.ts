/** Stage 9A1: read-only, device-local shortlist of SAVED articles.
 * Only the explicitly supported intent is routed here. Later 9A/9B support
 * publication dates, arbitrary themes, all pages and verified full-text reads.
 */
import { countAllowedNotes, listAllowedNotes } from "../local-memory/agent-catalog";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import { withUnlockedTransaction } from "../local-memory/transaction";

export type SavedArticleIntent = {
  dateMode: "saved" | "published";
  topic: string;
  savedFrom: string;
  savedBefore: string;
  publicationFrom?: string;
  publicationBefore?: string;
  startLocal: string;
  endLocal: string;
  queryTerms: string[];
};

const AI_TERMS = ["ИИ", "AI", "искусственный интеллект", "нейросети", "нейросеть", "LLM"];
const ARTICLE_QUERY = /^\s*(?:выбери|подбери|найди|покажи)\s+(?:сохран[её]нн(?:ые|ых)\s+)?(?:статьи|статей|материалы|материалов)\s+(?:на\s+тему|про|об|о)\s+(.+?)\s+(за\s+последн(?:юю|ие)\s+(?:неделю|7\s+дней)|за\s+(?:неделю|7\s+дней)|(?:на|за|в)\s+этой\s+неделе)\s*[.!?]?\s*$/iu;
/** Publication intent must be explicit; saved-date queries keep the old route. */
const PUBLISHED_QUERY = /^\s*(?:выбери|подбери|найди|покажи)\s+(?:сохран[её]нн(?:ые|ых)\s+)?(?:статьи|статей|материалы|материалов)\s+(?:на\s+тему|про|об|о)\s+(.+?)\s*,?\s+(?:опубликованные|вышедшие)\s+(за\s+последн(?:юю|ие)\s+(?:неделю|7\s+дней)|за\s+(?:неделю|7\s+дней)|(?:на|за|в)\s+этой\s+неделе)\s*[.!?]?\s*$/iu;
const TOPIC_CHARS = /^[а-яёa-z0-9][а-яёa-z0-9\s+.#-]*$/iu;
const AI_TOPIC = /^(?:ии|ai|искусственный интеллект|нейросети|нейросеть|llm)$/iu;

/** Non-AI topics are literal FTS phrases, not claimed semantic expansions. */
function topicTerms(raw: string): {topic:string;queryTerms:string[]} | null {
  const topic=raw.trim().replace(/\s+/g," ");
  if(topic.length<2 || topic.length>70 || !TOPIC_CHARS.test(topic) ||
      topic.split(" ").length>7 || /(?:^|\s)(?:кроме|исключая|без|не|опубликованные|вышедшие)(?:\s|$)/iu.test(topic))
    return null;
  return AI_TOPIC.test(topic)
    ? {topic:"ai",queryTerms:AI_TERMS}
    : {topic,queryTerms:[topic]};
}
/** Continue a previous saved-time window, never reinterpret it using today's date. */
export function savedAiArticlePageIntent(page: {
  kind?:"saved_ai_links"|"saved_topic_links";
  dateMode?:"saved"|"published";
  topic?:string;queryTerms?:string[];
  savedFrom:string;savedBefore:string;startLocal:string;endLocal:string;
}): SavedArticleIntent {
  const terms=page.kind==="saved_topic_links" && page.topic && page.queryTerms
    ? {topic:page.topic,queryTerms:page.queryTerms}
    : {topic:"ai",queryTerms:AI_TERMS};
  const dateMode=page.dateMode==="published" ? "published" as const : "saved" as const;
  return {dateMode,...terms,...(dateMode==="published" ? {publicationFrom:page.startLocal,publicationBefore:localDay(new Date(Number(page.endLocal.slice(0,4)),Number(page.endLocal.slice(5,7))-1,Number(page.endLocal.slice(8,10))+1))} : {}),savedFrom:page.savedFrom,
    savedBefore:page.savedBefore,startLocal:page.startLocal,endLocal:page.endLocal};
}

const localDay = (d: Date) => `${String(d.getFullYear()).padStart(4,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

/** Explicit saved-date shortlist only; publication-date/web requests are NOT rerouted. */
export function savedAiArticleIntent(text: string, now = new Date(), hasAttachments = false): SavedArticleIntent | null {
  if(hasAttachments || text.length>500 || !Number.isFinite(now.getTime()))return null;
  const publishedMatch=PUBLISHED_QUERY.exec(text);
  const match=publishedMatch || ARTICLE_QUERY.exec(text);
  if(!match)return null;
  const topic=topicTerms(match[1]);
  if(!topic)return null;
  const period=match[2];
  let start:Date;
  const end=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  if(/^за\s+(?:последн(?:юю|ие)\s+)?(?:неделю|7\s+дней)$/iu.test(period)){
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-6);
  }else{
    const mondayOffset=(now.getDay()+6)%7;
    start=new Date(now.getFullYear(),now.getMonth(),now.getDate()-mondayOffset);
  }
  return {dateMode:publishedMatch ? "published" : "saved",...topic,
    ...(publishedMatch ? {publicationFrom:localDay(start),publicationBefore:localDay(end)} : {}),
    savedFrom:start.toISOString(),
    savedBefore:end.toISOString(),startLocal:localDay(start),
    endLocal:localDay(new Date(now.getFullYear(),now.getMonth(),now.getDate()))};
}

/** LLM tool input goes through the SAME finite intent parser and calendar rules as the
 * chat's free read-only article picker. Unsupported topics are rejected, never widened. */
export function savedArticleToolIntent(
  topic: unknown, period: unknown, dateMode: unknown, now = new Date(),
): SavedArticleIntent | null {
  if (typeof topic !== "string" || topic.trim().length < 2 || topic.length > 70 ||
      (period !== "last7days" && period !== "thisweek") ||
      (dateMode !== "saved" && dateMode !== "published")) return null;
  const phrase = "Найди статьи про " + topic.trim() +
    (dateMode === "published" ? ", опубликованные" : "") +
    (period === "thisweek" ? " на этой неделе" : " за последние 7 дней");
  return savedAiArticleIntent(phrase, now);
}

type ArticleDb = Parameters<typeof listAllowedNotes>[0];
export type SavedArticleShortlist = {
  count: number;
  records: Array<{id:string;version:number;title:string;section:string;createdAt:string;publicationDay?:string;duplicateCount?:number}>;
  unknownPublicationCount?: number;
  hasMore: boolean; nextCursor?: {beforeCreatedAt:string;beforeId:string}; scope: "standard_active_saved_links"; matchMode: "one_of_fts_phrases";
};

/** The count and first page share a single unlocked SQLCipher snapshot. */
export async function selectSavedAiArticles(profile: string, intent: SavedArticleIntent,
  db?: ArticleDb, cursor?: {beforeCreatedAt:string;beforeId:string}): Promise<SavedArticleShortlist> {
  if(intent.dateMode==="published" && (!intent.publicationFrom || !intent.publicationBefore))
    throw new Error("invalid_catalog_publication_window");
  const run = async (reader: ArticleDb): Promise<SavedArticleShortlist> => {
    const filters = { queryTerms:intent.queryTerms, linkedOnly:true, sortBySaved:true,
      ...(intent.dateMode==="published"
        ? {publicationFrom:intent.publicationFrom,publicationBefore:intent.publicationBefore}
        : {savedFrom:intent.savedFrom,savedBefore:intent.savedBefore}) };
    const counted = await countAllowedNotes(reader,filters);
    const page = await listAllowedNotes(reader,{...filters,...cursor,limit:8});
    const unknownPublicationCount=intent.dateMode==="published" ?
      (await countAllowedNotes(reader,{queryTerms:intent.queryTerms,linkedOnly:true,unknownPublicationOnly:true})).count : undefined;
    return { count:counted.count,records:page.records.map(({id,version,title,section,createdAt,publicationDay,duplicateCount})=>({
      id,version,title,section,createdAt,...(publicationDay ? {publicationDay} : {}),
      ...(duplicateCount !== undefined ? {duplicateCount} : {}),
    })),hasMore:page.hasMore,
      ...(unknownPublicationCount !== undefined ? {unknownPublicationCount} : {}),
      ...(page.nextCursor?.beforeCreatedAt ? {nextCursor:{
        beforeCreatedAt:page.nextCursor.beforeCreatedAt,beforeId:page.nextCursor.beforeId,
      }} : {}),scope:"standard_active_saved_links",matchMode:"one_of_fts_phrases" };
  };
  if(db) return run(db); // SQL test fixture only.
  let result!: SavedArticleShortlist;
  await withLocalMemoryDatabase(profile, native => withUnlockedTransaction(native, async tx => {
    result = await run(tx);
  }));
  return result;
}
