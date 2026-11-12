import type { DirectAgentOptions } from "../engine";
import type { ToolSpec, TurnState } from "./types";

/** ARCH-2: photo search remains local; only attachment handles reach the LLM. */
export function photoTools(options:DirectAgentOptions, turn:TurnState):ToolSpec[] {
  return [
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
        if(turn.photoLookups>=2)return {error:"local_photo_turn_budget_exhausted"};
        turn.photoLookups++;
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
          if(!turn.photoMatches.some(prev=>prev.id===item.id &&
            prev.photoAttachmentId===item.photoAttachmentId) && turn.photoMatches.length<20)
            turn.photoMatches.push({id:item.id,title:item.title,via:"search",photo:true,
              photoAttachmentId:item.photoAttachmentId});
        }
        if(!turn.photoMatches.length)(turn.photoRecovery=found.photoAction);
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
  ];
}
