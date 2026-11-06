/** Stage 9A1: read-only, device-local shortlist of SAVED articles.
 * Only the explicitly supported intent is routed here. Later 9A/9B support
 * publication dates, arbitrary themes, all pages and verified full-text reads.
 */
import { countAllowedNotes, listAllowedNotes } from "../local-memory/agent-catalog";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import { withUnlockedTransaction } from "../local-memory/transaction";

export type SavedArticleIntent = {
  dateMode: "saved";
  topic: string;
  savedFrom: string;
  savedBefore: string;
  startLocal: string;
  endLocal: string;
  queryTerms: string[];
};

const AI_TERMS = ["ИИ", "AI", "искусственный интеллект", "нейросети", "нейросеть", "LLM"];
const ARTICLE_QUERY = /^\s*(?:выбери|подбери|найди|покажи)\s+(?:сохран[её]нн(?:ые|ых)\s+)?(?:статьи|статей|материалы|материалов)\s+(?:на\s+тему|про|об|о)\s+(.+?)\s+(за\s+последн(?:юю|ие)\s+(?:неделю|7\s+дней)|за\s+(?:неделю|7\s+дней)|(?:на|за|в)\s+этой\s+неделе)\s*[.!?]?\s*$/iu;
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
  topic?:string;queryTerms?:string[];
  savedFrom:string;savedBefore:string;startLocal:string;endLocal:string;
}): SavedArticleIntent {
  const terms=page.kind==="saved_topic_links" && page.topic && page.queryTerms
    ? {topic:page.topic,queryTerms:page.queryTerms}
    : {topic:"ai",queryTerms:AI_TERMS};
  return {dateMode:"saved",...terms,savedFrom:page.savedFrom,
    savedBefore:page.savedBefore,startLocal:page.startLocal,endLocal:page.endLocal};
}

const localDay = (d: Date) => `${String(d.getFullYear()).padStart(4,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

/** Explicit saved-date shortlist only; publication-date/web requests are NOT rerouted. */
export function savedAiArticleIntent(text: string, now = new Date(), hasAttachments = false): SavedArticleIntent | null {
  if(hasAttachments || text.length>500 || !Number.isFinite(now.getTime()))return null;
  const match=ARTICLE_QUERY.exec(text);
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
  return {dateMode:"saved",...topic,savedFrom:start.toISOString(),
    savedBefore:end.toISOString(),startLocal:localDay(start),
    endLocal:localDay(new Date(now.getFullYear(),now.getMonth(),now.getDate()))};
}

type ArticleDb = Parameters<typeof listAllowedNotes>[0];
export type SavedArticleShortlist = {
  count: number;
  records: Array<{id:string;version:number;title:string;section:string;createdAt:string}>;
  hasMore: boolean; nextCursor?: {beforeCreatedAt:string;beforeId:string}; scope: "standard_active_saved_links"; matchMode: "one_of_fts_phrases";
};

/** The count and first page share a single unlocked SQLCipher snapshot. */
export async function selectSavedAiArticles(profile: string, intent: SavedArticleIntent,
  db?: ArticleDb, cursor?: {beforeCreatedAt:string;beforeId:string}): Promise<SavedArticleShortlist> {
  const run = async (reader: ArticleDb): Promise<SavedArticleShortlist> => {
    const filters = { queryTerms:intent.queryTerms, savedFrom:intent.savedFrom,
      savedBefore:intent.savedBefore, linkedOnly:true, sortBySaved:true };
    const counted = await countAllowedNotes(reader,filters);
    const page = await listAllowedNotes(reader,{...filters,...cursor,limit:8});
    return { count:counted.count,records:page.records.map(({id,version,title,section,createdAt})=>({
      id,version,title,section,createdAt,
    })),hasMore:page.hasMore,
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
