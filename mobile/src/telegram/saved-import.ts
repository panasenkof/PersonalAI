import {localMemorySessionUnlocked} from "../local-memory/storage";
import {saveMediaNote} from "../media/attachments";
import {scheduleVectors} from "../media/vector-runner";
import {readSavedMessagesPage} from "./saved-messages";
import {readSavedTopicPage,safeTopicId} from "./saved-topics";

export type SavedTextImportResult={
  saved:number; duplicates:number; unsupported:number; empty:number;
  nextCursor:string; selfChatId:string;
};
const running=new Set<string>();
function unlocked(signal?:AbortSignal){
  if(signal?.aborted)throw new Error("telegram_saved_import_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
}

/** Explicit small-batch import. Media is NEVER converted into a caption-only note.
 * No persisted pagination cursor: skipped media can be retried when supported.
 * The canonical memory writer owns SQLCipher, backup, FTS, receipt and replay.
 */
export async function importSavedTextPage(profile:string,cursor="0",
  signal?:AbortSignal,topicId?:string):Promise<SavedTextImportResult>{
  unlocked(signal);
  if(topicId!==undefined&&!safeTopicId(topicId))throw new Error("telegram_saved_topic_request_invalid");
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
      if(item.hasMedia||item.kind!=="messageText"){
        unsupported++;
        continue;
      }
      const body=item.text.trim();
      if(!body){
        empty++;
        continue;
      }
      const title=body.split(/\r?\n/)[0].trim().slice(0,160)||"Сообщение из Избранного";
      let replayed=false;
      await saveMediaNote(profile,{
        title,body,sensitivity:"sensitive",
        receipt:"telegram-saved:"+page.selfChatId+":"+item.id,
        telegramSavedMessage:{
          chatId:page.selfChatId,messageId:item.id,date:item.date,kind:"messageText",
          ...(topicId!==undefined?{topicId}:{}),
        },
        onReplay:()=>{replayed=true;},
      },signal);
      if(replayed)duplicates++;else saved++;
    }
    unlocked(signal);
    if(saved)scheduleVectors(profile);
    return {saved,duplicates,unsupported,empty,
      nextCursor:page.nextCursor,selfChatId:page.selfChatId};
  }finally{running.delete(profile);}
}
