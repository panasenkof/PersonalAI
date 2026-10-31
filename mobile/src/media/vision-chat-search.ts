/** #83.3 Chat entry for the existing encrypted visual retrieval.
 * Explicit local-photo requests never need or contact a cloud LLM. This is
 * an intent/format adapter, not a new search route or second search engine.
 */
import { photoSearchReadiness83 } from "./vision-index-pages";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import type { ChatMemoryRef } from "../direct-agent/conversations";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import { searchWithVision83 } from "./vision-memory-query";
import { preparePhotoMatchChatAttachment83 } from "./vision-photo-query";

export type LocalPhotoIntent83 = { mode:"text"|"image"|"all"; description:string };
/** Provisional Vivo X200 Pro / EmbeddingGemma 2 cosine floors, not probabilities.
 * Test set: text relevant >= .6682 vs unrelated <= .6244; image related
 * .8587 vs unrelated .6902. Re-evaluate on larger positives/negatives in 83.6.
 */
export const VISION_TEXT_FLOOR83 = 0.65;
export const VISION_IMAGE_FLOOR83 = 0.77;
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
  if(!photoWord.test(prompt)) {
    // Short object searches cover notes AND image originals. Do not intercept
    // conversations, people, documents or complex questions: the agent must
    // retain their richer retrieval and evidence path.
    if(attachments.length)return null;
    const match=/^(?:найди|найти|покажи|показать|отыщи|разыщи|ищи|поищи)\s+(?:мне\s+)?(.+)$/iu.exec(prompt);
    if(!match)return null;
    const object=match[1].replace(/[.!]+$/u,"").trim();
    if(!object || object.length>100 || object.split(/\s+/u).length>6 ||
      /(?:разговор|бесед|сестр|брат|родител|мам|пап|доч|сын|рецепт|документ|заметк|контакт|сообщени|письм|ссылк|сайт|инструкц|проект|задач|договор|полис|событи|истори|информаци|новост|про\s+меня)/iu.test(object))return null;
    return {mode:"all",description:object};
  }
  const description=prompt
    .replace(/^(?:у меня есть|есть ли у меня|сохранил(?:а)? ли я)\s+/iu, "")
    .replace(/^\s*(?:найди|найти|покажи|показать|отыщи|разыщи|ищи|поищи|поиск|find|search|show)\s+(?:мне\s+)?/iu,"")
    .replace(/^\s*(?:фотографии|фотографию|фотографий|фотография|фото|снимки|снимок|изображения|изображение|картинки|картинку|photos?|pictures?|images?)\s*/iu,"")
    .trim();
  return {mode:"text",description:description.length>1?description:prompt};
}

/** Suggest only a short photo description. The caller still requires a tap. */
export function localPhotoSuggestion83(question: string, attachments: readonly ChatAttachment[] = []): LocalPhotoIntent83 | null {
  const prompt = question.trim();
  if (attachments.length || prompt.length > 200 || externalWeb.test(prompt) || localPhotoIntent83(prompt)) return null;
  if (!/^(?:фото|фотография|фотографии|снимок|снимки|изображение|изображения)\s+[^?]+$/iu.test(prompt)) return null;
  return localPhotoIntent83("Найди " + prompt);
}

export async function searchLocalPhotosFromChat83(
  profile:string,intent:LocalPhotoIntent83,attachments:readonly ChatAttachment[]=[],
  signal?:AbortSignal,
):Promise<{ text:string; memory:ChatMemoryRef[]; photoAction?: "model" | "import" | "prepare" }> {
  const guard=()=> {
    if(signal?.aborted)throw new Error("vision_query_cancelled");
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
  };
  guard();
  if(intent.mode==="image" && attachments.filter(a=>a.kind==="image").length!==1)
    throw new Error("vision_query_one_image");
  if(intent.mode==="all") {
    // A single existing searchMemory call fuses FTS, MiniLM and vision, under
    // standard collection ACL. Missing vision weights still permit text hits.
    const hits=await searchWithVision83(profile,intent.description,{
      sensitivities:["standard","inherit"],limit:20,
      includeTextVector:true,standardCollectionsOnly:true,
      minImageSimilarity:VISION_TEXT_FLOOR83,
    });
    guard();
    // The chat presents at most six closest photos, while ordinary matching
    // notes are still included without modifying their memory evidence.
    let photoCountShown=0;
    const memory:ChatMemoryRef[]=hits.flatMap((hit):ChatMemoryRef[]=>{
      const images=hit.originals?.filter(file=>file.kind==="image") || [];
      return images.length ? images.map(image=>({
        id:hit.entity.id,title:(hit.entity.title||"Фотография в памяти").slice(0,160),
        via:"search" as const,photo:true,photoAttachmentId:image.attachmentId,
      })) : [{id:hit.entity.id,title:(hit.entity.title||"Запись в памяти").slice(0,160),
        via:"search" as const}];
    }).filter(item=>!item.photo || photoCountShown++ < 6);
    const photoCount=memory.filter(item=>item.photo).length;
    const noteCount=memory.length-photoCount;
    const noteNoun=noteCount===1?"запись":noteCount<5?"записи":"записей";
    return {memory,text:memory.length
      ? `Нашёл в памяти: ${photoCount ? `${photoCount} фото` : ""}${photoCount && noteCount ? " и " : ""}${noteCount ? `${noteCount} ${noteNoun}` : ""}. Нажмите на результат, чтобы открыть его.`
      : "В доступной памяти совпадений не найдено. Если фотографии добавлены недавно, проверьте их подготовку в настройках."};
  }
  const readiness = await photoSearchReadiness83(profile, signal);
  guard();
  if (readiness === "model_missing") return {text:"Для поиска фотографий нужна модель на телефоне.",memory:[],photoAction:"model"};
  if (readiness === "empty") return {text:"Пока нет фотографий, доступных для поиска.",memory:[],photoAction:"import"};
  if (readiness === "unprepared") return {text:"Фотографии есть. Подготовьте их для первого поиска.",memory:[],photoAction:"prepare"};
  const hits=intent.mode==="image"
    ? await (async()=>{
        const vector=await preparePhotoMatchChatAttachment83(attachments.find(a=>a.kind==="image")!,signal);
        guard();
        return withLocalMemoryDatabase(profile,db=>new SqliteMemoryRepository(db)
          .searchMemory("",{
            sensitivities:["standard","inherit"],limit:20,
            imageVector:{model:vector.model,values:vector.values},
            minImageSimilarity:VISION_IMAGE_FLOOR83,
          }));
      })()
    : await searchWithVision83(profile,intent.description,{
        sensitivities:["standard","inherit"],limit:20,requireVisionModel:true,
        minImageSimilarity:VISION_TEXT_FLOOR83,
      });
  guard();
  // A note can hold several photos: each matching original gets its own
  // result card; no photos vanish merely because they share a record ID.
  const memory:ChatMemoryRef[]=hits.flatMap(hit=>
    (hit.originals||[]).filter(file=>file.kind==="image").map(image=>({
      id:hit.entity.id,
      title:(hit.entity.title || "Фотография в памяти").slice(0,160),
      via:"search" as const,
      photo:true,
      photoAttachmentId:image.attachmentId,
    }))).slice(0,6);
  return {
    text:memory.length
      ? `Нашёл подходящие фотографии: ${memory.length}. Самая близкая показана сразу, остальные до пяти доступны по кнопке. Нажмите на снимок, чтобы открыть оригинал.`
      : "Среди подготовленных доступных фотографий похожих не найдено. Попробуйте другое описание или снимок предмета крупнее. Если вы недавно добавили фото, подготовьте их для поиска в настройках.",
    memory,
    ...(!memory.length && (readiness === "partial" || readiness === "unknown") ? {photoAction:"prepare" as const} : {}),
  };
}
