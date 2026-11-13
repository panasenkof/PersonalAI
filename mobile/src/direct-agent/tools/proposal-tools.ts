import type { DirectAgentOptions } from "../engine";
import { FACT_TOOL_NAME, FACT_TOOL_DESCRIPTION, factToolParameters, factProposal } from "../fact-tool";
import { validMoveProposal } from "../move-proposal";
import { verifyDuplicateMergeRequest } from "../duplicate-merge-gate";
import { validSectionProposal, type ChatSectionProposal } from "../section-actions";
import { sectionToolError } from "./helpers";
import type { ToolSpec, TurnState } from "./types";

/** ARCH-2: all memory mutations remain proposals, never direct device writes. */
export function proposalTools(options:DirectAgentOptions,turn:TurnState):{move:ToolSpec[];section:ToolSpec[];duplicates:ToolSpec[];draft:ToolSpec}{
  const move:ToolSpec[]=[
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
        if(turn.movePreview)return {error:"move_preview_already_proposed_this_turn"};
        const id=args.noteId, version=args.expectedVersion, to=args.targetSectionSlug, reason=args.reason;
        if(Object.keys(args).length!==4 ||
           typeof id!=="string"||!/^[A-Za-z0-9:_-]{1,128}$/.test(id) ||
           !Number.isSafeInteger(version)||(version as number)<1 ||
           typeof to!=="string"|| !/^[a-z0-9_-]{1,80}$/.test(to) ||
           typeof reason!=="string"||reason.trim().length<5||reason.length>240)
          return {error:"invalid_move_arguments"};
        if(turn.moveHandles.get(id)!==version)
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
        (turn.movePreview=proposed);
        return {status:"awaiting_user_confirmation",saved:false,
          noteId:proposed.noteId,version:proposed.expectedVersion,
          title:proposed.title,fromSection:proposed.fromName,toSection:proposed.toName,
          attachmentsPreserved:proposed.attachmentCount,sourceLinksPreserved:proposed.hasSource,
          reason:proposed.reason,requiresUserTap:true};
      },
      verify:(r:Record<string,unknown>)=>r.status==="awaiting_user_confirmation" &&
        r.saved===false && r.requiresUserTap===true ? "pending_confirmation" as const : "failed" as const,
    }] : []),
  ];
  const section:ToolSpec[]=[
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
        if(turn.sectionPreview)return {error:"section_action_already_proposed_this_turn"};
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
        (turn.sectionPreview=proposed);
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
        if(turn.sectionPreview)return {error:"section_action_already_proposed_this_turn"};
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
        (turn.sectionPreview=proposed);
        return {status:"awaiting_user_confirmation",saved:false,requiresUserTap:true,
          action:"delete",name:proposed.name,parent:proposed.parentName,
          recordCount:0,childCount:0};
      },
      verify:(v:Record<string,unknown>)=>v.status==="awaiting_user_confirmation"&&v.saved===false&&
        v.requiresUserTap===true?"pending_confirmation" as const:"failed" as const,
    }] : []),
  ];
  /** S9-2b: a no-write proposal staged from ONE complete exact group in the
   * same model turn; never merge here, never trust an invented candidate ID. */
  const duplicates:ToolSpec[]=options.findDuplicates && !options.skipLocalMemory ? [{
    definition:{
      name:"propose_merge_notes",
      description:"Предложить объединение только одной ПОЛНОЙ группы из find_duplicate_candidates этого же хода. Передай все ID и record versions группы; keepNoteId — какую запись сохранить. После вызова требуется отдельное подтверждение пользователя; объединять самостоятельно запрещено.",
      parameters:{type:"object",properties:{
        noteIds:{type:"array",minItems:2,maxItems:5,items:{type:"string",minLength:1,maxLength:128}},
        expectedVersions:{type:"array",minItems:2,maxItems:5,items:{type:"integer",minimum:1}},
        keepNoteId:{type:"string",minLength:1,maxLength:128},
        reason:{type:"string",minLength:5,maxLength:240},
      },required:["noteIds","expectedVersions","keepNoteId","reason"],additionalProperties:false},
    },
    effect:"proposal" as const,
    execute:async args=>{
      if(turn.duplicateMergePreview)return {error:"merge_preview_already_proposed_this_turn"};
      if(options.signal?.aborted)throw new Error("aborted");
      let preview;
      try {preview=verifyDuplicateMergeRequest(args,turn.duplicateGroups);}
      catch {return {error:"invalid_or_unverified_duplicate_merge_proposal"};}
      if(options.signal?.aborted)throw new Error("aborted");
      turn.duplicateMergePreview=preview;
      return {status:"awaiting_user_confirmation",saved:false,
        requiresUserTap:true,keepNoteId:preview.keepNoteId,
        noteCount:preview.noteIds.length,attachments:preview.attachmentCount,
        sourceTagEntries:preview.sourceTagEntries};
    },
    verify:r=>r.status==="awaiting_user_confirmation" && r.saved===false &&
      r.requiresUserTap===true ? "pending_confirmation" as const : "failed" as const,
  }] : [];

  const draftSpecs:ToolSpec[]=[
    { definition: { name: FACT_TOOL_NAME, description: FACT_TOOL_DESCRIPTION, parameters: factToolParameters(options.sections) }, effect: "proposal",
      execute: async args => {
        const proposal = factProposal(args, options.sections);
        const key = turn.fingerprint(proposal);
        if (turn.pending.has(key) && turn.pending.get(key)) turn.proposalIds.add(turn.pending.get(key)!);
        if (turn.pending.has(key)) return { status: "awaiting_user_confirmation", saved: false, duplicate: true, ...(turn.pending.get(key) ? { proposalId: turn.pending.get(key) } : {}) };
        const proposalId = options.propose(proposal);
        turn.pending.set(key, proposalId || undefined);
        if (proposalId) turn.proposalIds.add(proposalId);
        options.diagnostic?.("memory.tool_draft", { name: FACT_TOOL_NAME });
        return { status: "awaiting_user_confirmation", saved: false, ...(proposalId ? { proposalId } : {}) };
      }, verify: r => r.status === "awaiting_user_confirmation" && r.saved === false ? "pending_confirmation" : "failed" },
  ];
  return {move,section,duplicates,draft:draftSpecs[0]};
}
