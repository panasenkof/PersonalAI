import {localMemorySessionUnlocked} from "../local-memory/storage";
import {saveMediaNote} from "../media/attachments";
import {scheduleVectors} from "../media/vector-runner";
import {readSavedMessagesPage} from "./saved-messages";
import {readSavedTopicPage,safeTopicId} from "./saved-topics";
import {downloadSavedOriginal,releaseSavedOriginal,supportsSavedOriginal} from "./saved-original";

export type SavedTextImportResult={
  saved:number; duplicates:number; unsupported:number; empty:number;
  nextCursor:string; selfChatId:string;
};
const running=new Set<string>();
function unlocked(signal?:AbortSignal){
  if(signal?.aborted)throw new Error("telegram_saved_import_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
}

/** Explicit small-batch import. Original media never becomes a caption-only note.
 * Auto-sync stays text-only; original downloading requires a manual user action.
 * No persisted pagination cursor: unsupported media can be retried when supported.
 * The canonical memory writer owns SQLCipher, backup, FTS, receipt and replay.
 */
export async function importSavedTextPage(profile:string,cursor="0",
  signal?:AbortSignal,topicId?:string,
  mediaPolicy:"text-only"|"supported-originals"="text-only"):Promise<SavedTextImportResult>{
  unlocked(signal);
  if(topicId!==undefined&&!safeTopicId(topicId))throw new Error("telegram_saved_topic_request_invalid");
  if(mediaPolicy!=="text-only"&&mediaPolicy!=="supported-originals")
    throw new Error("telegram_saved_import_policy_invalid");
  if(running.has(profile))throw new Error("telegram_saved_import_running");
  running.add(profile);
  try{
    const page=topicId===undefined
      ? await readSavedMessagesPage(profile,cursor,20)
      : await readSavedTopicPage(profile,topicId,cursor,20);
    unlocked(signal);
    let saved=0,duplicates=0,unsupported=0,empty=0;
    // Preserve chronological ordering of new notes within the current page.
    for(const item of [...page.messages].reverse()){
      unlocked(signal);
      if(item.hasAlbum===true){unsupported++;continue;}
      const textOnly=!item.hasMedia&&item.kind==="messageText";
      const originalRequested=mediaPolicy==="supported-originals"&&item.hasMedia&&
        supportsSavedOriginal(item.kind);
      if(!textOnly&&!originalRequested){unsupported++;continue;}
      const body=item.text.trim();
      if(textOnly&&!body){empty++;continue;}
      // Native TDLib verifies getMe/self-chat and the exact message ID again,
      // and the JS boundary checks source, date, kind and unchanged caption.
      const original=originalRequested
        ? await downloadSavedOriginal(profile,page.selfChatId,item,signal):null;
      try{
        unlocked(signal);
        const title=body.split(/\r?\n/)[0].trim().slice(0,160)||
          original?.file.name||"Сообщение из Избранного";
        let replayed=false;
        await saveMediaNote(profile,{
          title,body,sensitivity:"sensitive",
          ...(original?{file:original.file}:{}),
          receipt:"telegram-saved:"+page.selfChatId+":"+item.id,
          telegramSavedMessage:{
            chatId:page.selfChatId,messageId:item.id,date:item.date,
            kind:item.kind as "messageText"|"messagePhoto"|"messageDocument"|"messageVideo"|
              "messageAudio"|"messageVoiceNote"|"messageAnimation"|"messageVideoNote",
            ...(topicId!==undefined?{topicId}:{}),
          },
          onReplay:()=>{replayed=true;},
        },signal);
        if(replayed)duplicates++;else saved++;
      }finally{
        if(original)await releaseSavedOriginal(profile,original);
      }
    }
    unlocked(signal);
    if(saved)scheduleVectors(profile);
    return {saved,duplicates,unsupported,empty,
      nextCursor:page.nextCursor,selfChatId:page.selfChatId};
  }finally{running.delete(profile);}
}
