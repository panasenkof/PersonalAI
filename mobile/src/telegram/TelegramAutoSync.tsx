import React,{useEffect} from "react";
import {useProfile} from "../profile/ProfileContext";
import {useApplicationVisible} from "../security/visibility";
import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../local-memory/storage";
import {closeTelegramAccount} from "./account";
import {loadTelegramSyncMode} from "./settings";
import {loadTelegramBotConfig} from "./bot-settings";
import {syncTelegramBotText} from "./bot-sync";

/** Once per app JS process and profile, not once per focus/tab or render.
 * Runs only after AppLock unlock and only if user explicitly chose on_open.
 * Network errors remain retriable through Settings > Telegram; no background service.
 */
const attempted = new Set<string>();
export function TelegramAutoSync(){
  const profile=useProfile(),visible=useApplicationVisible();
  // TDLib must not retain a live account network client after AppLock revokes
  // the protected application session, even while the navigator is mounted.
  useEffect(()=>onLocalMemorySessionChange(unlocked=>{
    if(!unlocked)void closeTelegramAccount().catch(()=>{});
  }),[]);
  useEffect(()=>{
    if(!visible||!localMemorySessionUnlocked()||attempted.has(profile))return;
    attempted.add(profile);
    const controller=new AbortController();
    void (async()=>{
      const mode=await loadTelegramSyncMode(profile);
      if(mode!=="on_open"||controller.signal.aborted||!localMemorySessionUnlocked())return;
      const bot=await loadTelegramBotConfig(profile);
      if(!bot?.allowedChatId||controller.signal.aborted||!localMemorySessionUnlocked())return;
      await syncTelegramBotText(profile,controller.signal);
    })().catch(()=>{/* Deliberately no unhandled rejections, tokens or chat text in logs. */});
    return()=>controller.abort();
  },[profile,visible]);
  return null;
}
/** Only for test isolation; production has one profile and one JS process. */
export function resetTelegramAutoSyncForTests(){attempted.clear();}
