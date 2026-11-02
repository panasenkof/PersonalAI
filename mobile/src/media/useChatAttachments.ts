import { useEffect, useRef, useState } from 'react';
import { onLocalMemorySessionChange } from '../local-memory/storage';
import type { DirectChatStore } from '../direct-agent/chat-store';
import { pickChatAttachmentsWithResults } from './pickChatAttachments';
import { MAX_CHAT_FILES, checkedChatAttachments, type ChatAttachment } from '../direct-agent/chat-attachments';
export function useChatAttachments(store: DirectChatStore, conversationId: string | undefined, focused: boolean, onError: (message:string)=>void, onPhotoPicked?: (id:string)=>void) {
  const [picking,setPicking]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const alive=useRef(true);
  useEffect(()=>{
    alive.current=true;
    const off=onLocalMemorySessionChange(unlocked=>{if(!unlocked)controller.current?.abort();});
    return ()=>{alive.current=false;controller.current?.abort();off();};
  },[store]);
  useEffect(()=>{if(!focused)controller.current?.abort();return ()=>controller.current?.abort();},[conversationId,focused]);
  async function pick() {
    if(controller.current || !conversationId) return;
    const aborter=new AbortController();controller.current=aborter;setPicking(true);
    onError(""); // Dismiss a stale file-size or picker error before retry.
    try {
      const result=await pickChatAttachmentsWithResults(aborter.signal);
      if(aborter.signal.aborted || !alive.current || store.getSnapshot().activeId!==conversationId)return;
      const draft=store.getSnapshot().conversations.find(c=>c.id===conversationId);
      const existing=draft?.attachments || [];
      const accepted:ChatAttachment[]=[];
      const failed=result.failures.map(f=>`${f.name}: ${f.reason}`);
      for(const file of result.files){
        if(existing.length+accepted.length>=MAX_CHAT_FILES){
          failed.push(`${file.name}: до ${MAX_CHAT_FILES} файлов в сообщении.`);
          continue;
        }
        try{
          // Count the already staged text as well, not just this picker batch.
          checkedChatAttachments([...existing,...accepted,file]);
          accepted.push(file);
        }catch{
          failed.push(`${file.name}: общий лимит текста 24 000 символов или файла превышен.`);
        }
      }
      if(accepted.length) {
        store.setAttachments(conversationId,[...existing,...accepted]);
        const photo=[...accepted].reverse().find(file=>file.kind==="image");
        if(photo)onPhotoPicked?.(photo.id);
      }
      // Accepted files remain available for Send even when another fails;
      // no automatic send, no silent truncation or hidden background retry.
      onError(failed.length ? `Не все файлы добавлены. ${failed.join(' ')} Повторно выберите только неудавшиеся.` : "");

    } catch(e) {if(alive.current && !aborter.signal.aborted)onError((e as Error).message);}
    finally {controller.current=null;if(alive.current)setPicking(false);}
  }
  return {picking,pick};
}
