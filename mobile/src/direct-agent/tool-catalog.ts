import type { DirectAgentOptions, DirectResult } from "./engine";
import { usedNotes } from "./context";
import type { UsedNote } from "./context";
import type { MemorySnippet } from "./memory";
import { FACT_TOOL_NAME, FACT_TOOL_DESCRIPTION, factToolParameters, factProposal } from "./fact-tool";
import { createWebTools } from "./web-tools";
import { beginTask, recordEvidence, TASK_STATE_TOOL, updateTaskInterpretation } from "./task-state";
import type { TaskEvidence, ToolOutcome } from "./task-state";
import { webPreference } from "./dialogue";
import { savedArticleToolIntent, savedAiArticlePageIntent } from "./article-selection";
import type { SavedArticleIntent } from "./article-selection";
import type { ChatArticlePage } from "./conversations";

export type ToolDefinition = { name: string; description: string; parameters: object };
export type ToolSpec = {
  definition: ToolDefinition;
  effect: "read" | "proposal" | "conversation";
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  verify(result: Record<string, unknown>): ToolOutcome | "state_updated";
};
const queryParameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const text = (v: unknown, cap = 600) => typeof v === "string" ? v.slice(0, cap) : "";

/** All provider adapters advertise and execute the same catalog. No dynamic code loading. */
export function createToolCatalog(options: DirectAgentOptions, sources: string[], notes: MemorySnippet[], initialUsed: UsedNote[]) {
  const web = createWebTools(options, sources, notes);
  const used = new Map(initialUsed.map(n => [n.id, n]));
  const readNotes = new Set<string>();
  let state = { ...beginTask(options.taskState, options.prompt), webPreference: webPreference(options) };
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
  const specs: ToolSpec[] = [
    { definition: { name: "search_local_notes", description: "Найти заметки на телефоне по 1–3 ключевым словам. Найденный фрагмент не является полным чтением записи.", parameters: queryParameters }, effect: "read",
      execute: async args => {
        const query = text(args.query, 120).trim();
        if (query.length < 2) return { error: "invalid_search_query" };
        options.status?.("Поиск в памяти телефона");
        const found = await options.lookup(query);
        if (!Array.isArray(found) || found.some(n => !n || typeof n.id !== "string" || typeof n.body !== "string")) return { error: "invalid_memory_result" };
        for (const n of usedNotes(found, "assistant")) used.set(n.id, n);
        web.addNotes(found);
        options.diagnostic?.("memory.tool_search", { queryChars: query.length, found: found.length, noteIds: found.map(n => n.id), excerptCount: found.filter(n => n.excerptOnly).length }, { query });
        return { notes: found };
      }, verify: r => Array.isArray(r.notes) ? r.notes.length ? "found" : "empty" : "failed" },
    ...(options.read ? [{
      definition: { name: "read_local_note", description: "Дочитать разрешённую заметку по id/version из поиска или каталога. Полный текст НЕ ограничен начальным контекстом 24 000 символов. Читай до hasMore=false с offset=nextOffset; если бюджет вызовов кончился, явно говори о частичном охвате. Каждый вызов максимум 6000 символов; версия/ACL проверяются заново.", parameters: {
        type: "object", properties: { id: { type: "string" }, version: { type: "integer" },
          offset: { type: ["integer", "null"] }, budget: { type: ["integer", "null"], maximum: 6000 } },
        required: ["id", "version", "offset", "budget"], additionalProperties: false,
      } },
      effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        const id = text(args.id, 128);
        const version = args.version;
        const offset = args.offset ?? 0;
        const budget = args.budget ?? 4000;
        if (!id || !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 ||
            !Number.isSafeInteger(budget) || Number(budget) < 1 || Number(budget) > 6000)
          return { error: "invalid_memory_read_request" };
        const result = await options.read!(id, Number(version), Number(offset), Number(budget));
        // A successful ACL+revision-checked read is actual source use, even if
        // the note was first discovered through a metadata catalogue.
        if (result.id===id && result.revision===Number(version) &&
            typeof result.content==="string" && typeof result.title==="string") {
          used.set(id,{id,title:result.title.slice(0,160),via:"assistant"});
          readNotes.add(id);
        }
        return result;
      },
      verify: (r: Record<string, unknown>) => typeof r.content === "string" &&
        typeof r.revision === "number" && typeof r.hasMore === "boolean" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.searchSources ? [{
      definition: { name: "search_local_source_segments",
        description: "Искать точную последовательность 1–3 ключевых слов внутри распознанных вложений. При hasMore=true передать nextOffset как offset для следующей страницы ТОГО ЖЕ query. Разрешённые активные заметки и короткие превью, не весь документ; страница/таймкод только по данным обработчика.",
        parameters: { type: "object", properties: {
          query: { type: "string" }, limit: { type: ["integer","null"] },
          offset: { type: ["integer","null"] },
        }, required: ["query","limit","offset"], additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const limit = args.limit ?? 8;
        const offset = args.offset ?? 0;
        if (query.length < 2 || query.length > 120 ||
            !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 2_000_000) {
          return { error: "invalid_source_search_request" };
        }
        return options.searchSources!(query, Number(limit), Number(offset));
      },
      verify: (r: Record<string,unknown>) => Array.isArray(r.segments) &&
        r.scope === "standard_active_notes" &&
        r.matchMode === "exact_fts_phrase" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.listSources ? [{
      definition: { name: "list_local_sources",
        description: "Получить только названия источников, короткие превью и координаты извлечённых фрагментов конкретной ранее найденной заметки по id/version. Список не является полным текстом; указанная обработчиком страница/время не проверены независимо по оригиналу.",
        parameters: { type: "object", properties: {
          id: { type: "string" }, version: { type: "integer" }, limit: { type: ["integer","null"] },
        }, required: ["id","version","limit"], additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const id = text(args.id, 128);
        const version = args.version, limit = args.limit ?? 15;
        if (!id || !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 30) {
          return { error: "invalid_source_list_request" };
        }
        return options.listSources!(id, Number(version), Number(limit));
      },
      verify: (r: Record<string, unknown>) => Array.isArray(r.segments) &&
        r.metadataOnly === true && r.scope === "standard_active_notes" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.readSource ? [{
      definition: { name: "read_local_source_segment",
        description: "Читать ограниченный текст одного сегмента конкретного вложения. Использовать только идентификаторы из list_local_sources, в той же версии записи. Повторно проверяет права и исходник. Координаты имеют уровень producer_reported, а unknown не является страницей/таймкодом.",
        parameters: { type: "object", properties: {
          id: { type: "string" }, version: { type: "integer" },
          attachmentId: { type: "string" }, extractionId: { type: "string" },
          segmentId: { type: "string" }, offset: { type: ["integer","null"] },
          budget: { type: ["integer","null"] },
        }, required: ["id","version","attachmentId","extractionId","segmentId","offset","budget"],
        additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const id = text(args.id, 128);
        const attachmentId = text(args.attachmentId, 128);
        const extractionId = text(args.extractionId, 128);
        const segmentId = text(args.segmentId, 128);
        const version = args.version, offset = args.offset ?? 0, budget = args.budget ?? 3000;
        if (!id || !attachmentId || !extractionId || !segmentId ||
            !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 6000 ||
            !Number.isSafeInteger(budget) || Number(budget) < 1 || Number(budget) > 4000) {
          return { error: "invalid_source_read_request" };
        }
        return options.readSource!(id, Number(version), attachmentId, extractionId, segmentId,
          Number(offset), Number(budget));
      },
      verify: (r: Record<string, unknown>) => typeof r.content === "string" &&
        typeof r.hasMore === "boolean" && r.sourceCheck === "part_manifest_revision" &&
        r.locationConfidence === "producer_reported" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.list ? [{
      definition: { name: "list_local_notes", description: "Постраничный список метаданных только разрешённых активных заметок. Не является полным чтением. Поиск query означает точную FTS-фразу, не семантическое совпадение.", parameters: {
        type: "object", properties: { query: { type: ["string", "null"] }, collectionId: { type: ["string", "null"] },
          limit: { type: ["integer", "null"] }, beforeUpdatedAt: { type: ["string", "null"] }, beforeId: { type: ["string", "null"] } },
        required: ["query","collectionId","limit","beforeUpdatedAt","beforeId"], additionalProperties: false,
      } }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        const opts = {
          ...(typeof args.collectionId === "string" ? { collectionId: args.collectionId } : {}),
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.beforeUpdatedAt === "string" ? { beforeUpdatedAt: args.beforeUpdatedAt } : {}),
          ...(typeof args.beforeId === "string" ? { beforeId: args.beforeId } : {}),
        };
        if (Object.keys(args).some(key => !["query","collectionId","limit","beforeUpdatedAt","beforeId"].includes(key) ||
          (args[key] !== null && !(key in opts)))) return { error: "invalid_catalog_arguments" };
        return options.list!(opts);
      },
      verify: (r: Record<string, unknown>) => Array.isArray(r.records) &&
        typeof r.hasMore === "boolean" && r.contentIncluded === false ? "read" as const : "failed" as const,
    }] : []),
    ...(options.count ? [{
      definition: { name: "count_local_notes", description: "Точное количество заметок только в разрешённом scope. query = exact FTS phrase, не все смысловые совпадения.", parameters: {
        type: "object", properties: { query: { type: ["string", "null"] }, collectionId: { type: ["string", "null"] } },
        required: ["query","collectionId"], additionalProperties: false,
      } }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        if (Object.keys(args).some(key => !["query","collectionId"].includes(key)) ||
            (args.query != null && typeof args.query !== "string") ||
            (args.collectionId != null && typeof args.collectionId !== "string")) {
          return { error: "invalid_catalog_arguments" };
        }
        return options.count!({
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.collectionId === "string" ? { collectionId: args.collectionId } : {}),
        });
      },
      verify: (r: Record<string, unknown>) => typeof r.count === "number" &&
        r.scope === "standard_active_notes" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.selectArticles ? [{
      definition: { name: "select_local_articles",
        description: "Постранично выбрать СОХРАНЁННЫЕ ссылки на статьи по теме и календарной неделе из разрешённых стандартных заметок. Дата по умолчанию — сохранение; published = только дата, указанная самим сайтом, не независимо проверенная. Результат — МЕТАДАННЫЕ, не прочитанный текст. Для выжимки дочитай read_local_note по id/version. Не путай count с числом прочитанных материалов. Максимум 3 страницы за сообщение.",
        parameters: { type: "object", properties: {
          topic: { type: "string" },
          period: { type: "string", enum: ["last7days", "thisweek"] },
          dateMode: { type: "string", enum: ["saved", "published"] },
          beforeCreatedAt: { type: ["string", "null"] },
          beforeId: { type: ["string", "null"] },
        }, required: ["topic", "period", "dateMode", "beforeCreatedAt", "beforeId"],
        additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        if (Object.keys(args).length !== 5 ||
            Object.keys(args).some(key => !["topic","period","dateMode","beforeCreatedAt","beforeId"].includes(key)))
          return { error: "invalid_article_tool_arguments" };
        const intent = savedArticleToolIntent(args.topic, args.period, args.dateMode, articleClock);
        if (!intent) return { error: "invalid_article_tool_arguments" };
        const t = args.beforeCreatedAt, id = args.beforeId;
        if (!((t === null && id === null) ||
          (typeof t === "string" && t.length === 24 &&
            Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t &&
            typeof id === "string" && id.length > 0 && id.length <= 128)))
          return { error: "invalid_article_cursor" };
        return readArticleSelection(intent,id===null?undefined:{beforeCreatedAt:t as string,beforeId:id as string});
      },
      verify: (r: Record<string, unknown>) => r.scope === "standard_active_saved_links" &&
        r.matchMode === "one_of_fts_phrases" && r.contentIncluded === false &&
        Number.isSafeInteger(r.count) && Array.isArray(r.records) && typeof r.hasMore === "boolean"
        ? (r.records as unknown[]).length ? "found" as const : "empty" as const : "failed" as const,
    }] : []),
    ...(options.selectArticles && options.articleContinuation?.nextCursor ? [{
      definition: {name:"continue_local_articles",
        description:"Продолжить прежнюю сохранённую подборку статей: ИСХОДНАЯ тема, режим дат и зафиксированное календарное окно из зашифрованного диалога. Не пересчитывать неделю и не начинать с первой страницы. Только метаданные, полный текст дочитывать отдельно.",
        parameters:{type:"object",properties:{},required:[],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if (Object.keys(args).length) return {error:"invalid_article_tool_arguments"};
        const previous=options.articleContinuation!;
        return readArticleSelection(savedAiArticlePageIntent(previous),previous.nextCursor);
      },
      verify:(r:Record<string,unknown>)=>r.scope==="standard_active_saved_links" &&
        r.contentIncluded===false && Array.isArray(r.records) &&
        typeof r.hasMore==="boolean" ? (r.records as unknown[]).length
        ? "found" as const : "empty" as const : "failed" as const,
    }] : []),
    { definition: { name: FACT_TOOL_NAME, description: FACT_TOOL_DESCRIPTION, parameters: factToolParameters(options.sections) }, effect: "proposal",
      execute: async args => {
        const proposal = factProposal(args, options.sections);
        const key = fingerprint(proposal);
        if (pending.has(key) && pending.get(key)) proposalIds.add(pending.get(key)!);
        if (pending.has(key)) return { status: "awaiting_user_confirmation", saved: false, duplicate: true, ...(pending.get(key) ? { proposalId: pending.get(key) } : {}) };
        const proposalId = options.propose(proposal);
        pending.set(key, proposalId || undefined);
        if (proposalId) proposalIds.add(proposalId);
        options.diagnostic?.("memory.tool_draft", { name: FACT_TOOL_NAME });
        return { status: "awaiting_user_confirmation", saved: false, ...(proposalId ? { proposalId } : {}) };
      }, verify: r => r.status === "awaiting_user_confirmation" && r.saved === false ? "pending_confirmation" : "failed" },
    { definition: TASK_STATE_TOOL, effect: "conversation", execute: async args => {
        state = { ...updateTaskInterpretation(state, args), webPreference: state.webPreference }; emit();
        return { status: "state_updated", personalMemorySaved: false };
      }, verify: r => r.status === "state_updated" ? "state_updated" : "failed" },
    ...web.definitions.map((definition): ToolSpec => ({ definition, effect: "read", execute: args => web.run(definition.name, args) as Promise<Record<string, unknown>>,
      verify: r => definition.name === "search_web"
        ? Array.isArray(r.sources) && typeof r.context === "string" ? r.sources.length ? "found" : "empty" : "failed"
        : typeof r.content === "string" && r.content.trim() && typeof r.url === "string" ? "read" : "failed" })),
  ];
  const registry = new Map(specs.map(s => [s.definition.name, s]));
  emit();
  if (notes.length) observe({ tool: "search_local_notes", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: JSON.stringify(notes.map(n => ({ id: n.id, title: n.title }))).slice(0, 600) });
  if (sources.length) observe({ tool: "search_web", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: sources.join("\n").slice(0, 600) });
  async function run(name: string, raw: unknown): Promise<Record<string, unknown>> {
    if (options.signal?.aborted) throw new Error("Запрос остановлен");
    const canonical = name === "draft_local_note" ? FACT_TOOL_NAME : name;
    const spec = registry.get(canonical);
    options.diagnostic?.("llm.tool_requested", { name, argumentsChars: JSON.stringify(raw)?.length || 0 }, { arguments: JSON.stringify(raw) || "" });
    let result: Record<string, unknown>, outcome: ToolOutcome | "state_updated" = "failed";
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    try {
      if (!spec) result = { error: "tool_not_allowed" };
      else if (!args) result = { error: "invalid_tool_args" };
      else {
        result = await spec.execute(args);
        if (options.signal?.aborted) throw new Error("Запрос остановлен");
        outcome = "error" in result ? "failed" : spec.verify(result);
        if (outcome === "failed" && !("error" in result)) result = { error: "invalid_tool_result" };
      }
    } catch {
      if (options.signal?.aborted) throw new Error("Запрос остановлен");
      result = { error: "tool_failed_or_unavailable" };
    }
    if (outcome !== "state_updated") observe({ tool: canonical, outcome,
      subject: text(result.proposalId || args?.url || args?.query || args?.title || name),
      excerpt: outcome === "read" ? text(result.content) : outcome === "found" && canonical === "search_web" ? text((result.sources as string[]).join("\n")) : text(JSON.stringify(result)) });
    options.diagnostic?.("tool.outcome_verified", { name: canonical, effect: spec?.effect || "unknown", outcome });
    return { ...result, ...(outcome !== "failed" ? { outcome } : {}) };
  }
  function finish(): Pick<DirectResult, "taskState" | "proposalIds" | "articlePage"> {
    state = { ...state, turnStatus: "answered" }; emit();
    return { taskState: state, proposalIds: [...proposalIds],
      ...(persistedArticle ? {articlePage:persistedArticle} : {}) };
  }
  const observeSources = (urls: string[]) => { if (urls.length) observe({ tool: "web_search", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: urls.join("\n").slice(0, 600) }); };
  return { definitions: specs.map(s => s.definition), run, finish, observeSources,
    memory: () => {
      const read=[...readNotes].reverse().flatMap(id=>used.has(id)?[used.get(id)!]:[]);
      return [...read,...[...used.values()].filter(item=>!readNotes.has(item.id))].slice(0,8);
    } };
}
