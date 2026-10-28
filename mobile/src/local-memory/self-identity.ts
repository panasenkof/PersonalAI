/** R3c1: one explicit pointer to a pre-existing person, NOT a relation graph.
 * A binding is a user decision in the same profile's SQLCipher database and
 * never changes when an alias or a model-produced search term changes.
 */
import type * as SQLite from "expo-sqlite";
import { withUnlockedTransaction } from "./transaction";
import { MemoryConflictError } from "./types";

type SQL = Pick<SQLite.SQLiteDatabase, "getFirstAsync"|"runAsync"|"execAsync">;
export type ProfileSelfIdentity = {personId:string|null;bindingVersion:number};
export type ChooseProfileSelfIdentity = {
  personId:string|null; expectedBindingVersion:number;
  /** Current version of the explicitly selected person, not an alias result. */
  expectedPersonVersion?:number;
  userConfirmed:true;
};
const allowedId=(id:unknown)=>typeof id==="string"&&id.trim().length>0&&id.length<=256&&!/[\u0000-\u001f]/.test(id);
type BindingRow={person_id:string|null;binding_version:number};

export async function readProfileSelfIdentity(db:SQL):Promise<ProfileSelfIdentity>{
  // FK ON DELETE SET NULL preserves the CAS counter after a person is removed.
  const row=await db.getFirstAsync<BindingRow>("SELECT person_id,binding_version FROM memory_profile_self WHERE slot=1");
  if(!row)return {personId:null,bindingVersion:0};
  if(!row.person_id)return {personId:null,bindingVersion:row.binding_version};
  const person=await db.getFirstAsync<{id:string}>(
    "SELECT e.id FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id "+
    "WHERE e.id=? AND e.kind='person' AND e.record_status='active' "+
    "AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'",
    [row.person_id]);
  // Never silently choose another person or leak a private person through an
  // old binding. The user can clear/rebind with the current bindingVersion.
  return {personId:person?.id??null,bindingVersion:row.binding_version};
}

export async function chooseProfileSelfIdentity(db:SQL,choice:ChooseProfileSelfIdentity):Promise<ProfileSelfIdentity>{
  if(choice.userConfirmed!==true||!Number.isSafeInteger(choice.expectedBindingVersion)||
     choice.expectedBindingVersion<0||choice.expectedBindingVersion>=Number.MAX_SAFE_INTEGER||
     (choice.personId!==null&&!allowedId(choice.personId))||
     (choice.personId!==null&&(!Number.isSafeInteger(choice.expectedPersonVersion)||
       choice.expectedPersonVersion!<1)))throw new Error("profile_self_confirmation_invalid");
  let result:ProfileSelfIdentity|null=null;
  await withUnlockedTransaction(db,async tx=>{
    const row=await tx.getFirstAsync<BindingRow>(
      "SELECT person_id,binding_version FROM memory_profile_self WHERE slot=1");
    const version=row?.binding_version??0;
    if(version!==choice.expectedBindingVersion)
      throw new MemoryConflictError("profile_self_binding_stale");
    if(choice.personId!==null){
      const verified=await tx.getFirstAsync<{id:string}>(
        "SELECT e.id FROM memory_entities e JOIN memory_collections c ON c.id=e.collection_id "+
        "WHERE e.id=? AND e.record_version=? AND e.kind='person' AND e.record_status='active' "+
        "AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'",
        [choice.personId,choice.expectedPersonVersion!]);
      if(!verified)throw new MemoryConflictError("profile_self_person_stale_or_private");
    }
    if(row?.person_id===choice.personId){result={personId:choice.personId,bindingVersion:version};return;}
    const next=version+1, timestamp=new Date().toISOString();
    if(!row){
      await tx.runAsync("INSERT INTO memory_profile_self(slot,person_id,binding_version,actor_kind,updated_at) VALUES (1,?,1,'user',?)",
        [choice.personId,timestamp]);
    }else{
      const change=await tx.runAsync(
        "UPDATE memory_profile_self SET person_id=?,binding_version=?,updated_at=? "+
        "WHERE slot=1 AND binding_version=?",[choice.personId,next,timestamp,version]);
      if(change.changes!==1)throw new MemoryConflictError("profile_self_binding_stale");
    }
    result={personId:choice.personId,bindingVersion:next};
  });
  if(!result)throw new Error("profile_self_binding_not_committed");
  return result;
}
