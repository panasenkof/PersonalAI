import { useEffect, useRef, useState } from 'react';
import { onLocalMemorySessionChange } from '../local-memory/storage';
import type { DirectChatStore } from '../direct-agent/chat-store';
import { pickChatAttachments } from './pickChatAttachments';
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
    try {
      const files=await pickChatAttachments(aborter.signal);
      if(aborter.signal.aborted || !alive.current || store.getSnapshot().activeId!==conversationId || !files.length) return;
      const draft=store.getSnapshot().conversations.find(c=>c.id===conversationId);
      store.setAttachments(conversationId,[...(draft?.attachments || []),...files]);
      const photo = [...files].reverse().find(file => file.kind === "image");
      if (photo) onPhotoPicked?.(photo.id);
    } catch(e) {if(alive.current && !aborter.signal.aborted)onError((e as Error).message);}
    finally {controller.current=null;if(alive.current)setPicking(false);}
  }
  return {picking,pick};
}
