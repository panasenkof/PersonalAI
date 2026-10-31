/** #83.3 Chat entry for the existing encrypted visual retrieval.
 * Explicit local-photo requests never need or contact a cloud LLM. This is
 * an intent/format adapter, not a new search route or second search engine.
 */
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import type { ChatMemoryRef } from "../direct-agent/conversations";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import { searchWithVision83 } from "./vision-memory-query";
import { preparePhotoMatchChatAttachment83 } from "./vision-photo-query";

export type LocalPhotoIntent83 = { mode:"text"|"image"; description:string };
const findVerb=/(?:найд|найти|ищ|поиск|поищ|покаж|показать|отыс|разыщ|find|search|show)/iu;
const photoWord=/(?:фото|фотограф|сним(?:ок|к|ки|ков)|изображен|картин|\b(?:photo|picture|image)s?\b)/iu;
const similarWord=/(?:похож|сходн|аналогич|такие же|такое же|similar|like this)/iu;
const externalWeb=/(?:в интернете|из интернета|в сети|онлайн|\bonline\b|\bweb\b)/iu;

/** Route only explicit requests, not "что на фото?" or all picture messages.
 * Non-photo conversations still take the established agent path.
 */
export function localPhotoIntent83(
  question:string, attachments:readonly ChatAttachment[] = [],
):LocalPhotoIntent83|null {
  const prompt=question.trim();
  const everydayPhotoQuestion = /^(?:у меня есть|есть ли у меня|сохранил(?:а)? ли я)\s+(?:фото|сним|изображен)/iu.test(prompt);
  if(!prompt || prompt.length>256 || externalWeb.test(prompt) || /^как(?:\s|[?.,])/iu.test(prompt) || (!findVerb.test(prompt) && !everydayPhotoQuestion))
    return null;
  const imageCount=attachments.filter(a=>a.kind==="image").length;
  if(imageCount && (similarWord.test(prompt) ||
    (photoWord.test(prompt) && /(?:по (?:этому|моему|приложенному)?\s*(?:фото|снимк|изображен)|как (?:на|здесь)|так(?:ое|ие) же)/iu.test(prompt))))
    return {mode:"image",description:""};
  if(!photoWord.test(prompt))return null;
  const description=prompt
    .replace(/^(?:у меня есть|есть ли у меня|сохранил(?:а)? ли я)\s+/iu, "")
    .replace(/^\s*(?:найди|найти|покажи|показать|отыщи|разыщи|ищи|поищи|поиск|find|search|show)\s+(?:мне\s+)?/iu,"")
    .replace(/^\s*(?:фотографии|фотографию|фотографий|фотография|фото|снимки|снимок|изображения|изображение|картинки|картинку|photos?|pictures?|images?)\s*/iu,"")
    .trim();
  return {mode:"text",description:description.length>1?description:prompt};
}

export async function searchLocalPhotosFromChat83(
  profile:string,intent:LocalPhotoIntent83,attachments:readonly ChatAttachment[]=[],
  signal?:AbortSignal,
):Promise<{ text:string; memory:ChatMemoryRef[] }> {
  const guard=()=> {
    if(signal?.aborted)throw new Error("vision_query_cancelled");
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
  };
  guard();
  if(intent.mode==="image" && attachments.filter(a=>a.kind==="image").length!==1)
    throw new Error("vision_query_one_image");
  const hits=intent.mode==="image"
    ? await (async()=>{
        const vector=await preparePhotoMatchChatAttachment83(attachments.find(a=>a.kind==="image")!,signal);
        guard();
        return withLocalMemoryDatabase(profile,db=>new SqliteMemoryRepository(db)
          .searchMemory("",{
            sensitivities:["standard","inherit"],limit:8,
            imageVector:{model:vector.model,values:vector.values},
          }));
      })()
    : await searchWithVision83(profile,intent.description,{
        sensitivities:["standard","inherit"],limit:8,requireVisionModel:true,
      });
  guard();
  const photos=hits.filter(hit=>hit.originals?.some(file=>file.kind==="image"));
  const memory:ChatMemoryRef[]=photos.map(hit=>({
    id:hit.entity.id,
    title:(hit.entity.title || "Фотография в памяти").slice(0,160),
    via:"search" as const,
    photo:true,
    photoAttachmentId:hit.originals?.find(file=>file.kind==="image")?.attachmentId,
  }));
  return {
    text:memory.length
      ? `${intent.mode === "image" ? "Похожие фото" : "Фото по описанию"} · записей: ${memory.length}. Нажмите на снимок, чтобы открыть его. Результаты упорядочены по сходству.`
      : "Среди подготовленных доступных фотографий похожих не найдено. Попробуйте другое описание или снимок предмета крупнее. Если вы недавно добавили фото, подготовьте их для поиска в настройках.",
    memory,
  };
}
