/** Small pure bridge for validated links in Telegram text/captions.
 * This does NOT read websites, trust authors, or fetch Telegram metadata. */
export type TelegramEntity={type:string;offset:number;length:number;url?:string};
export const isSafeTelegramLink=(value:unknown):value is string=>
  typeof value==="string"&&value.startsWith("https://")&&value.length<=2000&&
  value.length>8&&!/[\u0000-\u001f\u007f]/.test(value);
export function validTelegramLinks(raw:unknown):raw is string[]{
  return Array.isArray(raw)&&raw.length<=10&&raw.every(isSafeTelegramLink);
}
/** Bot API uses offset/length in UTF-16 code units; JS slice uses the same. */
export function telegramBotLinks(text:string,entities:unknown):string[]{
  if(!Array.isArray(entities)||entities.length>1000)return [];
  const seen=new Set<string>();
  for(const candidate of entities){
    if(!candidate||typeof candidate!=="object")continue;
    const entity=candidate as TelegramEntity;
    const value=entity.type==="text_link"?entity.url:
      entity.type==="url"&&Number.isSafeInteger(entity.offset)&&
      Number.isSafeInteger(entity.length)&&entity.offset>=0&&entity.length>0&&
      entity.offset<=text.length&&entity.length<=text.length-entity.offset
        ?text.slice(entity.offset,entity.offset+entity.length):undefined;
    if(isSafeTelegramLink(value))seen.add(value);
    if(seen.size>=10)break;
  }
  return [...seen];
}
export type LinkedTelegramText={body:string;sourceUrl?:string;sourceCoverage?:"url_only"};
export function telegramLinkedText(text:string,rawUrls?:string[]):LinkedTelegramText{
  const body=text.trim();
  const urls=[...new Set((rawUrls||[]).filter(isSafeTelegramLink))].slice(0,10);
  const hidden=urls.filter(url=>!body.includes(url));
  const final=hidden.length?body+"\n\nСсылки:\n"+hidden.join("\n"):body;
  if(final.length>60000)throw new Error("telegram_links_body_too_long");
  return {body:final,...(urls.length===1?{sourceUrl:urls[0],sourceCoverage:"url_only" as const}:{})};
}
