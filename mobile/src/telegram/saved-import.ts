import {localMemorySessionUnlocked} from "../local-memory/storage";
import {saveMediaNote,MAX_TOTAL_ORIGINAL_BYTES} from "../media/attachments";
import {scheduleVectors} from "../media/vector-runner";
import {readSavedMessagesPage,type SavedMessagePreview} from "./saved-messages";
import {readSavedTopicPage,safeTopicId} from "./saved-topics";
import {downloadSavedOriginal,downloadSavedAlbumOriginal,releaseSavedOriginal,
  supportsSavedOriginal,type SavedOriginal} from "./saved-original";
import {planSavedAlbum,safeSavedAlbumId} from "./saved-album-plan";

export type SavedTextImportResult={
  saved:number; duplicates:number; unsupported:number; empty:number;
  nextCursor:string; selfChatId:string; pendingAlbum?:number;
};
const running=new Set<string>();
function unlocked(signal?:AbortSignal){
  if(signal?.aborted)throw new Error("telegram_saved_import_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
}
type AlbumUnit={kind:"album";albumId:string;messages:SavedMessagePreview[]};
type SingleUnit={kind:"single";item:SavedMessagePreview};
type Unit=AlbumUnit|SingleUnit;
const getPage=(profile:string,cursor:string,topicId?:string)=>
  topicId===undefined?readSavedMessagesPage(profile,cursor,20):
    readSavedTopicPage(profile,topicId,cursor,20);

/** Preserve at most one Telegram page of older context to close an album
 * spanning the user-visible 20-item boundary. No persisted batch queue.
 * A page tail cannot be declared complete merely by absence of a response.
 */
async function withAlbumBoundary(profile:string,topicId:string|undefined,
  page:{selfChatId:string;messages:SavedMessagePreview[]},signal?:AbortSignal){
  const messages=[...page.messages];
  const tail=messages[messages.length-1];
  if(!tail?.hasAlbum||!safeSavedAlbumId(tail.albumId))return messages;
  // A ten-item group has a verified source-defined maximum and needs no lookahead.
  const tailCount=messages.filter(m=>m.hasAlbum&&m.albumId===tail.albumId).length;
  if(tailCount>=10)return messages;
  unlocked(signal);
  const older=await getPage(profile,tail.id,topicId);
  unlocked(signal);
  if(older.selfChatId!==page.selfChatId)
    throw new Error("telegram_saved_album_source_changed");
  for(const item of older.messages){
    messages.push(item);
    if(item.albumId!==tail.albumId)break; // first older boundary is enough
  }
  return messages;
}

/** Explicit small-batch import. Originals are never converted to caption-only
 * notes; albums must have every member before one SQLCipher transaction.
 * Automatic on-open sync remains TEXT ONLY. The canonical writer remains the
 * only note/attachment writer; failures never advance the UI paging cursor.
 */
export async function importSavedTextPage(profile:string,cursor="0",
  signal?:AbortSignal,topicId?:string,
  mediaPolicy:"text-only"|"supported-originals"="text-only"):Promise<SavedTextImportResult>{
  unlocked(signal);
  if(topicId!==undefined&&!safeTopicId(topicId))
    throw new Error("telegram_saved_topic_request_invalid");
  if(mediaPolicy!=="text-only"&&mediaPolicy!=="supported-originals")
    throw new Error("telegram_saved_import_policy_invalid");
  if(running.has(profile))throw new Error("telegram_saved_import_running");
  running.add(profile);
  try{
    const page=await getPage(profile,cursor,topicId);
    unlocked(signal);
    const messages=mediaPolicy==="supported-originals"
      ?await withAlbumBoundary(profile,topicId,page,signal):page.messages;
    let safeNextCursor=messages.length?messages[messages.length-1].id:"";
    let pendingAlbum=0,saved=0,duplicates=0,unsupported=0,empty=0;
    const units:Unit[]=[];
    for(let i=0;i<messages.length;){
      const item=messages[i];
      if(mediaPolicy==="supported-originals"&&item.hasAlbum===true&&
        safeSavedAlbumId(item.albumId)){
        const plan=planSavedAlbum(messages,i);
        if(plan.state==="pending"){
          pendingAlbum=plan.received;
          // The NEXT request must include these incomplete members, not skip
          // them: the previous non-album ID becomes the next page anchor.
          safeNextCursor=i>0?messages[i-1].id:cursor;
          break;
        }
        units.push({kind:"album",albumId:plan.albumId,messages:plan.messages});
        i=plan.nextIndex;
        continue;
      }
      units.push({kind:"single",item});
      i++;
    }
    // The source is newest-to-oldest; save in chronological order.
    for(const unit of units.reverse()){
      unlocked(signal);
      if(unit.kind==="album"){
        const oldestFirst=[...unit.messages].reverse();
        const staged:SavedOriginal[]=[];
        let bytes=0;
        try{
          for(const item of oldestFirst){
            unlocked(signal);
            if(!item.hasMedia||!supportsSavedOriginal(item.kind))
              throw new Error("telegram_saved_album_kind_unsupported");
            const original=await downloadSavedAlbumOriginal(profile,page.selfChatId,item,signal);
            staged.push(original);
            bytes+=original.file.size||0;
            if(bytes>MAX_TOTAL_ORIGINAL_BYTES)
              throw new Error("Альбом Telegram превышает лимит 80 МБ.");
          }
          unlocked(signal);
          const ids=oldestFirst.map(v=>v.id);
          const captions=oldestFirst.flatMap((v,i)=>v.text.trim()
            ?[{index:i+1,text:v.text.trim()}]:[]);
          const body=captions.length===1?captions[0].text:
            captions.map(x=>"Файл "+x.index+": "+x.text).join("\n\n");
          if(body.length>60_000)
            throw new Error("Подписи альбома Telegram превышают 60 000 символов.");
          const title=body.split(/\r?\n/)[0].slice(0,160)||
            "Альбом Telegram ("+staged.length+" файлов)";
          let replayed=false;
          await saveMediaNote(profile,{
            files:staged.map(x=>x.file),title,body,sensitivity:"sensitive",
            receipt:"telegram-saved:"+page.selfChatId+":"+ids[0]+
              ":album:"+unit.albumId+":"+ids.join(","),
            telegramSavedMessage:{
              chatId:page.selfChatId,messageId:ids[0],date:oldestFirst[0].date,
              kind:"messageAlbum",mediaAlbumId:unit.albumId,messageIds:ids,
              ...(topicId!==undefined?{topicId}:{}),
            },onReplay:()=>{replayed=true;},
          },signal);
          if(replayed)duplicates++;else saved++;
        }finally{
          // Failure of ANY original/cipher operation must never create a
          // partial album; safely release only each previously staged file.
          for(const original of staged)await releaseSavedOriginal(profile,original);
        }
        continue;
      }

      const item=unit.item;
      if(item.hasAlbum===true){unsupported++;continue;} // old signed TDLib APK
      const textOnly=!item.hasMedia&&item.kind==="messageText";
      const originalRequested=mediaPolicy==="supported-originals"&&item.hasMedia&&
        supportsSavedOriginal(item.kind);
      if(!textOnly&&!originalRequested){unsupported++;continue;}
      const body=item.text.trim();
      if(textOnly&&!body){empty++;continue;}
      const original=originalRequested
        ?await downloadSavedOriginal(profile,page.selfChatId,item,signal):null;
      try{
        unlocked(signal);
        const title=body.split(/\r?\n/)[0].trim().slice(0,160)||
          original?.file.name||"Сообщение из Избранного";
        let replayed=false;
        await saveMediaNote(profile,{
          title,body,sensitivity:"sensitive",...(original?{file:original.file}:{}),
          receipt:"telegram-saved:"+page.selfChatId+":"+item.id,
          telegramSavedMessage:{
            chatId:page.selfChatId,messageId:item.id,date:item.date,
            kind:item.kind as "messageText"|"messagePhoto"|"messageDocument"|"messageVideo"|
              "messageAudio"|"messageVoiceNote"|"messageAnimation"|"messageVideoNote",
            ...(topicId!==undefined?{topicId}:{}),
          },onReplay:()=>{replayed=true;},
        },signal);
        if(replayed)duplicates++;else saved++;
      }finally{
        if(original)await releaseSavedOriginal(profile,original);
      }
    }
    unlocked(signal);
    if(saved)scheduleVectors(profile);
    return {saved,duplicates,unsupported,empty,nextCursor:safeNextCursor,
      selfChatId:page.selfChatId,...(pendingAlbum?{pendingAlbum}:{})};
  }finally{running.delete(profile);}
}
