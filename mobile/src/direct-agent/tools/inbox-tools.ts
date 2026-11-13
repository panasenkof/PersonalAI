/** S9-1b: the existing provider-independent catalog owns Inbox consent/read.
 * The host supplies one-turn access; tools cannot grant access or write notes.
 */
import type { DirectAgentOptions } from "../engine";
import type { InboxTriageApproval } from "../inbox-triage";
import type { InboxTriageProposal } from "../inbox-triage-proposal";
import type { ToolSpec } from "./types";

export function inboxTriageTools(options: DirectAgentOptions): {
  specs: ToolSpec[];
  approval: () => InboxTriageApproval | undefined;
  proposal: () => InboxTriageProposal | undefined;
} {
  let pending: InboxTriageApproval | undefined;
  let suggestion: InboxTriageProposal | undefined;
  const specs: ToolSpec[] = [];

  if (options.requestInboxTriageApproval && !options.skipLocalMemory) specs.push({
    definition: {
      name: "request_inbox_triage_access",
      description: "Когда пользователь просит разобрать или распределить «Входящие», сначала запроси разрешение у пользователя через эту карточку. Никаких записей или текста пока не читается. После нажатия пользователем «Разрешить разбор» отдельный следующий ход получит единственный инструмент просмотра. Не утверждай, что уже разобрал или перенёс заметки.",
      parameters: { type: "object", properties: {
        limit: { type: "integer", minimum: 1, maximum: 10 },
      }, required: ["limit"], additionalProperties: false },
    },
    effect: "proposal",
    execute: async args => {
      if (pending) return {error:"inbox_approval_already_requested_this_turn"};
      if (Object.keys(args).join(",") !== "limit" ||
          !Number.isSafeInteger(args.limit) || (args.limit as number) < 1 ||
          (args.limit as number) > 10) return {error:"invalid_inbox_triage_limit"};
      pending = options.requestInboxTriageApproval!(args.limit as number);
      return {status:"awaiting_user_confirmation",requiresUserTap:true,
        contentRead:false,saved:false,limit:pending.limit};
    },
    verify: result => result.status==="awaiting_user_confirmation" &&
      result.requiresUserTap===true && result.contentRead===false &&
      result.saved===false ? "pending_confirmation":"failed",
  });

  if (options.listInboxForTriage) specs.push({
    definition: {
      name:"list_inbox_for_triage",
      description:"После нажатия пользователем кнопки разрешения прочитай только выделенную пачку «Входящих». До 10 записей за ход; возвращаются title, id, версия, не более 600 символов и теги. Ничего не сохраняй и не переноси. Не отправляй содержимое в веб-поиск и не заявляй, что операция завершена.",
      parameters:{type:"object",properties:{
        limit:{type:"integer",minimum:1,maximum:10},
        cursor:{type:["integer","null"],minimum:0,maximum:100000},
      },required:["limit","cursor"],additionalProperties:false},
    },
    guidance:"Есть согласие пользователя на чтение ограниченной пачки «Входящих». Вызови list_inbox_for_triage, предложи разумные разделы и теги в ответе, но не утверждай, что записи перенесены: изменение требует отдельного подтверждения и ещё не выполняется.",
    effect:"read",
    execute:async args=>{
      if (Object.keys(args).length!==2 || Object.keys(args).some(k=>k!=="limit"&&k!=="cursor") ||
          !Number.isSafeInteger(args.limit) || (args.limit as number)<1 ||
          (args.limit as number)>10 ||
          (args.cursor!==null && (!Number.isSafeInteger(args.cursor) ||
            (args.cursor as number)<0 || (args.cursor as number)>100000)))
        return {error:"invalid_inbox_triage_args"};
      const page=await options.listInboxForTriage!({
        limit:args.limit as number,
        ...(args.cursor===null?{}:{cursor:args.cursor as number}),
      });
      return {items:page.items,
        ...(page.nextCursor===undefined?{}:{nextCursor:page.nextCursor})};
    },
    verify: result => Array.isArray(result.items)&&result.items.length<=10 ?
      result.items.length ? "found":"empty":"failed",
  });

  if (options.listInboxForTriage && options.proposeInboxTriage) specs.push({
    definition: {
      name: "propose_inbox_triage",
      description: "После разрешённого чтения «Входящих» предложи разделы и теги для прочитанных заметок. ID и версии копируй только из list_inbox_for_triage этого же хода. Не изменяй заметки: пользователь отдельно выберет и подтвердит перенос.",
      parameters: {type:"object",properties:{
        items:{type:"array",minItems:1,maxItems:10,items:{type:"object",properties:{
          noteId:{type:"string",minLength:1,maxLength:128},
          expectedVersion:{type:"integer",minimum:1},
          targetSectionSlug:{type:"string",minLength:1,maxLength:80},
          tags:{type:"array",maxItems:5,items:{type:"string",maxLength:33}},
          reason:{type:"string",minLength:5,maxLength:240},
        },required:["noteId","expectedVersion","targetSectionSlug","tags","reason"],
          additionalProperties:false}},
      },required:["items"],additionalProperties:false},
    },
    guidance:"Пользователь разрешил чтение только этой пачки. Сначала вызови list_inbox_for_triage, затем propose_inbox_triage с точными ID и версиями из результата. Новые разделы не создавай. Не заявляй, что записи уже перенесены.",
    effect:"proposal",
    execute: async args => {
      if (suggestion) return {error:"inbox_triage_proposal_already_created"};
      if (Object.keys(args).join(",")!=="items" || !Array.isArray(args.items))
        return {error:"invalid_inbox_triage_proposal"};
      const proposed = await options.proposeInboxTriage!(args);
      suggestion = proposed;
      return {status:"awaiting_user_confirmation",saved:false,
        requiresUserTap:true,count:proposed.items.length};
    },
    verify:r=>r.status==="awaiting_user_confirmation" &&
      r.saved===false && r.requiresUserTap===true ? "pending_confirmation" : "failed",
  });

  return {specs,approval:()=>pending,proposal:()=>suggestion};
}
