import type { DirectAgentOptions } from "../engine";
import type { UsedNote } from "../context";
import type { MemorySnippet } from "../memory";
import type { ChatArticlePage, ChatMemoryRef } from "../conversations";
import type { ChatMoveProposal } from "../move-proposal";
import type { ChatSectionProposal } from "../section-actions";
import type { DuplicateCandidateGroup } from "../../local-memory/agent-catalog";
import type { VerifiedDuplicateMergeRequest } from "../duplicate-merge-gate";
import type { ContextCandidate } from "../conversation-context";
import type { SavedArticleIntent } from "../article-selection";
import { createArticleReadCoverage } from "../article-read-coverage";
import { createWebTools } from "../web-tools";
import { beginTask,recordEvidence } from "../task-state";
import type { TaskState,TaskEvidence } from "../task-state";
import { webPreference } from "../dialogue";

/** One independent, per-LLM-turn state. Nothing is cached across turns. */
export function createTurnState(options:DirectAgentOptions,sources:string[],
  notes:MemorySnippet[],initialUsed:UsedNote[]){
  const web = createWebTools(options, sources, notes);
  const used = new Map(initialUsed.map(n => [n.id, n]));
  // IDs/versions are admitted ONLY from verified current-turn memory readers.
  // The model cannot invent a record ID and submit it directly to a move tool.
  const moveHandles = new Map<string,number>();
  function admitMoveHandle(n:{id:string;version?:number}) {
    if(typeof n.id==="string" && /^[A-Za-z0-9:_-]{1,128}$/.test(n.id) &&
       Number.isSafeInteger(n.version) && (n.version??0)>0)
      moveHandles.set(n.id,n.version!);
  }
  notes.forEach(admitMoveHandle);
  let movePreview:ChatMoveProposal|undefined;
  const duplicateGroups:DuplicateCandidateGroup[]=[];
  let duplicateMergePreview:VerifiedDuplicateMergeRequest|undefined;
  let sectionPreview:ChatSectionProposal|undefined;
  let contextCandidate:ContextCandidate|undefined;
  let importTagsCandidate:string[]|undefined;
  // Derived from this turn's ACL/version-checked reads; NEVER persisted as source truth.
  const articleCoverage = createArticleReadCoverage();
  const readNotes = new Set<string>();
  // A model turn only keeps ACL-scoped handles returned by the existing local
  // visual search. The bytes/vectors never go into LLM tools or TaskState.
  const photoMatches: ChatMemoryRef[] = [];
  let photoRecovery: "model" | "import" | "prepare" | undefined;
  let photoLookups = 0;
  let state:TaskState = { ...beginTask(options.taskState, options.prompt), webPreference: webPreference(options) };
  const emit = () => { options.onTaskState?.(state); };
  const observe = (e: TaskEvidence) => { state = { ...recordEvidence(state, e), webPreference: state.webPreference }; emit(); };
  const fingerprint = (p: { title: string; body: string; section?: string; newSection?: string; kind?: string; person?: string; date?: string }) => JSON.stringify([p.title, p.body, p.section, p.newSection, p.kind, p.person, p.date]);
  const pending = new Map((options.pendingNotes || []).map(n => [fingerprint(n), n.id as string | undefined]));
  const proposalIds = new Set<string>();
  // 9T1: one request/turn uses a fixed local calendar anchor; never an extra agent runtime.
  const articleClock = new Date();
  let articlePages = 0;
  const articleRequests = new Set<string>();
  // Persist the same authorized filter+calendar window+cursor already used by
  // the no-LLM chat picker. The LLM cannot invent the next-page state.
  let persistedArticle: ChatArticlePage | undefined;
  let articleFilterKey: string | undefined;
  let mixedArticleFilters = false;
  let usedSelectedArticleTool = false;
  async function readArticleSelection(
    intent: SavedArticleIntent, cursor?: {beforeCreatedAt:string;beforeId:string},
  ): Promise<Record<string, unknown>> {
    const key = JSON.stringify([intent.topic,intent.dateMode,intent.savedFrom,intent.savedBefore,
      cursor?.beforeCreatedAt??null,cursor?.beforeId??null]);
    if (articleRequests.has(key)) return { error:"article_page_already_requested" };
    if (articlePages >= 3) return { error:"article_page_budget_exhausted",
      hint:"Попроси пользователя «Показать ещё»: исходные тема, даты и курсор сохранятся в диалоге." };
    articlePages++; articleRequests.add(key);
    options.status?.("Выбираю сохранённые статьи");
    const page = await options.selectArticles!(intent,cursor);
    if (page.scope!=="standard_active_saved_links" || !Array.isArray(page.records) ||
        !Number.isSafeInteger(page.count) || page.count<0 || typeof page.hasMore!=="boolean" ||
        (page.hasMore && !page.nextCursor)) return { error:"invalid_article_reader_result" };
    const filterKey=JSON.stringify([intent.topic,intent.dateMode,intent.savedFrom,intent.savedBefore]);
    if (articleFilterKey !== undefined && articleFilterKey !== filterKey) mixedArticleFilters=true;
    articleFilterKey=filterKey;
    if (!mixedArticleFilters) {
      persistedArticle={
        kind:intent.topic==="ai" ? "saved_ai_links" : "saved_topic_links",
        ...(intent.dateMode==="published" ? {dateMode:"published" as const} : {}),
        ...(intent.topic==="ai" ? {} : {topic:intent.topic,queryTerms:intent.queryTerms}),
        savedFrom:intent.savedFrom,savedBefore:intent.savedBefore,
        startLocal:intent.startLocal,endLocal:intent.endLocal,
        ...(page.nextCursor ? {nextCursor:page.nextCursor} : {}),
        selected:[...(persistedArticle && articleFilterKey===filterKey ? persistedArticle.selected||[] :
          options.articleContinuation && !persistedArticle &&
          JSON.stringify([options.articleContinuation.topic||"ai",
            options.articleContinuation.dateMode||"saved",
            options.articleContinuation.savedFrom,
            options.articleContinuation.savedBefore])===filterKey
            ? options.articleContinuation.selected||[] : []),
          ...page.records.map(n=>({id:n.id,version:n.version}))]
          .filter((n,i,all)=>all.findIndex(m=>m.id===n.id)===i).slice(-24),
      };
    } else persistedArticle=undefined;
    return {scope:page.scope,matchMode:page.matchMode,count:page.count,
      records:page.records.slice(0,8).map(n=>({
        id:n.id,version:n.version,title:n.title.slice(0,160),
        section:n.section.slice(0,80),createdAt:n.createdAt,
        ...(n.publicationDay ? {publicationDay:n.publicationDay} : {}),
        ...(n.duplicateCount!==undefined ? {duplicateCount:n.duplicateCount} : {}),
      })),
      hasMore:page.hasMore,...(page.nextCursor ? {nextCursor:page.nextCursor} : {}),
      ...(page.unknownPublicationCount!==undefined
        ? {unknownPublicationCount:page.unknownPublicationCount} : {}),
      selection:{topic:intent.topic,dateMode:intent.dateMode,fromLocal:intent.startLocal,
        throughLocal:intent.endLocal,dateEvidence:intent.dateMode==="published"
          ? "html_meta_source_claim" : "local_save_time"},
      contentIncluded:false};
  }

  // Selection handles are already persisted by the encrypted conversation writer.
  // Never accept a record ID supplied by the model for selection-specific tools.
  const selectedArticleHandles = () => {
    const selected=persistedArticle ? (persistedArticle.selected||[]) :
      (options.articleSelection?.selected||[]);
    if(!selected.length || selected.length>24 || selected.some(n=>!n ||
        !/^[A-Za-z0-9:_-]{1,128}$/.test(n.id) ||
        !Number.isSafeInteger(n.version) || n.version<1 ||
        selected.filter(m=>m.id===n.id).length!==1)) return undefined;
    return selected;
  };
  // Both batch selection and later chunks use the SAME canonical versioned reader
  // and evidence contract. A chunk at the end is NOT proof earlier chunks were read.
  const verifiedSelectedArticleRead = async (
    handle:{id:string;version:number}, offset:number, budget:number,
  ) => {
    if(options.signal?.aborted)throw new Error("aborted");
    const result=await options.read!(handle.id,handle.version,offset,budget);
    if(options.signal?.aborted)throw new Error("aborted");
    const evidence=result.evidence as Record<string,unknown>|undefined;
    const content=result.content, total=result.totalChars;
    const end=typeof content==="string" ? offset+content.length : -1;
    if(result.id!==handle.id || result.revision!==handle.version ||
        typeof result.title!=="string" || typeof content!=="string" ||
        !Number.isSafeInteger(total) || Number(total)<0 ||
        !Number.isSafeInteger(result.offset) || result.offset!==offset ||
        offset>Number(total) || content.length>budget || end>Number(total) ||
        (content.length===0 && Number(total)>0) ||
        typeof result.hasMore!=="boolean" ||
        result.hasMore!==(end<Number(total)) ||
        (result.hasMore && (result.nextOffset!==end || end===offset)) ||
        !evidence || evidence.recordId!==handle.id ||
        evidence.recordVersion!==handle.version ||
        evidence.startChar!==offset || evidence.endChar!==end ||
        (evidence.coverage!=="complete"&&evidence.coverage!=="excerpt"))
      throw new Error("invalid_article_read_evidence");
    // Narrow unknown fields only AFTER the complete source/evidence contract passed.
    const verified = result as typeof result & {
      id:string;revision:number;title:string;content:string;offset:number;
      totalChars:number;hasMore:boolean;nextOffset?:number;
      evidence:Record<string,unknown>;
    };
    articleCoverage.record(handle,{offset:verified.offset,content:verified.content,
      totalChars:verified.totalChars,hasMore:verified.hasMore,title:verified.title});
    return verified;
  };
  return {
    web,used,moveHandles,admitMoveHandle,duplicateGroups,articleCoverage,readNotes,
    photoMatches,emit,observe,fingerprint,pending,proposalIds,
    articleClock,articleRequests,readArticleSelection,selectedArticleHandles,verifiedSelectedArticleRead,
    get duplicateMergePreview(){return duplicateMergePreview;},
    set duplicateMergePreview(v:VerifiedDuplicateMergeRequest|undefined){duplicateMergePreview=v;},
    get movePreview(){return movePreview;},
    set movePreview(v:ChatMoveProposal|undefined){movePreview=v;},
    get sectionPreview(){return sectionPreview;},
    set sectionPreview(v:ChatSectionProposal|undefined){sectionPreview=v;},
    get contextCandidate(){return contextCandidate;},
    set contextCandidate(v:ContextCandidate|undefined){contextCandidate=v;},
    get importTagsCandidate(){return importTagsCandidate;},
    set importTagsCandidate(v:string[]|undefined){importTagsCandidate=v;},
    get photoRecovery(){return photoRecovery;},
    set photoRecovery(v:"model"|"import"|"prepare"|undefined){photoRecovery=v;},
    get photoLookups(){return photoLookups;},
    set photoLookups(v:number){photoLookups=v;},
    get state(){return state;},
    set state(v:TaskState){state=v;},
    get articlePages(){return articlePages;},
    set articlePages(v:number){articlePages=v;},
    get persistedArticle(){return persistedArticle;},
    set persistedArticle(v:ChatArticlePage|undefined){persistedArticle=v;},
    get articleFilterKey(){return articleFilterKey;},
    set articleFilterKey(v:string|undefined){articleFilterKey=v;},
    get mixedArticleFilters(){return mixedArticleFilters;},
    set mixedArticleFilters(v:boolean){mixedArticleFilters=v;},
    get usedSelectedArticleTool(){return usedSelectedArticleTool;},
    set usedSelectedArticleTool(v:boolean){usedSelectedArticleTool=v;},
  };
}
