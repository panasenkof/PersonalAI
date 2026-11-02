import { useEffect, useRef, useState } from 'react';
import { onLocalMemorySessionChange } from '../local-memory/storage';
import type { DirectChatStore } from '../direct-agent/chat-store';
import { pickChatAttachmentsWithResults } from './pickChatAttachments';
import type { ChatFileFailure } from './pickChatAttachments';
import { MAX_CHAT_FILES, checkedChatAttachments, type ChatAttachment } from '../direct-agent/chat-attachments';
export function useChatAttachments(store: DirectChatStore, conversationId: string | undefined, focused: boolean, onError: (message:string)=>void, onPhotoPicked?: (id:string)=>void) {
  const [picking,setPicking]=useState(false);
  const [audioPreparing,setAudioPreparing]=useState(false);
  // Ephemeral UI diagnostics only. Not written to the encrypted conversation
  // or to a new queue; a failed picker asset has already been deleted.
  const [issueState,setIssueState]=useState<{conversationId:string;files:ChatFileFailure[]}>({conversationId:"",files:[]});
  const failedFiles=focused && issueState.conversationId===conversationId ? issueState.files : [];
  const controller=useRef<AbortController|null>(null);
  const alive=useRef(true);
  useEffect(()=>{
    alive.current=true;
    const off=onLocalMemorySessionChange(unlocked=>{if(!unlocked){
      controller.current?.abort();
      if(alive.current)setIssueState({conversationId:"",files:[]});
    }});
    return ()=>{alive.current=false;controller.current?.abort();off();};
  },[store]);
  useEffect(()=>{
    if(!focused)controller.current?.abort();
    setIssueState(previous=>previous.conversationId===conversationId && focused
      ? previous : {conversationId:"",files:[]});
    return ()=>controller.current?.abort();
  },[conversationId,focused]);
  async function pick() {
    if(controller.current || !conversationId) return;
    const aborter=new AbortController();controller.current=aborter;setPicking(true);
    setAudioPreparing(false);
    onError(""); // Dismiss a stale file-size or picker error before retry.
    try {
      const result=await pickChatAttachmentsWithResults(aborter.signal,()=>{
        if(alive.current && !aborter.signal.aborted)setAudioPreparing(true);
      });
      if(aborter.signal.aborted || !alive.current || store.getSnapshot().activeId!==conversationId)return;
      const draft=store.getSnapshot().conversations.find(c=>c.id===conversationId);
      const existing=draft?.attachments || [];
      const accepted:ChatAttachment[]=[];
      const failed:ChatFileFailure[]=[...result.failures];
      for(const file of result.files){
        if(existing.length+accepted.length>=MAX_CHAT_FILES){
          failed.push({name:file.name.replace(/[\\r\\n\\t]/g," ").slice(0,90),
            reason:`Можно прикрепить не более ${MAX_CHAT_FILES} файлов в одном сообщении.`});
          continue;
        }
        try{
          // Count the already staged text as well, not just this picker batch.
          checkedChatAttachments([...existing,...accepted,file]);
          accepted.push(file);
        }catch{
          failed.push({name:file.name.replace(/[\\r\\n\\t]/g," ").slice(0,90),
            reason:"Превышен общий лимит текста 24 000 символов или размер вложений."});
        }
      }
      if(accepted.length) {
        store.setAttachments(conversationId,[...existing,...accepted]);
        const photo=[...accepted].reverse().find(file=>file.kind==="image");
        if(photo)onPhotoPicked?.(photo.id);
      }
      // Accepted files remain available for Send even when another fails.
      // Dismissible per-file issues are shown alongside the composer, not as
      // a duplicate wall of text in the global snackbar.
      if(result.files.length || failed.length)setIssueState({conversationId,files:failed});
      onError("");

    } catch(e) {if(alive.current && !aborter.signal.aborted && store.getSnapshot().activeId===conversationId)
      onError((e as Error).message);}
    finally {controller.current=null;if(alive.current){setPicking(false);setAudioPreparing(false);}}
  }
  function cancel(){controller.current?.abort();}
  function dismissFailure(index:number){
    setIssueState(previous=>previous.conversationId===conversationId ?
      {...previous,files:previous.files.filter((_,i)=>i!==index)} : previous);
  }
  return {picking,pick,audioPreparing,cancel,failedFiles,dismissFailure};
}
