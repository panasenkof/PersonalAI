import React,{useEffect} from "react";
import {useProfile} from "../profile/ProfileContext";
import {useApplicationVisible} from "../security/visibility";
import {localMemorySessionUnlocked,onLocalMemorySessionChange} from "../local-memory/storage";
import {
  closeTelegramAccount,initializeTelegramAccount,observeTelegramAccountState,tdlibAvailable,
  type TelegramAccountState,
} from "./account";
import {loadTelegramSyncMode,wasTelegramAuthorized,markTelegramAuthorized,
  saveLastTelegramAutoSync,type TelegramAutoSyncResult} from "./settings";
import {loadTelegramBotConfig} from "./bot-settings";
import {syncTelegramBotText} from "./bot-sync";
import {syncNewSavedText} from "./saved-import";
import {loadTelegramTargetForWrite} from "./import-target";

/** Single attempt per app process/profile after AppLock unlock. No daemon or timer.
 * TDLib only resumes an account whose device-bound encrypted database key
 * is marked explicitly as previously authorized. Telegram's authorizationStateReady gates
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

    type AccountCounts={saved:number;duplicates:number;unsupported:number;gap:boolean};
    const accountResult:AccountCounts={saved:0,duplicates:0,unsupported:0,gap:false};
    const botResult={botImported:0,botSkipped:0};
    async function resumeAccount(){
      if(!active()||!tdlibAvailable())return;
      if(!await wasTelegramAuthorized(profile)||!active())return;
      let imported=false;
      let inFlight:Promise<void>|null=null;
      const onState=(state:TelegramAccountState)=>{
        if(state!=="authorizationStateReady"||imported||!active())return;
        imported=true;
        void markTelegramAuthorized(profile).catch(()=>{});
        inFlight=loadTelegramImportTarget(profile,"saved").then(target=>
          syncNewSavedText(profile,controller.signal,target)).then(outcome=>{
          Object.assign(accountResult,outcome);
        });
      };
      unsubscribe=observeTelegramAccountState(onState);
      if(!active()){unsubscribe();unsubscribe=()=>{};return;}
      const state=await initializeTelegramAccount(profile);
      onState(state);
      if(inFlight)await inFlight;
    }

    async function resumeBot(){
      if(!active())return;
      const bot=await loadTelegramBotConfig(profile);
      if(bot?.allowedChatId&&active()){
        const target=await loadTelegramImportTarget(profile,"bot");
        const result=await syncTelegramBotText(profile,controller.signal,target);
        botResult.botImported=result.imported;
        botResult.botSkipped=result.skipped;
      }
    }

    void (async()=>{
      const mode=await loadTelegramSyncMode(profile);
      if(mode!=="on_open"||!active())return;
      // Failure of one channel never prevents the other from syncing.
      const results=await Promise.allSettled([resumeAccount(),resumeBot()]);
      if(!active())return;
      const errors=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected");
      const raw=errors.map(r=>r.reason instanceof Error?r.reason.message:"");
      const code:TelegramAutoSyncResult["error"]=raw.some(s=>/telegram_app_locked/.test(s))
        ?"telegram_app_locked":raw.some(s=>/network|timeout|fetch|connection/i.test(s))
        ?"network":errors.length?"other":"";
      await saveLastTelegramAutoSync(profile,{
        at:new Date().toISOString(),...accountResult,...botResult,error:code,
      });
    })().catch(()=>{/* do not leak secrets or URLs to logs */});
    return()=>{controller.abort();unsubscribe();};
  },[profile,visible]);
  return null;
}
export function resetTelegramAutoSyncForTests(){attempted.clear();}
