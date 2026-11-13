/** S9-1b: the existing provider-independent catalog owns Inbox consent/read.
 * The host supplies one-turn access; tools cannot grant access or write notes.
 */
import type { DirectAgentOptions } from "../engine";
import type { InboxTriageApproval } from "../inbox-triage";
import type { ToolSpec } from "./types";

export function inboxTriageTools(options: DirectAgentOptions): {
  specs: ToolSpec[];
  approval: () => InboxTriageApproval | undefined;
} {
  let pending: InboxTriageApproval | undefined;
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

  return {specs,approval:()=>pending};
}
