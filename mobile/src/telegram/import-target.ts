import {localMemoryRepository} from "../local-memory/repository";
import {collectionPath} from "../local-memory/sections";
import {proposableMemorySections} from "../direct-agent/memory";
import {loadTelegramTargetId,saveTelegramTargetId,type TelegramImportChannel} from "./settings";

export type TelegramImportTarget={collectionId:string};
export type TelegramTargetOption={id:string;name:string};

/** Validate against the same authoritative collection/ACL view as the assistant. */
export async function telegramTargetOptions(profile:string):Promise<TelegramTargetOption[]>{
  const repo=await localMemoryRepository(profile);
  const collections=await repo.listCollections();
  const proposals=await proposableMemorySections(profile,repo);
  const allowed=new Set(proposals.map(p=>p.path||p.name));
  return collections.filter(c=>c.sensitivity==="standard"&&
    allowed.has(collectionPath(c,collections))).map(c=>({
      id:c.id,name:collectionPath(c,collections),
    }));
}
export async function requireTelegramTarget(profile:string,target?:TelegramImportTarget):Promise<{
  collectionId?:string;sensitivity:"standard"|"sensitive";
}>{
  if(!target)return {sensitivity:"sensitive"};
  if(!target.collectionId||!((await telegramTargetOptions(profile)).some(x=>x.id===target.collectionId)))
    throw new Error("telegram_target_unavailable");
  return {collectionId:target.collectionId,sensitivity:"standard"};
}
export async function loadTelegramImportTarget(profile:string,channel:TelegramImportChannel):
 Promise<TelegramImportTarget|undefined>{
  const id=await loadTelegramTargetId(profile,channel);
  if(!id)return undefined;
  return (await telegramTargetOptions(profile)).some(x=>x.id===id)?{collectionId:id}:undefined;
}
export async function chooseTelegramImportTarget(profile:string,channel:TelegramImportChannel,id:string){
  if(id)await requireTelegramTarget(profile,{collectionId:id});
  await saveTelegramTargetId(profile,channel,id);
}
