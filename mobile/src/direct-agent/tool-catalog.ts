import type { DirectAgentOptions, DirectResult } from "./engine";
import { usedNotes } from "./context";
import type { UsedNote } from "./context";
import type { MemorySnippet } from "./memory";
import { FACT_TOOL_NAME, FACT_TOOL_DESCRIPTION, factToolParameters, factProposal } from "./fact-tool";
import { createWebTools } from "./web-tools";
import { beginTask, recordEvidence, TASK_STATE_TOOL, updateTaskInterpretation,
  WORKSPACE_MAX_ENTRIES, WORKSPACE_ENTRY_MAX_CHARS } from "./task-state";
import type { TaskWorkspaceEntry } from "./task-state";
import type { TaskEvidence, ToolOutcome } from "./task-state";
import { webPreference } from "./dialogue";
import { savedArticleToolIntent, savedAiArticlePageIntent } from "./article-selection";
import type { SavedArticleIntent } from "./article-selection";
import type { ChatArticlePage, ChatMemoryRef } from "./conversations";
import { validMoveProposal, type ChatMoveProposal } from "./move-proposal";
import { validSectionProposal, type ChatSectionProposal } from "./section-actions";
import { createArticleReadCoverage } from "./article-read-coverage";
import { validateContextCandidate, type ContextCandidate } from "./conversation-context";
import { checkedNoteTags } from "../local-memory/note-tags";

export type ToolDefinition = { name: string; description: string; parameters: object };
export type ToolSpec = {
  definition: ToolDefinition;
  effect: "read" | "proposal" | "conversation";
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  verify(result: Record<string, unknown>): ToolOutcome | "state_updated";
};
const queryParameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const text = (v: unknown, cap = 600) => typeof v === "string" ? v.slice(0, cap) : "";
const SECTION_TOOL_ERRORS = new Set([
  "application_locked","invalid_section_action_args","section_parent_unavailable",
  "section_parent_changed","section_sibling_name_exists","section_delete_protected_or_missing",
  "section_has_children","section_not_empty","collection_not_empty","collection_delete_protected",
  "stale_collection",
]);
const sectionToolError = (error:unknown) => {
  const code=error instanceof Error ? error.message : "";
  return SECTION_TOOL_ERRORS.has(code) ? code : "section_action_unavailable";
};


/** All provider adapters advertise and execute the same catalog. No dynamic code loading. */
export function createToolCatalog(options: DirectAgentOptions, sources: string[], notes: MemorySnippet[], initialUsed: UsedNote[]) {
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
  const contextTool:ToolSpec = { definition:{name:"set_conversation_context",
      description:"Определить или исправить ТЕМУ и РАЗДЕЛ текущего диалога — не переносит, не сохраняет и не читает записи памяти. Вызывай при первой содержательной теме и при явном изменении темы/раздела, включая запрос пользователя исправить классификацию. Не вызывай из-за короткого уточнения. Раздел — только существующий slug; если не уверен, null. При закреплённом разделе менять можно только тему. Приложение покажет изменение в конце ответа ПОСЛЕ успешного сохранения истории, не повторяй статус в тексте.",
      parameters:{type:"object",properties:{
        topic:{type:"string",minLength:2,maxLength:80,description:"Короткое содержательное название темы на языке пользователя."},
        sectionSlug:{type:["string","null"],description:"Точный slug уже существующей коллекции: "+(options.sections||[]).map(s=>s.slug+"="+s.name).join("; ")+". null при отсутствии основания."},
        reason:{type:"string",minLength:2,maxLength:180,description:"Одно короткое основание по текущему пользовательскому сообщению или реально прочитанным вложениям."},
      },required:["topic","sectionSlug","reason"],additionalProperties:false},
    },effect:"conversation",
    execute:async args=>{
      if(contextCandidate)return {error:"conversation_context_already_proposed_this_turn"};
      const checked=validateContextCandidate(args,options.sections||[],options.context);
      if("error" in checked)return {error:checked.error};
      contextCandidate=checked.candidate;
      return {status:"pending_conversation_commit",saved:false,sectionSlug:contextCandidate.sectionSlug,topic:contextCandidate.topic,
        memoryRecordChanged:false};
    },verify:r=>r.status==="pending_conversation_commit"&&r.saved===false?"pending_confirmation":"failed" };
  // The restricted import-only proposal reuses THIS agent/catalog and the
  // canonical note-tags validator. No metadata writer or second classifier.
  const importMetadataTool:ToolSpec = { definition:{
    name:"propose_import_metadata",
    description:"Предложить существующий раздел, тему и до 5 тематических тегов только по предоставленному читаемому тексту. При сомнении sectionSlug=null и tags=[]. Это предложение, не запись.",
    parameters:{type:"object",properties:{
      topic:{type:"string",minLength:2,maxLength:80},
      sectionSlug:{type:["string","null"],description:"Slug только разрешённого раздела из: "+(options.sections||[]).map(s=>s.slug+"="+s.name).join("; ")+"; либо null."},
      reason:{type:"string",minLength:2,maxLength:180},
      tags:{type:"array",items:{type:"string",minLength:1,maxLength:32},maxItems:5,
        description:"0–5 точных смысловых тегов на русском, без # и пробелов. Только из действительно прочитанного содержания."},
    },required:["topic","sectionSlug","reason","tags"],additionalProperties:false},
  },effect:"proposal",execute:async args=>{
    if(contextCandidate || importTagsCandidate!==undefined)return {error:"import_metadata_already_proposed"};
    if(!Array.isArray(args.tags)||args.tags.length>5)return {error:"invalid_import_tags"};
    const {topic,sectionSlug,reason}=args;
    const checked=validateContextCandidate({topic,sectionSlug,reason},options.sections||[],options.context);
    if("error" in checked)return {error:checked.error};
    let tags:string[];
    try { tags=checkedNoteTags(args.tags); } catch { return {error:"invalid_import_tags"}; }
    contextCandidate=checked.candidate;
    importTagsCandidate=tags;
    return {status:"pending_import_save",saved:false,sectionSlug:contextCandidate.sectionSlug,tags};
  },verify:r=>r.status==="pending_import_save"&&r.saved===false?"pending_confirmation":"failed"};
  const specs: ToolSpec[] = [
    ...(options.contextClassificationEnabled ? [contextTool] : []),
    { definition: { name: "search_local_notes", description: "Найти заметки на телефоне по 1–3 ключевым словам. Найденный фрагмент не является полным чтением записи.", parameters: queryParameters }, effect: "read",
      execute: async args => {
        const query = text(args.query, 120).trim();
        if (query.length < 2) return { error: "invalid_search_query" };
        options.status?.("Поиск в памяти телефона");
        const found = await options.lookup(query);
        if (!Array.isArray(found) || found.some(n => !n || typeof n.id !== "string" || typeof n.body !== "string")) return { error: "invalid_memory_result" };
        for (const n of usedNotes(found, "assistant")) used.set(n.id, n);
        found.forEach(admitMoveHandle);
        web.addNotes(found);
        options.diagnostic?.("memory.tool_search", { queryChars: query.length, found: found.length, noteIds: found.map(n => n.id), excerptCount: found.filter(n => n.excerptOnly).length }, { query });
        return { notes: found };
      }, verify: r => Array.isArray(r.notes) ? r.notes.length ? "found" : "empty" : "failed" },
    ...(options.searchPhotos && !options.skipLocalMemory ? [{
      definition: {name: "search_local_photos",
        description: "Единый локальный поиск фотографий в памяти телефона. mode=text: description — описание из 3–160 символов. mode=image: используй выбранное в интерфейсе фото (только когда mode=image доступен в schema), description — пустая строка. LLM не получает пиксели или эмбеддинги. Результат — реальные фото-вложения и состояние модели/индекса; максимум 2 поиска за ход.",
        parameters: {type: "object", properties: {
          mode: {type: "string",enum:options.photoQueryAvailable?["text","image"]:["text"]},
          description: {type: "string", maxLength: 160},
        }, required: ["mode","description"], additionalProperties: false},
      }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        if(Object.keys(args).length!==2 || typeof args.description!=="string" ||
          (args.mode!=="text" && args.mode!=="image") ||
          (args.mode==="image" && (!options.photoQueryAvailable || args.description!=="")) ||
          (args.mode==="text" && (args.description.trim().length<3 ||
            args.description.trim().length>160 ||
            args.description.includes("://") ||
            /(?:в интернете|из интернета|в сети|online|по ссылке)/iu.test(args.description))))
          return {error: "invalid_local_photo_search_args"};
        if(photoLookups>=2)return {error:"local_photo_turn_budget_exhausted"};
        photoLookups++;
        options.status?.("Ищу фотографии в памяти");
        const found=await options.searchPhotos!({
          mode:args.mode as "text"|"image",
          description:args.mode==="image"?"":args.description.trim(),
        });
        if(options.signal?.aborted)throw new Error("aborted");
        if(!found || typeof found.text!=="string" || !Array.isArray(found.memory) ||
            found.memory.length>20 ||
            found.memory.some(item=>!item || item.photo!==true || item.via!=="search" ||
              typeof item.id!=="string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(item.id) ||
              typeof item.photoAttachmentId!=="string" ||
              !/^[A-Za-z0-9:_-]{1,128}$/.test(item.photoAttachmentId) ||
              typeof item.title!=="string" || !item.title.trim() || item.title.length>160) ||
            new Set(found.memory.map(item=>item.id+":"+item.photoAttachmentId)).size!==found.memory.length ||
            (found.photoAction!==undefined && !["model","import","prepare"].includes(found.photoAction)) ||
            (found.memory.length>0 && found.photoAction!==undefined))
          return {error:"invalid_local_photo_search_result"};
        for(const item of found.memory){
          if(!photoMatches.some(prev=>prev.id===item.id &&
            prev.photoAttachmentId===item.photoAttachmentId) && photoMatches.length<20)
            photoMatches.push({id:item.id,title:item.title,via:"search",photo:true,
              photoAttachmentId:item.photoAttachmentId});
        }
        if(!photoMatches.length)photoRecovery=found.photoAction;
        const status=found.memory.length?"found":found.photoAction==="model"?"model_missing":
          found.photoAction==="import"?"no_photos":
          found.photoAction==="prepare"?"unprepared":"no_matches";
        return {scope:"standard_active_local_photos",status,
          count:found.memory.length,
          photos:found.memory.map(item=>({id:item.id,title:item.title,
            photoAttachmentId:item.photoAttachmentId})),
          notice:found.text.slice(0,400),
          imageBytesIncluded:false,originalImagesInspectedByLLM:false,
          ...(found.photoAction?{photoAction:found.photoAction}:{})};
      },
      verify:(r:Record<string,unknown>)=>r.scope==="standard_active_local_photos" &&
        typeof r.status==="string" &&
        ["found","model_missing","no_photos","unprepared","no_matches"].includes(r.status) &&
        Number.isSafeInteger(r.count) && Array.isArray(r.photos) &&
        r.photos.length===r.count && r.photos.length<=20 &&
        r.imageBytesIncluded===false && r.originalImagesInspectedByLLM===false ?
        r.count ? "found" as const : "empty" as const : "failed" as const,
    }] : []),
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
        const page=await options.list!(opts);
        if(page.scope==="standard_active_notes" && Array.isArray(page.records) &&
           page.records.every(row=>row && typeof row==="object" &&
             typeof row.id==="string" && Number.isSafeInteger(row.version) && row.version>0))
          (page.records as Array<{id:string;version:number}>).forEach(admitMoveHandle);
        return page;
      },
      verify: (r: Record<string, unknown>) => Array.isArray(r.records) &&
        typeof r.hasMore === "boolean" && r.contentIncluded === false ? "read" as const : "failed" as const,
    }] : []),
    ...(options.count ? [{
      definition: { name: "count_local_notes", description: "Количество только разрешённых активных заметок. При collectionId по умолчанию считаются только непосредственные записи. Если пользователь спрашивает обо всём дереве, укажи includeDescendants=true: поиск по вложенным разделам с сохранением ACL. Не интерпретируй ноль в приватном/недоступном разделе как отсутствие записей; query — точная FTS-фраза.", parameters: {
        type: "object", properties: { query: { type: ["string", "null"] }, collectionId: { type: ["string", "null"] },
          includeDescendants: { type: "boolean", description: "Включить все вложенные разделы (только с collectionId)" } },
        required: ["query","collectionId"], additionalProperties: false,
      } }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        if (Object.keys(args).some(key => !["query","collectionId","includeDescendants"].includes(key)) ||
            (args.query != null && typeof args.query !== "string") ||
            (args.collectionId != null && typeof args.collectionId !== "string") ||
            (args.includeDescendants !== undefined && typeof args.includeDescendants !== "boolean")) {
          return { error: "invalid_catalog_arguments" };
        }
        return options.count!({
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.collectionId === "string" ? { collectionId: args.collectionId } : {}),
          ...(args.includeDescendants === true ? { includeDescendants: true } : {}),
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
    ...(options.read && options.selectArticles ? [{
      definition:{ name:"read_selected_local_articles",
        description:"9B: читать именно ранее показанные в этом чате сохранённые статьи (до 24 id/version) через проверяемый локальный reader. Каждый элемент вернёт свой абсолютный selectedIndex для цитат S1=0, S2=1 и так далее (номер S = selectedIndex+1), даже если запись недоступна. Модель НЕ передаёт ID. Фильтр и список остаются в SQLCipher истории; на каждом чтении ACL/версия проверяются заново. Читай следующие страницы с nextIndex, пока hasMore=false или не исчерпан бюджет. complete_note_text НЕ значит прочитанная оригинальная веб-страница; link_only не источник фактов статьи.",
        parameters:{type:"object",properties:{
          startIndex:{type:["integer","null"]},count:{type:["integer","null"]},
          charsPerNote:{type:["integer","null"]},
        },required:["startIndex","count","charsPerNote"],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(Object.keys(args).some(k=>!["startIndex","count","charsPerNote"].includes(k)))
          return {error:"invalid_selected_article_args"};
        if(mixedArticleFilters)return {error:"ambiguous_article_selection"};
        usedSelectedArticleTool=true;
        const selected=selectedArticleHandles();
        if(!selected)return {error:"missing_or_invalid_article_selection"};
        const start=args.startIndex??0, count=args.count??6, budget=args.charsPerNote??1800;
        if(!Number.isSafeInteger(start)||Number(start)<0||Number(start)>=selected.length||
            !Number.isSafeInteger(count)||Number(count)<1||Number(count)>6||
            !Number.isSafeInteger(budget)||Number(budget)<100||Number(budget)>2200)
          return {error:"invalid_selected_article_args"};
        const chosen=selected.slice(Number(start),Number(start)+Number(count));
        const entries:Array<Record<string,unknown>>=[];
        for(const [localIndex,handle] of chosen.entries()){
          const selectedIndex=Number(start)+localIndex;
          if(options.signal?.aborted)throw new Error("aborted");
          try {
            const result=await verifiedSelectedArticleRead(handle,0,Number(budget));
            const evidence=result.evidence;
            const content=result.content, total=result.totalChars;
            const status=!content.trim() && !result.hasMore ? "empty_saved_note" :
              !result.hasMore && /^https?:\/\/\S+$/iu.test(content.trim()) ? "link_only" :
              result.hasMore ? "partial_saved_note" : "complete_saved_note_text";
            entries.push({selectedIndex,id:handle.id,version:handle.version,status,
              title:result.title.slice(0,160),content,
              totalChars:total,hasMore:result.hasMore,evidence});
            if(status==="partial_saved_note"||status==="complete_saved_note_text"){
              used.set(handle.id,{id:handle.id,title:result.title.slice(0,160),via:"assistant"});
              readNotes.add(handle.id);
            }
          }catch(e){
            if(options.signal?.aborted)throw e;
            const message=(e as Error)?.message;
            if(message==="memory_read_not_available" || message==="stale_memory_version" ||
                message==="memory_read_not_available_or_stale"){
              articleCoverage.unavailable(handle);
              used.delete(handle.id); readNotes.delete(handle.id);
              entries.push({selectedIndex,id:handle.id,version:handle.version,status:"not_available_or_stale"});
            }else throw e; // AppLock, damaged evidence and cancellation fail closed.
          }
        }
        const nextIndex=Number(start)+chosen.length;
        return {scope:"standard_active_article_selection",contentIncluded:true,
          selectedCount:selected.length,checked:entries.length,startIndex:Number(start),
          hasMore:nextIndex<selected.length,
          ...(nextIndex<selected.length?{nextIndex}:{}),
          readTextCount:entries.filter(n=>n.status==="partial_saved_note"||
              n.status==="complete_saved_note_text").length,
          partialCount:entries.filter(n=>n.status==="partial_saved_note").length,
          linkOnlyCount:entries.filter(n=>n.status==="link_only").length,
          unavailableCount:entries.filter(n=>n.status==="not_available_or_stale").length,
          entries};
      },
      verify:(r:Record<string,unknown>)=>r.scope==="standard_active_article_selection" &&
        r.contentIncluded===true && Array.isArray(r.entries) &&
        Number.isSafeInteger(r.selectedCount) && typeof r.hasMore==="boolean" &&
        r.entries.length<=6 ? r.entries.length ? "read" as const : "empty" as const : "failed" as const,
    },
      { definition:{name:"read_selected_article_chunk",
        description:"9B: дочитать ОДНУ длинную заметку из сохранённой подборки по selectedIndex, НЕ по ID модели. offset=nextOffset предыдущего фрагмента; до 6000 символов. Версия, права, AppLock и доказательства диапазона перепроверяются. Прочтение последнего фрагмента НЕ означает, что прочитаны все предыдущие или оригинальная веб-страница. При неполном охвате сообщи это явно.",
        parameters:{type:"object",properties:{
          selectedIndex:{type:"integer"},offset:{type:["integer","null"]},
          budget:{type:["integer","null"],maximum:6000},
        },required:["selectedIndex","offset","budget"],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(Object.keys(args).length!==3 ||
            Object.keys(args).some(k=>!["selectedIndex","offset","budget"].includes(k)))
          return {error:"invalid_selected_article_chunk_args"};
        if(mixedArticleFilters)return {error:"ambiguous_article_selection"};
        const selected=selectedArticleHandles();
        if(!selected)return {error:"missing_or_invalid_article_selection"};
        const index=args.selectedIndex, offset=args.offset??0, budget=args.budget??4000;
        if(!Number.isSafeInteger(index) || Number(index)<0 ||
            Number(index)>=selected.length || !Number.isSafeInteger(offset) ||
            Number(offset)<0 || Number(offset)>2_000_000 ||
            !Number.isSafeInteger(budget) || Number(budget)<100 ||
            Number(budget)>6000)return {error:"invalid_selected_article_chunk_args"};
        usedSelectedArticleTool=true;
        const handle=selected[Number(index)];
        try{
          const result=await verifiedSelectedArticleRead(handle,Number(offset),Number(budget));
          const isSingleFullRead=Number(offset)===0 && !result.hasMore;
          const status=!result.content.trim() && isSingleFullRead ? "empty_saved_note" :
            isSingleFullRead && /^https?:\/\/\S+$/iu.test(result.content.trim())
              ? "link_only" : "saved_note_chunk";
          if(status==="saved_note_chunk" && result.content.trim()){
            used.set(handle.id,{id:handle.id,title:result.title.slice(0,160),via:"assistant"});
            readNotes.add(handle.id);
          }
          return {scope:"standard_active_article_selection",selectedIndex:Number(index),
            id:handle.id,version:handle.version,title:result.title.slice(0,160),
            status,contentIncluded:true,content:result.content,
            offset:result.offset,totalChars:result.totalChars,hasMore:result.hasMore,
            ...(result.hasMore?{nextOffset:result.nextOffset}:{}),
            evidence:result.evidence,sourceCoverage:"verified_chunk_only",
            savedNoteFullyRead:isSingleFullRead,originalWebPageRead:false};
        }catch(e){
          if(options.signal?.aborted)throw e;
          const message=(e as Error)?.message;
          if(message==="memory_read_not_available" || message==="stale_memory_version" ||
              message==="memory_read_not_available_or_stale"){
            articleCoverage.unavailable(handle);
            used.delete(handle.id); readNotes.delete(handle.id);
            return {scope:"standard_active_article_selection",selectedIndex:Number(index),
              status:"not_available_or_stale",contentIncluded:false};
          }
          throw e; // Lock, cancellation or inconsistent evidence: fail closed.
        }
      },
      verify:(r:Record<string,unknown>)=>r.scope==="standard_active_article_selection" &&
        r.status==="not_available_or_stale" && r.contentIncluded===false ? "empty" as const :
        r.scope==="standard_active_article_selection" &&
        r.contentIncluded===true && r.sourceCoverage==="verified_chunk_only" &&
        r.originalWebPageRead===false && !!r.evidence ? "read" as const : "failed" as const,
      },
      { definition:{name:"selected_article_read_coverage",
        description:"Проверить ФАКТИЧЕСКИЙ охват выбранных статей за текущий ход агента. Только диапазоны из проверенных ACL/version source-read, не черновики workspace и не результаты прошлых ходов. Вернёт полностью/частично/не прочитано, link-only, недоступно, границы и nextUnreadOffset; количество выбранных записей НЕ равно общему числу найденных. Полная сохранённая заметка НЕ является оригинальной веб-страницей.",
        parameters:{type:"object",properties:{},required:[],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(Object.keys(args).length)return {error:"invalid_article_coverage_args"};
        if(options.signal?.aborted)throw new Error("aborted");
        if(options.workspaceAvailable && !options.workspaceAvailable())
          return {error:"application_locked"};
        if(mixedArticleFilters)return {error:"ambiguous_article_selection"};
        const selected=selectedArticleHandles();
        if(!selected)return {error:"missing_or_invalid_article_selection"};
        usedSelectedArticleTool=true;
        return articleCoverage.summary(selected);
      },
      verify:(r:Record<string,unknown>)=>r.scope==="current_agent_turn_verified_reads" &&
        Number.isSafeInteger(r.selectedCount) && Array.isArray(r.entries) &&
        r.entries.length===r.selectedCount &&
        r.originalWebPagesVerified===0 ? "read" as const : "failed" as const,
      },
    ] : []),
    ...(options.previewMove && !options.skipLocalMemory ? [{
      definition: {name:"propose_move_local_note",
        description:"9T2: ТОЛЬКО предпросмотр переноса ОДНОЙ найденной активной заметки между двумя существующими стандартными разделами. Сначала search_local_notes/list_local_notes, возьми точный ID и record version. Пользователь отдельно подтверждает карточку. Не создавать копию заметки, не выполнять запись/merge, не трогать Документы и закрытые разделы.",
        parameters:{type:"object",properties:{
          noteId:{type:"string",minLength:1,maxLength:128},
          expectedVersion:{type:"integer",minimum:1},
          targetSectionSlug:{type:"string",minLength:1,maxLength:80},
          reason:{type:"string",minLength:5,maxLength:240},
        },required:["noteId","expectedVersion","targetSectionSlug","reason"],
          additionalProperties:false},
      },effect:"proposal" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(movePreview)return {error:"move_preview_already_proposed_this_turn"};
        const id=args.noteId, version=args.expectedVersion, to=args.targetSectionSlug, reason=args.reason;
        if(Object.keys(args).length!==4 ||
           typeof id!=="string"||!/^[A-Za-z0-9:_-]{1,128}$/.test(id) ||
           !Number.isSafeInteger(version)||(version as number)<1 ||
           typeof to!=="string"|| !/^[a-z0-9_-]{1,80}$/.test(to) ||
           typeof reason!=="string"||reason.trim().length<5||reason.length>240)
          return {error:"invalid_move_arguments"};
        if(moveHandles.get(id)!==version)
          return {error:"note_not_selected_for_move"};
        if(options.signal?.aborted)throw new Error("Запрос остановлен");
        options.status?.("Проверяю предложение переноса");
        const proposed=await options.previewMove!({
          noteId:id,expectedVersion:version as number,targetSectionSlug:to,reason:reason.trim(),
        });
        if(options.signal?.aborted)throw new Error("Запрос остановлен");
        if(!validMoveProposal(proposed)||proposed.noteId!==id||
           proposed.expectedVersion!==version)
          return {error:"invalid_move_preview"};
        movePreview=proposed;
        return {status:"awaiting_user_confirmation",saved:false,
          noteId:proposed.noteId,version:proposed.expectedVersion,
          title:proposed.title,fromSection:proposed.fromName,toSection:proposed.toName,
          attachmentsPreserved:proposed.attachmentCount,sourceLinksPreserved:proposed.hasSource,
          reason:proposed.reason,requiresUserTap:true};
      },
      verify:(r:Record<string,unknown>)=>r.status==="awaiting_user_confirmation" &&
        r.saved===false && r.requiresUserTap===true ? "pending_confirmation" as const : "failed" as const,
    }] : []),
    // SAME canonical chat ToolSpec registry as memory search, note drafts and moves.
    // The model never executes a section write: it only stages a card for a user tap.
    ...(options.previewSectionAction && !options.skipLocalMemory ? [{
      definition:{name:"propose_create_memory_section",
        description:"Предложить создание нового раздела или подраздела памяти. parentSlug = slug существующего обычного родителя либо null для корня. Называй только последний уровень, не путь. После вызова появится карточка подтверждения; не утверждай, что раздел создан.",
        parameters:{type:"object",properties:{
          name:{type:"string",minLength:1,maxLength:80},
          parentSlug:{type:["string","null"],description:"Точный slug родительского раздела либо null. Доступные: "+(options.sections||[]).map(s=>s.slug+"="+(s.path||s.name)).join("; ")},
          reason:{type:"string",minLength:5,maxLength:240},
        },required:["name","parentSlug","reason"],additionalProperties:false}},
      effect:"proposal" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(sectionPreview)return {error:"section_action_already_proposed_this_turn"};
        const request={kind:"create",...args};
        if(Object.keys(args).sort().join(",")!=="name,parentSlug,reason" ||
           typeof args.name!=="string"||!args.name.trim()||args.name.length>80 ||
           /[\/\r\n]/.test(args.name) ||
           !(args.parentSlug===null || (typeof args.parentSlug==="string" && /^[a-z][a-z0-9_-]{0,63}$/.test(args.parentSlug))) ||
           typeof args.reason!=="string"||args.reason.trim().length<5||args.reason.length>240)
          return {error:"invalid_section_action_args"};
        let proposed:ChatSectionProposal;
        try {
          proposed=await options.previewSectionAction!(
            request as Parameters<NonNullable<DirectAgentOptions["previewSectionAction"]>>[0]);
        }catch(error){return {error:sectionToolError(error)};}
        if(!validSectionProposal(proposed)||proposed.kind!=="create"||proposed.name!==args.name.trim())
          return {error:"invalid_section_preview"};
        sectionPreview=proposed;
        return {status:"awaiting_user_confirmation",saved:false,requiresUserTap:true,
          action:"create",name:proposed.name,parent:proposed.parentName};
      },
      verify:(v:Record<string,unknown>)=>v.status==="awaiting_user_confirmation"&&v.saved===false&&
        v.requiresUserTap===true?"pending_confirmation" as const:"failed" as const,
    },{
      definition:{name:"propose_delete_memory_section",
        description:"Предложить удаление существующего ПУСТОГО пользовательского обычного раздела. Только точный sectionSlug; удаление заблокировано для системных, защищённых разделов, разделов с записями (включая архив/корзину) или вложенными разделами. Не вызывай для очистки содержимого. Никогда не удаляй без отдельного подтверждения пользователя.",
        parameters:{type:"object",properties:{
          sectionSlug:{type:"string",minLength:1,maxLength:64,description:"Точный slug раздела; доступные: "+(options.sections||[]).map(s=>s.slug+"="+(s.path||s.name)).join("; ")},
          reason:{type:"string",minLength:5,maxLength:240},
        },required:["sectionSlug","reason"],additionalProperties:false}},
      effect:"proposal" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(sectionPreview)return {error:"section_action_already_proposed_this_turn"};
        if(Object.keys(args).sort().join(",")!=="reason,sectionSlug" ||
           typeof args.sectionSlug!=="string"||!/^[a-z][a-z0-9_-]{0,63}$/.test(args.sectionSlug) ||
           typeof args.reason!=="string"||args.reason.trim().length<5||args.reason.length>240)
          return {error:"invalid_section_action_args"};
        let proposed:ChatSectionProposal;
        try {
          proposed=await options.previewSectionAction!(
            {kind:"delete",sectionSlug:args.sectionSlug,reason:args.reason});
        }catch(error){return {error:sectionToolError(error)};}
        if(!validSectionProposal(proposed)||proposed.kind!=="delete"||proposed.slug!==args.sectionSlug)
          return {error:"invalid_section_preview"};
        sectionPreview=proposed;
        return {status:"awaiting_user_confirmation",saved:false,requiresUserTap:true,
          action:"delete",name:proposed.name,parent:proposed.parentName,
          recordCount:0,childCount:0};
      },
      verify:(v:Record<string,unknown>)=>v.status==="awaiting_user_confirmation"&&v.saved===false&&
        v.requiresUserTap===true?"pending_confirmation" as const:"failed" as const,
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
    ...(options.saveWorkspace && options.workspaceAvailable && !options.skipLocalMemory ? [
      { definition:{name:"workspace_put",
        description:"Сохранить ОДИН промежуточный черновик, задачу или сравнение в рабочей области ЭТОЙ задачи и зашифрованного диалога. Не личная память; не факт и не источник доказательства. Не копируй полный текст статей. До 16 ключей, по 1200 символов. Один и тот же key заменяется.",
        parameters:{type:"object",properties:{
          key:{type:"string",maxLength:32,pattern:"^[a-z][a-z0-9_-]*$"},
          kind:{type:"string",enum:["finding","todo","question","comparison"]},
          content:{type:"string",maxLength:WORKSPACE_ENTRY_MAX_CHARS},
        },required:["key","kind","content"],additionalProperties:false},
      },effect:"conversation" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(!options.workspaceAvailable!())return {error:"workspace_locked"};
        if(Object.keys(args).length!==3 || Object.keys(args).some(k=>!["key","kind","content"].includes(k)) ||
            typeof args.key!=="string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(args.key) ||
            !["finding","todo","question","comparison"].includes(String(args.kind)) ||
            typeof args.content!=="string" || !args.content.trim() ||
            args.content.length>WORKSPACE_ENTRY_MAX_CHARS)
          return {error:"invalid_workspace_entry"};
        if(state.workspace && state.workspace.goal!==state.goal)return {error:"workspace_task_changed_clear_first"};
        const entry={key:args.key,kind:args.kind,content:args.content} as TaskWorkspaceEntry;
        const previous=state.workspace?.entries||[];
        if(previous.length>=WORKSPACE_MAX_ENTRIES && !previous.some(e=>e.key===entry.key))
          return {error:"workspace_capacity_reached"};
        const entries=[...previous.filter(e=>e.key!==entry.key),entry];
        const next={...state,workspace:{version:1 as const,goal:state.goal,entries}};
        await options.saveWorkspace!(next);
        state=next;
        return {status:"workspace_written",scope:"current_task",
          key:entry.key,kind:entry.kind,entries:entries.length,
          personalMemorySaved:false,verifiedSource:false};
      },
      verify:(r:Record<string,unknown>)=>r.status==="workspace_written" &&
        r.personalMemorySaved===false ? "state_updated" as const : "failed" as const,
      },
      { definition:{name:"workspace_list",
        description:"Список коротких ключей рабочей области ТЕКУЩЕЙ задачи. Содержимое и оригиналы тут НЕ возвращаются; для них workspace_get/доказательный source-read.",
        parameters:{type:"object",properties:{},required:[],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(!options.workspaceAvailable!())return {error:"workspace_locked"};
        if(Object.keys(args).length)return {error:"invalid_workspace_args"};
        if(state.workspace && state.workspace.goal!==state.goal)return {error:"workspace_task_changed_clear_first"};
        const entries=state.workspace?.entries||[];
        return {scope:"current_task",modelDraftsOnly:true,
          entries:entries.map(e=>({key:e.key,kind:e.kind,chars:e.content.length})),
          count:entries.length};
      },
      verify:(r:Record<string,unknown>)=>r.scope==="current_task"&&r.modelDraftsOnly===true&&
        Array.isArray(r.entries)?(r.entries.length?"read" as const:"empty" as const):"failed" as const,
      },
      { definition:{name:"workspace_get",
        description:"Прочитать ОДИН промежуточный черновик модели по ключу, не оригинал. Прежде чем приводить факты, перечитай исходный документ с версионированным source reader.",
        parameters:{type:"object",properties:{key:{type:"string",maxLength:32}},required:["key"],additionalProperties:false},
      },effect:"read" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(!options.workspaceAvailable!())return {error:"workspace_locked"};
        if(Object.keys(args).length!==1 || typeof args.key!=="string" ||
            !/^[a-z][a-z0-9_-]{0,31}$/.test(args.key))return {error:"invalid_workspace_args"};
        if(state.workspace && state.workspace.goal!==state.goal)return {error:"workspace_task_changed_clear_first"};
        const entry=state.workspace?.entries.find(e=>e.key===args.key);
        if(!entry)return {error:"workspace_key_missing"};
        return {scope:"current_task",modelDraftOnly:true,verifiedSource:false,
          entry:{...entry}};
      },
      verify:(r:Record<string,unknown>)=>r.scope==="current_task"&&r.modelDraftOnly===true&&
        r.verifiedSource===false&&!!r.entry?"read" as const:"failed" as const,
      },
      { definition:{name:"workspace_clear",
        description:"Очистить ТОЛЬКО рабочие черновики текущего диалога (например, при смене задачи). Оригинальные заметки, документы, подтверждённые действия и историю чата не трогает.",
        parameters:{type:"object",properties:{},required:[],additionalProperties:false},
      },effect:"conversation" as const,
      execute:async(args:Record<string,unknown>)=>{
        if(!options.workspaceAvailable!())return {error:"workspace_locked"};
        if(Object.keys(args).length)return {error:"invalid_workspace_args"};
        const discarded=state.workspace?.entries.length||0;
        const next={...state,workspace:undefined};
        await options.saveWorkspace!(next);
        state=next;
        return {status:"workspace_cleared",discarded,personalMemoryDeleted:false};
      },
      verify:(r:Record<string,unknown>)=>r.status==="workspace_cleared"&&
        r.personalMemoryDeleted===false?"state_updated" as const:"failed" as const,
      },
    ] as ToolSpec[] : []),
    ...web.definitions.map((definition): ToolSpec => ({ definition, effect: "read", execute: args => web.run(definition.name, args) as Promise<Record<string, unknown>>,
      verify: r => definition.name === "search_web"
        ? Array.isArray(r.sources) && typeof r.context === "string" ? r.sources.length ? "found" : "empty" : "failed"
        : typeof r.content === "string" && r.content.trim() && typeof r.url === "string" ? "read" : "failed" })),
  ];
  // Import classification uses THIS catalog/engine, but no memory/web/workspace tools.
  // The host must separately authorize transmission before setting contextOnly.
  const activeSpecs = options.contextOnly
    ? options.importTagsEnabled ? [importMetadataTool] : specs.filter(s => s.definition.name === "set_conversation_context")
    : specs;
  const registry = new Map(activeSpecs.map(s => [s.definition.name, s]));
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
    // A coverage snapshot is valid ONLY for this model turn. Do not persist it
    // as task evidence that a later turn could mistake for a reauthorized read.
    if (outcome !== "state_updated" &&
        canonical !== "selected_article_read_coverage" &&
        canonical !== "search_local_photos")
      observe({ tool: canonical, outcome,
      subject: text(result.proposalId || args?.url || args?.query || args?.title || name),
      excerpt: outcome === "read" ? text(result.content) : outcome === "found" && canonical === "search_web" ? text((result.sources as string[]).join("\n")) : text(JSON.stringify(result)) });
    options.diagnostic?.("tool.outcome_verified", { name: canonical, effect: spec?.effect || "unknown", outcome });
    return { ...result, ...(outcome !== "failed" ? { outcome } : {}) };
  }
  function finish(): Pick<DirectResult, "taskState" | "proposalIds" | "articlePage" | "articleReadReport" | "photoAction" | "moveProposal" | "sectionProposal" | "contextCandidate" | "importTags"> {
    state = { ...state, turnStatus: "answered" }; emit();
    const selected = !mixedArticleFilters && usedSelectedArticleTool ? selectedArticleHandles() : undefined;
    const checked = selected && articleCoverage.summary(selected);
    // This is a historic, read-only answer annotation. It is NOT promoted into
    // TaskState evidence and cannot authorize a future read or preserve source text.
    const articleReadReport = selected && checked && checked.checkedCount>0 ? {
      kind:"selected_saved_note_reads" as const,selectedCount:selected.length,
      entries:checked.entries.map((entry,index)=>({
        selectedIndex:index,id:selected[index].id,version:selected[index].version,
        status:entry.status,verifiedChars:entry.verifiedChars,
        ...("totalChars" in entry && typeof entry.totalChars==="number" ?
          {totalChars:entry.totalChars} : {}),
        ...("title" in entry && typeof entry.title==="string" ?
          {title:entry.title} : {}),
        // Ranges are read-only source coordinates, not a copy of article text.
        // Very fragmented notes retain aggregate coverage but lose inline links.
        ...("ranges" in entry && Array.isArray(entry.ranges) && entry.ranges.length<=128 ?
          {ranges:entry.ranges.filter(r=>r.endChar>r.startChar).map(r=>({
            startChar:r.startChar,endChar:r.endChar,
          }))} : {}),
      })),
    } : undefined;
    return { taskState: state, proposalIds: [...proposalIds],
      ...(persistedArticle ? {articlePage:persistedArticle} :
        usedSelectedArticleTool && options.articleSelection ? {articlePage:options.articleSelection} : {}),
      ...(articleReadReport ? {articleReadReport} : {}),
      ...(!photoMatches.length && photoRecovery ? {photoAction:photoRecovery} : {}),
      ...(movePreview ? {moveProposal:movePreview} : {}),
      ...(sectionPreview ? {sectionProposal:sectionPreview} : {}),
      ...(contextCandidate ? {contextCandidate} : {}),
      ...(importTagsCandidate !== undefined ? {importTags:importTagsCandidate} : {}) };
  }
  const observeSources = (urls: string[]) => { if (urls.length) observe({ tool: "web_search", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: urls.join("\n").slice(0, 600) }); };
  return { definitions: activeSpecs.map(s => s.definition), run, finish, observeSources,
    memory: () => {
      const read=[...readNotes].reverse().flatMap(id=>used.has(id)?[used.get(id)!]:[]);
      // Photo originals are per attachment, not per note. Do not deduplicate
      // photos sharing a note ID, and let existing PhotoSearchResults render
      // the top match + collapsible alternatives without a second photo UI.
      const ordinary=[...read,
        ...[...used.values()].filter(item=>!readNotes.has(item.id))].slice(0,8);
      return [...photoMatches,...ordinary];
    } };
}
