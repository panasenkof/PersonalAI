import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../local-memory/storage";
import {saveMediaNote} from "../media/attachments";
import {scheduleVectors} from "../media/vector-runner";
import {fetchBotUpdates, type BotMessage} from "./bot-api";
import {prepareBotOriginal} from "./bot-media";
import {advanceTelegramBotCursor, loadTelegramBotConfig} from "./bot-settings";

export type TelegramBotSyncResult = {
  imported: number; skipped: number; lastUpdate: number;
};
const running = new Map<string,Promise<TelegramBotSyncResult>>();

function mustBeUnlocked(signal?:AbortSignal) {
  if (signal?.aborted || !localMemorySessionUnlocked())
    throw new Error("Разблокируйте PersAI для синхронизации Telegram.");
}
function hasMedia(message:BotMessage):boolean {
  return Boolean(message.photo || message.document || message.video || message.audio ||
    message.voice || message.animation || message.video_note || message.media_group_id);
}
function textOf(message:BotMessage):string {
  return typeof message.text === "string" ? message.text : typeof message.caption === "string" ? message.caption : "";
}
async function perform(profile:string,signal?:AbortSignal):Promise<TelegramBotSyncResult> {
  mustBeUnlocked(signal);
  const config=await loadTelegramBotConfig(profile);
  if(!config || !config.allowedChatId)throw new Error("Сначала подключите личного бота и подтвердите свой чат.");
  const updates=await fetchBotUpdates(config.token,config.cursor,signal);
  mustBeUnlocked(signal);
  let last=config.cursor,imported=0,skipped=0;
  for(const item of updates) {
    mustBeUnlocked(signal);
    if(item.update_id<=last)continue;
    const message=item.message;
    const edited=item.edited_message;
    const fromAllowed = (m:BotMessage|undefined) =>
      m?.chat?.type==="private" && String(m.chat.id)===config.allowedChatId;
    if(fromAllowed(edited)) {
      throw new Error("Есть отредактированное сообщение Telegram. Оно не подтверждено и не пропущено; требуется отдельная обработка изменений.");
    }
    if(message && fromAllowed(message)) {
      if(!Number.isSafeInteger(message.message_id)||message.message_id<=0)
        throw new Error("Telegram вернул сообщение без корректного ID.");
      // Do not acknowledge a Telegram object that has no lossless writer yet.
      if(message.sticker||message.contact||message.location||message.venue||
        message.poll||message.dice||message.story||message.paid_media)
        throw new Error("В очереди есть неподдержанный объект Telegram. Импорт остановлен без потери сообщения.");
      const body=textOf(message).trim();
      if(body.length>60_000)throw new Error("Сообщение Telegram длиннее 60 000 символов. Импорт остановлен.");
      const isCommand=/^\/(?:start|help)(?:\s|$)/i.test(body)&&!hasMedia(message);
      const staged=!isCommand&&hasMedia(message)
        ? await prepareBotOriginal(config.token,message,signal):null;
      try{
        mustBeUnlocked(signal);
        if((body||staged)&&!isCommand){
          const title=body.split(/\r?\n/)[0].trim().slice(0,160)||
            staged?.file.name||"Сообщение Telegram";
          let replayed=false;
          await saveMediaNote(profile,{
            title,body,sensitivity:"sensitive",
            ...(staged?{file:staged.file}:{}),
            receipt:"telegram-bot:"+config.botId+":"+config.allowedChatId+":"+message.message_id,
            onReplay:()=>{replayed=true;},
            botMessage:{botId:config.botId,chatId:config.allowedChatId!,messageId:message.message_id},
          },signal);
          if(replayed)skipped++;else imported++;
        }else skipped++;
      }finally{staged?.remove();}
    } else {
      // Other users' chat events must never become notes in the owner's memory.
      skipped++;
    }
    mustBeUnlocked(signal);
    // Telegram ACK happens on the NEXT getUpdates with offset=last+1.
    // Local cursor is committed only after canonical note commit/replay succeeds.
    await advanceTelegramBotCursor(profile,config.botId,config.allowedChatId,item.update_id);
    last=item.update_id;
  }
  if(imported) scheduleVectors(profile);
  return {imported,skipped,lastUpdate:last};
}
/** Serializes per-profile manual/auto starts; no parallel cursor or writes. */
export function syncTelegramBotText(profile:string,signal?:AbortSignal):Promise<TelegramBotSyncResult> {
  const pending=running.get(profile);
  if(pending)return pending;
  // A lock transition cancels in-flight Bot API requests and native media
  // downloads, not just the following SQLCipher write.
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener("abort",abort,{once:true});
  const unsubscribe=onLocalMemorySessionChange(unlocked=>{
    if(!unlocked)controller.abort();
  });
  if(signal?.aborted||!localMemorySessionUnlocked())controller.abort();
  const next=perform(profile,controller.signal);
  running.set(profile,next);
  void next.finally(()=>{
    unsubscribe();
    signal?.removeEventListener("abort",abort);
    if(running.get(profile)===next)running.delete(profile);
  }).catch(()=>{});
  return next;
}
