import type { DirectAgentOptions, DirectResult } from "../engine";
import { usedNotes } from "../context";
import type { UsedNote } from "../context";
import type { MemorySnippet } from "../memory";
import { FACT_TOOL_NAME, FACT_TOOL_DESCRIPTION, factToolParameters, factProposal } from "../fact-tool";
import { createWebTools } from "../web-tools";
import { beginTask, recordEvidence, TASK_STATE_TOOL, updateTaskInterpretation,
  WORKSPACE_MAX_ENTRIES, WORKSPACE_ENTRY_MAX_CHARS } from "../task-state";
import type { TaskWorkspaceEntry } from "../task-state";
import type { TaskEvidence, ToolOutcome } from "../task-state";
import { webPreference } from "../dialogue";
import { savedArticleToolIntent, savedAiArticlePageIntent } from "../article-selection";
import type { SavedArticleIntent } from "../article-selection";
import type { ChatArticlePage, ChatMemoryRef } from "../conversations";
import { validMoveProposal, type ChatMoveProposal } from "../move-proposal";
import { validSectionProposal, type ChatSectionProposal } from "../section-actions";
import { createArticleReadCoverage } from "../article-read-coverage";
import { validateContextCandidate, type ContextCandidate } from "../conversation-context";
import { checkedNoteTags } from "../../local-memory/note-tags";

import type { ToolSpec } from "./types";
import { sourceTools } from "./source-tools";
import { memoryTools } from "./memory-tools";
import { photoTools } from "./photo-tools";
import { articleTools } from "./article-tools";
export type { ToolDefinition, ToolSpec } from "./types";
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
  const memory = memoryTools(options, {web,used,readNotes,admitMoveHandle}, text, queryParameters);
  const specs: ToolSpec[] = [
    ...(options.contextClassificationEnabled ? [contextTool] : []),
    memory.search,
    ...photoTools(options, {
      photoMatches, getLookups: () => photoLookups,
      incrementLookups: () => { photoLookups++; },
      setRecovery: reason => { photoRecovery = reason; },
    }),
    ...memory.read,
    ...sourceTools(options, text),
    ...memory.listing,
    ...articleTools(options, {
      articleClock,readArticleSelection,selectedArticleHandles,verifiedSelectedArticleRead,
      articleCoverage,used,readNotes,
      getMixedArticleFilters:()=>mixedArticleFilters,
      markUsedSelectedArticleTool:()=>{usedSelectedArticleTool=true;},
    }),
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
