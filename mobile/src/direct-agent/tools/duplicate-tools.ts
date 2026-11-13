/** S9-2b: one read-only ToolSpec in the existing agent catalogue.
 * No model-side merge, alternate command parser or persistent handle cache. */
import type { DirectAgentOptions } from "../engine";
import type { ToolSpec } from "./types";

export function duplicateTools(options:DirectAgentOptions):ToolSpec[] {
  if (!options.findDuplicateCandidates || options.skipLocalMemory) return [];
  return [{
    definition:{
      name:"find_duplicate_candidates",
      description:"Найди ТОЧНЫЕ дубли обычных активных заметок на устройстве: по одинаковому source_url или SHA-256 нормализованного текста. Возвращаются только ID, версии, названия, разделы и счётчики; не содержимое. Не ищи похожие по смыслу и не утверждай, что все записи проверены, если scanTruncated=true. Этот инструмент никогда ничего не объединяет.",
      parameters:{type:"object",properties:{
        kind:{type:"string",enum:["same_url","same_text"]},
        limit:{type:"integer",minimum:1,maximum:10},
      },required:["kind","limit"],additionalProperties:false},
    },
    guidance:"При просьбе «найди дубли» используй этот локальный инструмент. Покажи группы и объясни основание same_url/same_text. Найденные совпадения — кандидаты, не разрешение на слияние. При scanTruncated=true явно скажи, что сканирование неполное. Объединение возможно только после отдельного предложения и подтверждения пользователя.",
    effect:"read",
    execute:async args=>{
      if(Object.keys(args).sort().join(",")!=="kind,limit" ||
         (args.kind!=="same_url"&&args.kind!=="same_text") ||
         !Number.isSafeInteger(args.limit) || (args.limit as number)<1 ||
         (args.limit as number)>10)
        return {error:"invalid_duplicate_candidate_request"};
      const found=await options.findDuplicateCandidates!(
        args.kind as "same_url"|"same_text",args.limit as number);
      // Explicit result shape: metadata only, never text, URL or SHA.
      return {kind:found.kind,groups:found.groups,scope:found.scope,
        contentIncluded:false,scanned:found.scanned,
        scanTruncated:found.scanTruncated,moreGroups:found.moreGroups};
    },
    verify:r=>r.scope==="standard_active_notes" && r.contentIncluded===false &&
      Array.isArray(r.groups) && r.groups.length<=10 &&
      typeof r.scanned==="number" && typeof r.scanTruncated==="boolean"
      ? r.groups.length?"found":"empty":"failed",
  }];
}
