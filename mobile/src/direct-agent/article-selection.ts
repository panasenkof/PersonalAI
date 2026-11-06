/** Stage 9A1: read-only, device-local shortlist of SAVED articles.
 * Only the explicitly supported intent is routed here. Later 9A/9B support
 * publication dates, arbitrary themes, all pages and verified full-text reads.
 */
import { countAllowedNotes, listAllowedNotes } from "../local-memory/agent-catalog";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import { withUnlockedTransaction } from "../local-memory/transaction";

export type SavedArticleIntent = {
  dateMode: "saved";
  topic: "ai";
  savedFrom: string;
  savedBefore: string;
  startLocal: string;
  endLocal: string;
  queryTerms: string[];
};

const AI_TERMS = ["ИИ", "AI", "искусственный интеллект", "нейросети", "нейросеть", "LLM"];
const localDay = (d: Date) => `${String(d.getFullYear()).padStart(4,"0")}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

/** Exclude publication-date requests: e.created_at is a SAVE timestamp. */
export function savedAiArticleIntent(text: string, now = new Date(), hasAttachments = false): SavedArticleIntent | null {
  // Regex word-boundary \\b is ASCII-centric; explicit whitespace is safer for Russian.
  if (hasAttachments || text.length > 500 ||
      !/^\s*(?:выбери|подбери|найди|покажи)(?:\s|[,:])/iu.test(text)) return null;
  if (!/(?:стат(?:ьи|ей|ью|ья|ей)|материал(?:ы|ов)?)/iu.test(text)) return null;
  if (!/(?:^|[^а-яёa-z\d])(?:ии|ai|искусственн[а-яё]* интеллект[а-яё]*|нейросет[а-яё]*)(?=$|[^а-яёa-z\d])/iu.test(text)) return null;
  if (/(?:опубликован|вышедш|публикаци|в интернете|в сети|онлайн|добавь из интернета|из интернета)/iu.test(text)) return null;
  if (!Number.isFinite(now.getTime())) return null;
  let start: Date;
  const end = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  if (/за последн(?:юю|ие) (?:неделю|7 дней)|за (?:неделю|7 дней)/iu.test(text)) {
    start = new Date(now.getFullYear(),now.getMonth(),now.getDate()-6);
  } else if (/(?:на|за|в) этой неделе/iu.test(text)) {
    const mondayOffset = (now.getDay()+6)%7;
    start = new Date(now.getFullYear(),now.getMonth(),now.getDate()-mondayOffset);
  } else return null;
  return { dateMode:"saved",topic:"ai",savedFrom:start.toISOString(),
    savedBefore:end.toISOString(),startLocal:localDay(start),
    endLocal:localDay(new Date(now.getFullYear(),now.getMonth(),now.getDate())),
    queryTerms:AI_TERMS };
}

type ArticleDb = Parameters<typeof listAllowedNotes>[0];
export type SavedArticleShortlist = {
  count: number;
  records: Array<{id:string;version:number;title:string;section:string;createdAt:string}>;
  hasMore: boolean; scope: "standard_active_saved_links"; matchMode: "one_of_fts_phrases";
};

/** The count and first page share a single unlocked SQLCipher snapshot. */
export async function selectSavedAiArticles(profile: string, intent: SavedArticleIntent,
  db?: ArticleDb): Promise<SavedArticleShortlist> {
  const run = async (reader: ArticleDb): Promise<SavedArticleShortlist> => {
    const filters = { queryTerms:intent.queryTerms, savedFrom:intent.savedFrom,
      savedBefore:intent.savedBefore, linkedOnly:true };
    const counted = await countAllowedNotes(reader,filters);
    const page = await listAllowedNotes(reader,{...filters,limit:8});
    return { count:counted.count,records:page.records.map(({id,version,title,section,createdAt})=>({
      id,version,title,section,createdAt,
    })),hasMore:page.hasMore,scope:"standard_active_saved_links",matchMode:"one_of_fts_phrases" };
  };
  if(db) return run(db); // SQL test fixture only.
  let result!: SavedArticleShortlist;
  await withLocalMemoryDatabase(profile, native => withUnlockedTransaction(native, async tx => {
    result = await run(tx);
  }));
  return result;
}
