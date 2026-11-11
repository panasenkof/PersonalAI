import type {SavedMessagePreview} from "./saved-messages";

/** The projection is newest-to-oldest. A page boundary is not proof that the
 * last Telegram album member has arrived: callers must fetch more history.
 * This module is read-only, and never writes, downloads or ACKs originals.
 */
export type SavedAlbumPlan =
  | {state:"pending";albumId:string;received:number;reason:"page_tail"|"legacy_source"}
  | {state:"ready";albumId:string;messages:SavedMessagePreview[];nextIndex:number};
const MAX_ALBUM_ORIGINALS=10;
const validAlbumId=(value:unknown):value is string=>
  typeof value==="string"&&/^-?[1-9][0-9]{0,18}$/.test(value);
/** Compare only native-supplied decimal strings; numbers corrupt 64-bit IDs. */
export function planSavedAlbum(page:SavedMessagePreview[],index:number):SavedAlbumPlan{
  const first=page[index];
  if(!first||first.hasAlbum!==true||!first.hasMedia)
    throw new Error("telegram_saved_album_invalid_head");
  if(!validAlbumId(first.albumId))
    return {state:"pending",albumId:"",received:1,reason:"legacy_source"};
  const albumId=first.albumId;
  const entries:SavedMessagePreview[]=[];
  let boundary=page.length;
  for(let i=index;i<page.length;i++){
    const item=page[i];
    if(item.hasAlbum===true&&item.albumId===albumId){
      if(!item.hasMedia||entries.some(p=>p.id===item.id))
        throw new Error("telegram_saved_album_invalid_part");
      entries.push(item);
      if(entries.length>MAX_ALBUM_ORIGINALS)
        throw new Error("telegram_saved_album_oversized");
      if(entries.length===MAX_ALBUM_ORIGINALS){boundary=i+1;break;}
    }else{boundary=i;break;}
  }
  // Even if two album IDs were interspersed with independent messages, never
  // misrepresent a partial set of photos as complete.
  if(page.slice(boundary).some(m=>m.hasAlbum===true&&m.albumId===albumId))
    throw new Error("telegram_saved_album_interleaved");
  if(entries.length<2||boundary===page.length&&entries.length<MAX_ALBUM_ORIGINALS)
    return {state:"pending",albumId,received:entries.length,reason:"page_tail"};
  return {state:"ready",albumId,messages:entries,nextIndex:boundary};
}
