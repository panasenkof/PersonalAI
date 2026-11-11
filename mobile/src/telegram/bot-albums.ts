import type {BotMessage,BotUpdate} from "./bot-api";

/** Bot API sends an album as independent updates and does not expose a
 * total/last-item flag. Never ACK an unbounded tail as a complete album.
 * A later message in the paired chat (or Telegram's 10-item maximum) closes
 * a batch; /done is an explicit optional boundary. Other chats do not.
 */
export type BotAlbumPlan =
  | {state:"pending";received:number;groupId:string}
  | {state:"ready";groupId:string;messages:BotMessage[];lastUpdateId:number;nextIndex:number};

const MAX_ALBUM_ITEMS=10;
const isOwner=(m:BotMessage|undefined,chatId:string)=>m?.chat?.type==="private"&&
  String(m.chat.id)===chatId;
export function planBotAlbum(updates:BotUpdate[],start:number,chatId:string):BotAlbumPlan{
  const head=updates[start]?.message;
  if(!isOwner(head,chatId)||!head?.media_group_id||
    !/^[A-Za-z0-9_-]{1,128}$/.test(head.media_group_id))
    throw new Error("Непроверенный идентификатор Telegram-альбома.");
  const groupId=head.media_group_id;
  const messages:BotMessage[]=[];
  const seen=new Set<number>();
  let boundary=updates.length,completed=false;
  for(let i=start;i<updates.length;i++){
    const update=updates[i];
    const message=update.message;
    if(isOwner(update.edited_message,chatId)){
      if(update.edited_message?.media_group_id===groupId)
        throw new Error("Альбом Telegram изменён до сохранения. Обновите импорт без подтверждения очереди.");
      boundary=i;completed=true;break;
    }
    if(isOwner(message,chatId)){
      if(message?.media_group_id!==groupId){
        boundary=i;completed=true;break;
      }
      if(!Number.isSafeInteger(message.message_id)||message.message_id<=0||
        seen.has(message.message_id))
        throw new Error("Некорректный или повторный ID элемента Telegram-альбома.");
      seen.add(message.message_id);
      messages.push(message);
      if(messages.length>MAX_ALBUM_ITEMS)
        throw new Error("В Telegram-альбоме больше 10 элементов. Импорт остановлен без потери оригиналов.");
      if(messages.length===MAX_ALBUM_ITEMS){
        // No Telegram album can legally exceed 10 items; retain exactly the
        // updates read so far and process following updates in the next turn.
        boundary=i+1;completed=true;break;
      }
    }
  }
  if(!completed||messages.length<2)return {state:"pending",received:messages.length,groupId};
  return {state:"ready",groupId,messages,lastUpdateId:updates[boundary-1].update_id,nextIndex:boundary};
}
