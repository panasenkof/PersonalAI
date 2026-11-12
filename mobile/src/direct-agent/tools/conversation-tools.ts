import type { DirectAgentOptions } from "../engine";
import { validateContextCandidate } from "../conversation-context";
import { checkedNoteTags } from "../../local-memory/note-tags";
import { TASK_STATE_TOOL, updateTaskInterpretation, WORKSPACE_MAX_ENTRIES, WORKSPACE_ENTRY_MAX_CHARS } from "../task-state";
import type { TaskWorkspaceEntry } from "../task-state";
import type { ToolSpec, TurnState } from "./types";

/** One per-turn state machine for dialogue metadata and bounded task scratchpad. */
export function conversationTools(options:DirectAgentOptions,turn:TurnState):{contextTool:ToolSpec;importMetadataTool:ToolSpec;taskTool:ToolSpec;workspace:ToolSpec[]}{
  const contextTool:ToolSpec = { definition:{name:"set_conversation_context",
      description:"Определить или исправить ТЕМУ и РАЗДЕЛ текущего диалога — не переносит, не сохраняет и не читает записи памяти. Вызывай при первой содержательной теме и при явном изменении темы/раздела, включая запрос пользователя исправить классификацию. Не вызывай из-за короткого уточнения. Раздел — только существующий slug; если не уверен, null. При закреплённом разделе менять можно только тему. Приложение покажет изменение в конце ответа ПОСЛЕ успешного сохранения истории, не повторяй статус в тексте.",
      parameters:{type:"object",properties:{
        topic:{type:"string",minLength:2,maxLength:80,description:"Короткое содержательное название темы на языке пользователя."},
        sectionSlug:{type:["string","null"],description:"Точный slug уже существующей коллекции: "+(options.sections||[]).map(s=>s.slug+"="+s.name).join("; ")+". null при отсутствии основания."},
        reason:{type:"string",minLength:2,maxLength:180,description:"Одно короткое основание по текущему пользовательскому сообщению или реально прочитанным вложениям."},
      },required:["topic","sectionSlug","reason"],additionalProperties:false},
    },effect:"conversation",
    execute:async args=>{
      if(turn.contextCandidate)return {error:"conversation_context_already_proposed_this_turn"};
      const checked=validateContextCandidate(args,options.sections||[],options.context);
      if("error" in checked)return {error:checked.error};
      (turn.contextCandidate=checked.candidate);
      return {status:"pending_conversation_commit",saved:false,sectionSlug:checked.candidate.sectionSlug,topic:checked.candidate.topic,
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
    if(turn.contextCandidate || turn.importTagsCandidate!==undefined)return {error:"import_metadata_already_proposed"};
    if(!Array.isArray(args.tags)||args.tags.length>5)return {error:"invalid_import_tags"};
    const {topic,sectionSlug,reason}=args;
    const checked=validateContextCandidate({topic,sectionSlug,reason},options.sections||[],options.context);
    if("error" in checked)return {error:checked.error};
    let tags:string[];
    try { tags=checkedNoteTags(args.tags); } catch { return {error:"invalid_import_tags"}; }
    (turn.contextCandidate=checked.candidate);
    (turn.importTagsCandidate=tags);
    return {status:"pending_import_save",saved:false,sectionSlug:checked.candidate.sectionSlug,tags};
  },verify:r=>r.status==="pending_import_save"&&r.saved===false?"pending_confirmation":"failed"};
  const taskSpecs:ToolSpec[]=[
    { definition: TASK_STATE_TOOL, effect: "conversation", execute: async args => {
        turn.state = { ...updateTaskInterpretation(turn.state, args), webPreference: turn.state.webPreference }; turn.emit();
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
        if(turn.state.workspace && turn.state.workspace.goal!==turn.state.goal)return {error:"workspace_task_changed_clear_first"};
        const entry={key:args.key,kind:args.kind,content:args.content} as TaskWorkspaceEntry;
        const previous=turn.state.workspace?.entries||[];
        if(previous.length>=WORKSPACE_MAX_ENTRIES && !previous.some(e=>e.key===entry.key))
          return {error:"workspace_capacity_reached"};
        const entries=[...previous.filter(e=>e.key!==entry.key),entry];
        const next={...turn.state,workspace:{version:1 as const,goal:turn.state.goal,entries}};
        await options.saveWorkspace!(next);
        turn.state=next;
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
        if(turn.state.workspace && turn.state.workspace.goal!==turn.state.goal)return {error:"workspace_task_changed_clear_first"};
        const entries=turn.state.workspace?.entries||[];
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
        if(turn.state.workspace && turn.state.workspace.goal!==turn.state.goal)return {error:"workspace_task_changed_clear_first"};
        const entry=turn.state.workspace?.entries.find(e=>e.key===args.key);
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
        const discarded=turn.state.workspace?.entries.length||0;
        const next={...turn.state,workspace:undefined};
        await options.saveWorkspace!(next);
        turn.state=next;
        return {status:"workspace_cleared",discarded,personalMemoryDeleted:false};
      },
      verify:(r:Record<string,unknown>)=>r.status==="workspace_cleared"&&
        r.personalMemoryDeleted===false?"state_updated" as const:"failed" as const,
      },
    ] as ToolSpec[] : []),
  ];
  return {contextTool,importMetadataTool,taskTool:taskSpecs[0],workspace:taskSpecs.slice(1)};
}
