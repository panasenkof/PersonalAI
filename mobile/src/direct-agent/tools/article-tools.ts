import type { DirectAgentOptions } from "../engine";
import type { UsedNote } from "../context";
import { savedArticleToolIntent, savedAiArticlePageIntent } from "../article-selection";
import type { SavedArticleIntent } from "../article-selection";
import type { createArticleReadCoverage } from "../article-read-coverage";
import type { ToolSpec } from "./types";

type CheckedArticleRead = {
  id:string;revision:number;title:string;content:string;offset:number;
  totalChars:number;hasMore:boolean;nextOffset?:number;
  evidence:Record<string,unknown>;
};
/** The same bounded/cursor-checked article reader, now in one source module. */
export function articleTools(options:DirectAgentOptions, scope:{
  articleClock:Date;
  readArticleSelection:(intent:SavedArticleIntent,cursor?:{beforeCreatedAt:string;beforeId:string})=>Promise<Record<string,unknown>>;
  selectedArticleHandles:()=>Array<{id:string;version:number}>|undefined;
  verifiedSelectedArticleRead:(handle:{id:string;version:number},offset:number,budget:number)=>Promise<CheckedArticleRead>;
  articleCoverage:ReturnType<typeof createArticleReadCoverage>;
  used:Map<string,UsedNote>;
  readNotes:Set<string>;
  getMixedArticleFilters:()=>boolean;
  markUsedSelectedArticleTool:()=>void;
}):ToolSpec[]{
  return [
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
        const intent = savedArticleToolIntent(args.topic, args.period, args.dateMode, scope.articleClock);
        if (!intent) return { error: "invalid_article_tool_arguments" };
        const t = args.beforeCreatedAt, id = args.beforeId;
        if (!((t === null && id === null) ||
          (typeof t === "string" && t.length === 24 &&
            Number.isFinite(Date.parse(t)) && new Date(t).toISOString() === t &&
            typeof id === "string" && id.length > 0 && id.length <= 128)))
          return { error: "invalid_article_cursor" };
        return scope.readArticleSelection(intent,id===null?undefined:{beforeCreatedAt:t as string,beforeId:id as string});
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
        return scope.readArticleSelection(savedAiArticlePageIntent(previous),previous.nextCursor);
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
        if(scope.getMixedArticleFilters())return {error:"ambiguous_article_selection"};
        scope.markUsedSelectedArticleTool();
        const selected=scope.selectedArticleHandles();
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
            const result=await scope.verifiedSelectedArticleRead(handle,0,Number(budget));
            const evidence=result.evidence;
            const content=result.content, total=result.totalChars;
            const status=!content.trim() && !result.hasMore ? "empty_saved_note" :
              !result.hasMore && /^https?:\/\/\S+$/iu.test(content.trim()) ? "link_only" :
              result.hasMore ? "partial_saved_note" : "complete_saved_note_text";
            entries.push({selectedIndex,id:handle.id,version:handle.version,status,
              title:result.title.slice(0,160),content,
              totalChars:total,hasMore:result.hasMore,evidence});
            if(status==="partial_saved_note"||status==="complete_saved_note_text"){
              scope.used.set(handle.id,{id:handle.id,title:result.title.slice(0,160),via:"assistant"});
              scope.readNotes.add(handle.id);
            }
          }catch(e){
            if(options.signal?.aborted)throw e;
            const message=(e as Error)?.message;
            if(message==="memory_read_not_available" || message==="stale_memory_version" ||
                message==="memory_read_not_available_or_stale"){
              scope.articleCoverage.unavailable(handle);
              scope.used.delete(handle.id); scope.readNotes.delete(handle.id);
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
        if(scope.getMixedArticleFilters())return {error:"ambiguous_article_selection"};
        const selected=scope.selectedArticleHandles();
        if(!selected)return {error:"missing_or_invalid_article_selection"};
        const index=args.selectedIndex, offset=args.offset??0, budget=args.budget??4000;
        if(!Number.isSafeInteger(index) || Number(index)<0 ||
            Number(index)>=selected.length || !Number.isSafeInteger(offset) ||
            Number(offset)<0 || Number(offset)>2_000_000 ||
            !Number.isSafeInteger(budget) || Number(budget)<100 ||
            Number(budget)>6000)return {error:"invalid_selected_article_chunk_args"};
        scope.markUsedSelectedArticleTool();
        const handle=selected[Number(index)];
        try{
          const result=await scope.verifiedSelectedArticleRead(handle,Number(offset),Number(budget));
          const isSingleFullRead=Number(offset)===0 && !result.hasMore;
          const status=!result.content.trim() && isSingleFullRead ? "empty_saved_note" :
            isSingleFullRead && /^https?:\/\/\S+$/iu.test(result.content.trim())
              ? "link_only" : "saved_note_chunk";
          if(status==="saved_note_chunk" && result.content.trim()){
            scope.used.set(handle.id,{id:handle.id,title:result.title.slice(0,160),via:"assistant"});
            scope.readNotes.add(handle.id);
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
            scope.articleCoverage.unavailable(handle);
            scope.used.delete(handle.id); scope.readNotes.delete(handle.id);
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
        if(scope.getMixedArticleFilters())return {error:"ambiguous_article_selection"};
        const selected=scope.selectedArticleHandles();
        if(!selected)return {error:"missing_or_invalid_article_selection"};
        scope.markUsedSelectedArticleTool();
        return scope.articleCoverage.summary(selected);
      },
      verify:(r:Record<string,unknown>)=>r.scope==="current_agent_turn_verified_reads" &&
        Number.isSafeInteger(r.selectedCount) && Array.isArray(r.entries) &&
        r.entries.length===r.selectedCount &&
        r.originalWebPagesVerified===0 ? "read" as const : "failed" as const,
      },
    ] : []),
  ];
}
