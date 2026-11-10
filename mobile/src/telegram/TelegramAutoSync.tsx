import React,{useEffect} from "react";
import {useProfile} from "../profile/ProfileContext";
import {useApplicationVisible} from "../security/visibility";
import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../local-memory/storage";
import {
  closeTelegramAccount,initializeTelegramAccount,observeTelegramAccountState,tdlibAvailable,
  type TelegramAccountState,
} from "./account";
import {loadTelegramSyncMode,hasExistingTdlibDbKey} from "./settings";
import {loadTelegramBotConfig} from "./bot-settings";
import {syncTelegramBotText} from "./bot-sync";
import {importSavedTextPage} from "./saved-import";

/** Single attempt per app process/profile after AppLock unlock. No daemon or timer.
 * TDLib only resumes an account whose device-bound encrypted database key
 * already exists. Telegram's authorizationStateReady, not a preference, gates
 * access to Saved Messages.
 */
const attempted=new Set<string>();
export function TelegramAutoSync(){
  const profile=useProfile(),visible=useApplicationVisible();
  useEffect(()=>onLocalMemorySessionChange(unlocked=>{
    if(!unlocked)void closeTelegramAccount().catch(()=>{});
  }),[]);
  useEffect(()=>{
    if(!visible||!localMemorySessionUnlocked()||attempted.has(profile))return;
    attempted.add(profile);
    const controller=new AbortController();
    let unsubscribe:()=>void=()=>{};
    const active=()=>!controller.signal.aborted&&localMemorySessionUnlocked();

    async function resumeAccount(){
      if(!active()||!tdlibAvailable())return;
      // A new/never-authorized account is not silently initialized at launch.
      if(!await hasExistingTdlibDbKey(profile)||!active())return;
      let imported=false;
      const onState=(state:TelegramAccountState)=>{
        if(state!=="authorizationStateReady"||imported||!active())return;
        imported=true;
        // Exactly one bounded page this launch; full history remains explicit.
        void importSavedTextPage(profile,"0",controller.signal).catch(()=>{});
      };
      unsubscribe=observeTelegramAccountState(onState);
      if(!active()){unsubscribe();unsubscribe=()=>{};return;}
      const state=await initializeTelegramAccount(profile);
      onState(state);
    }

    async function resumeBot(){
      if(!active())return;
      const bot=await loadTelegramBotConfig(profile);
      if(bot?.allowedChatId&&active())
        await syncTelegramBotText(profile,controller.signal);
    }

    void (async()=>{
      const mode=await loadTelegramSyncMode(profile);
      if(mode!=="on_open"||!active())return;
      // Failure of one channel never prevents the other from syncing.
      await Promise.allSettled([resumeAccount(),resumeBot()]);
    })().catch(()=>{/* no credentials, Telegram content or network URL in logs */});
    return()=>{controller.abort();unsubscribe();};
  },[profile,visible]);
  return null;
}
export function resetTelegramAutoSyncForTests(){attempted.clear();}
