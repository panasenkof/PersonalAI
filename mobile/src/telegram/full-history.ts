import {localMemorySessionUnlocked} from "../local-memory/storage";
import {readSavedMessagesPage} from "./saved-messages";
import {importSavedTextPage} from "./saved-import";
import {safeTopicId} from "./saved-topics";
import {type TelegramImportTarget} from "./import-target";
import {
  clearSavedHistoryCheckpoint,loadSavedHistoryCheckpoint,saveSavedHistoryCheckpoint,
  type SavedHistoryCheckpoint,
} from "./settings";

export type SavedHistoryStatus="completed"|"pending_album"|"stalled";
export type SavedHistoryOutcome={status:SavedHistoryStatus;progress:SavedHistoryCheckpoint};
export type SavedHistoryProgress=(progress:SavedHistoryCheckpoint)=>void;
const validProfile=(p:string)=>/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(p);
const validCursor=(s:string)=>s==="0"||/^[1-9][0-9]{0,15}$/.test(s)&&
  Number.isSafeInteger(Number(s));
function guard(signal?:AbortSignal):void{
  if(signal?.aborted)throw new Error("telegram_saved_import_cancelled");
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
}
function delayBetweenPages(signal?:AbortSignal):Promise<void>{
  guard(signal);
  return new Promise((resolve,reject)=>{
    const abort=()=>{
      clearTimeout(timer);
      signal?.removeEventListener("abort",abort);
      reject(new Error("telegram_saved_import_cancelled"));
    };
    const timer=setTimeout(()=>{
      signal?.removeEventListener("abort",abort);
      resolve();
    },300);
    signal?.addEventListener("abort",abort,{once:true});
    if(signal?.aborted)abort();
  });
}
const initial=(topicId:string,targetId:string):SavedHistoryCheckpoint=>({
  version:1,cursor:"0",topicId,targetId,selfChatId:"",
  pages:0,processed:0,saved:0,duplicates:0,unsupported:0,
  empty:0,withFiles:0,tooLarge:0,
});
function addCount(a:number,b:number):number{
  const sum=a+b;
  if(!Number.isSafeInteger(sum)||sum>1_000_000_000)
    throw new Error("telegram_history_counter_limit");
  return sum;
}
function accumulate(before:SavedHistoryCheckpoint,part:Awaited<ReturnType<typeof importSavedTextPage>>,
  nextCursor:string):SavedHistoryCheckpoint{
  const processed=part.saved+part.duplicates+part.unsupported+part.empty;
  return {
    ...before,cursor:nextCursor,selfChatId:before.selfChatId||part.selfChatId,
    pages:addCount(before.pages,1),processed:addCount(before.processed,processed),
    saved:addCount(before.saved,part.saved),
    duplicates:addCount(before.duplicates,part.duplicates),
    unsupported:addCount(before.unsupported,part.unsupported),
    empty:addCount(before.empty,part.empty),
    withFiles:addCount(before.withFiles,part.withFiles),
    tooLarge:addCount(before.tooLarge,part.tooLarge),
  };
}
/**
 * User-initiated full-history mode. Calls only the canonical page importer,
 * including existing album handling, source dedup, section ACL and photo index.
 * The durable cursor advances only AFTER the entire page has committed.
 */
export async function importEntireSavedHistory(
  profile:string,topicId:string|undefined,target:TelegramImportTarget|undefined,
  signal:AbortSignal,onProgress:SavedHistoryProgress,resume=false,
):Promise<SavedHistoryOutcome>{
  if(!validProfile(profile)||topicId!==undefined&&!safeTopicId(topicId))
    throw new Error("telegram_history_scope_invalid");
  guard(signal);
  const topic=topicId??"",destination=target?.collectionId??"";
  let progress:SavedHistoryCheckpoint;
  if(resume){
    const stored=await loadSavedHistoryCheckpoint(profile);
    guard(signal);
    if(!stored||stored.topicId!==topic||stored.targetId!==destination)
      throw new Error("telegram_history_resume_scope_changed");
    progress=stored;
    // A checkpoint must never be applied to another Telegram account.
    if(stored.selfChatId){
      const current=await readSavedMessagesPage(profile,"0",1);
      guard(signal);
      if(current.selfChatId!==stored.selfChatId)
        throw new Error("telegram_saved_account_changed");
    }
  }else{
    progress=initial(topic,destination);
    await saveSavedHistoryCheckpoint(profile,progress);
    guard(signal);
  }
  onProgress(progress);
  for(;;){
    guard(signal);
    const page=await importSavedTextPage(profile,progress.cursor,signal,topicId,
      "supported-originals",target);
    guard(signal);
    if(progress.selfChatId&&page.selfChatId!==progress.selfChatId)
      throw new Error("telegram_saved_account_changed");
    if(!page.selfChatId||!validCursor(page.maxMessageId||"0")||
      (page.nextCursor!==""&&!validCursor(page.nextCursor)))
      throw new Error("telegram_history_page_invalid");
    const oldCursor=progress.cursor;
    if(page.nextCursor&&page.nextCursor!==oldCursor&&
       oldCursor!=="0"&&Number(page.nextCursor)>=Number(oldCursor))
      throw new Error("telegram_history_cursor_invalid");

    const stalled=page.nextCursor===oldCursor;
    const next=page.pendingAlbum||stalled ?oldCursor:page.nextCursor;
    const updated=accumulate(progress,page,next||oldCursor);
    if(!page.pendingAlbum&&!stalled&&!page.nextCursor){
      // A completed run is not resumable, but totals remain on screen.
      await clearSavedHistoryCheckpoint(profile);
      guard(signal);
      onProgress(updated);
      return {status:"completed",progress:updated};
    }
    await saveSavedHistoryCheckpoint(profile,updated);
    guard(signal);
    progress=updated;
    onProgress(progress);
    // TDLib may return only a partial album. Do not spin or skip its members.
    if(page.pendingAlbum)return {status:"pending_album",progress};
    if(stalled)return {status:"stalled",progress};
    await delayBetweenPages(signal);
  }
}

/** Fixed UI copy: native messages can include a phone number or other secrets. */
export function savedHistoryFailure(error:unknown):string{
  const raw=error instanceof Error?error.message:"";
  const flood=/tdlib_flood_wait_([0-9]{1,6})(?![0-9])/.exec(raw);
  if(flood){
    const minutes=Math.ceil(Math.min(86400,Math.max(1,Number(flood[1])))/60);
    return "Telegram ограничил запросы. Повторите через "+minutes+
      " мин. Прогресс сохранён; не запускайте импорт раньше.";
  }
  if(/tdlib_flood_limited/.test(raw))
    return "Telegram ограничил запросы. Повторите позже с сохранённого места.";
  if(/telegram_saved_account_changed|telegram_history_resume_scope_changed/.test(raw))
    return "Аккаунт Telegram, подборка или раздел изменились. Выберите прежний источник или начните импорт заново.";
  if(/telegram_app_locked/.test(raw))
    return "Приложение заблокировано. Разблокируйте его и продолжите импорт.";
  if(/telegram_history_checkpoint_invalid|telegram_history_cursor_invalid|telegram_history_page_invalid/.test(raw))
    return "Не удалось безопасно продолжить историю. Позиция не сброшена; повторите запрос.";
  return "Не удалось продолжить импорт. Проверьте Telegram и соединение; сохранённую позицию можно использовать повторно.";
}
