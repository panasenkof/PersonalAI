import { sharedLinkPreview } from "./messenger-share-links";

/** MSG-1: scoped extraction guard for the existing importLink HTML reader.
 * A Telegram /s/ page may have many messages. Never treat the whole feed or
 * a neighbouring post as the specifically requested message. No second fetch,
 * WebView, DOM, LLM or additional persistence mechanism.
 */
export type VerifiedTelegramMarkup={
  messageKey:string; textHtml:string; title:string; mediaMayBeMissing:boolean;
};
const classAttribute=(tag:string)=>{
  const m=/(?:^|\s)class\s*=\s*(["'])(.*?)\1/is.exec(tag);
  return m?.[2]?.split(/\s+/)||[];
};
const postAttribute=(tag:string)=>{
  const m=/(?:^|\s)data-post\s*=\s*(["'])(.*?)\1/is.exec(tag);
  return m?.[2]||"";
};
const cleanMarkup=(value:string)=>value
  .replace(/<!--[\s\S]*?-->/g,"")
  .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,"");
/** Return a bounded DIV subtree, not the rest of the whole channel feed. */
function innerDiv(markup:string,openEnd:number):string|null{
  const div=/<\/?div\b[^>]*>/gi;
  div.lastIndex=openEnd;
  let depth=1,steps=0;
  for(let m;(m=div.exec(markup))!==null;){
    if(++steps>20000)return null;
    if(/^<\/div/i.test(m[0]))depth--;
    else if(!/\/\s*>$/.test(m[0]))depth++;
    if(depth===0)return markup.slice(openEnd,m.index);
    if(depth<0)return null;
  }
  return null;
}
/** The key comes from the URL classifier; only an EXACT data-post match is
 * eligible. Absence, ambiguous duplicates, truncated markup, or media-only
 * posts fail closed so the user can save an honest link-only note instead.
 */
export function verifiedTelegramMessageMarkup(source:string,html:string):VerifiedTelegramMarkup{
  const key=sharedLinkPreview({shareType:"url",value:source});
  if(key?.platform!=="telegram"||key.kind!=="public_post_candidate"||
     !key.messageKey||typeof html!=="string"||html.length>1_048_576)
    throw new Error("invalid_telegram_public_post_request");
  const safe=cleanMarkup(html);
  const all=/<div\b[^>]*>/gi;
  let selected:string|null=null,seen=0;
  for(let tag;(tag=all.exec(safe))!==null;){
    if(!classAttribute(tag[0]).includes("tgme_widget_message"))continue;
    const identity=postAttribute(tag[0]);
    if(identity.toLowerCase()!==key.messageKey.toLowerCase())continue;
    seen++;
    if(seen>1)break;
    selected=innerDiv(safe,all.lastIndex);
  }
  if(seen!==1||selected===null)
    throw new Error("telegram_post_not_verified");
  const tags=/<div\b[^>]*>/gi;
  let textHtml:string|null=null,fields=0;
  for(let tag;(tag=tags.exec(selected))!==null;){
    if(!classAttribute(tag[0]).includes("tgme_widget_message_text"))continue;
    fields++;
    if(fields>1)break;
    textHtml=innerDiv(selected,tags.lastIndex);
  }
  if(fields!==1||!textHtml||!textHtml.replace(/<[^>]*>/g,"").trim())
    throw new Error("telegram_post_text_unavailable");
  const mediaMayBeMissing=/\btgme_widget_message_(?:photo|video|audio|document|sticker|poll|gif|voice)\b/i.test(selected);
  return {messageKey:key.messageKey,textHtml,title:"Telegram · "+key.messageKey,
    mediaMayBeMissing};
}
