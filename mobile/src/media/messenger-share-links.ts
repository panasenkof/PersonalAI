/** MSG-0/MSG-1. Identify one link delivered by Android Share without any network
 * request. This is NOT a source-content verifier and never grants access.
 * The existing publicImportUrl/importLink and canonical saveMediaNote remain
 * the only URL safety gate, explicit fetch and durable note writer.
 */
export type SharedLinkPreview = {
  url: string;
  platform: "telegram" | "max" | "web";
  kind: "public_post_candidate" | "link_only" | "restricted";
  /** Enabled only for a possible public web document, never a chat invite. */
  canFetch: boolean;
};
type ShareText = { shareType: string; value: string };
const linkToken = /https:\/\/[^\s<>"'\u201c\u201d]+/gi;
const telegramHandle = /^[a-z][a-z0-9_]{4,31}$/i;
const postId = /^[1-9][0-9]{0,17}$/;
function safeCandidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/[.,;!?\u2026]+$/u,"");
  if(trimmed.length>4096) return null;
  try {
    const u=new URL(trimmed);
    const host=u.hostname.toLowerCase();
    if(u.protocol!=="https:"||u.username||u.password||u.port||
       !host.includes(".")||host.endsWith(".local")||host.endsWith(".internal")||
       host.endsWith(".localhost")||/^[0-9.]+$/.test(host)||host.includes(":"))
      return null;
    return u.toString();
  }catch{return null;}
}
/** Exact one HTTPS URL in a Share text. Never silently pick one out of several.
 * A standalone URL from Share still uses the exact same normalization.
 */
export function sharedLinkPreview(payload:ShareText):SharedLinkPreview|null{
  if(!payload||typeof payload.value!=="string"||payload.value.length>60_000||
     !["text","url"].includes(payload.shareType))return null;
  const raw=payload.value.trim();
  const matches=raw.match(linkToken)||[];
  if(matches.length!==1)return null;
  const source=safeCandidate(matches[0]);
  if(!source)return null;
  const u=new URL(source);
  const host=u.hostname.toLowerCase();
  const segments=u.pathname.split("/").filter(Boolean);
  const tg=host==="t.me"||host==="telegram.me"||host==="www.t.me"||
    /^[a-z0-9_]+\.t\.me$/i.test(host);
  if(tg){
    const leading=segments[0]?.toLowerCase();
    const restricted=leading==="c"||leading==="joinchat"||leading==="contact"||
      leading==="addlist"||leading==="+"||Boolean(leading?.startsWith("+"));
    if(restricted)return {url:source,platform:"telegram",kind:"restricted",canFetch:false};
    const publicSegments=leading==="s"?segments.slice(1):segments;
    const channel=host.endsWith(".t.me")&&host!=="www.t.me"?host.slice(0,-5):publicSegments[0];
    const message=host.endsWith(".t.me")&&host!=="www.t.me"?segments[0]:publicSegments[1];
    const isPost=Boolean(channel&&telegramHandle.test(channel)&&message&&postId.test(message)&&
      (host.endsWith(".t.me")&&host!=="www.t.me"?segments.length===1:publicSegments.length===2));
    return {url:source,platform:"telegram",kind:isPost?"public_post_candidate":"link_only",
      canFetch:isPost};
  }
  if(["max.ru","www.max.ru","web.max.ru"].includes(host)){
    const leading=segments[0]?.toLowerCase();
    const restricted=["join","joinchannel","joinchat","joincall"].includes(leading) ||
      leading==="invite";
    return {url:source,platform:"max",kind:restricted?"restricted":"link_only",
      canFetch:false};
  }
  return payload.shareType==="url"
    ? {url:source,platform:"web",kind:"link_only",canFetch:true}
    : null;
}
