/** #83.2: a guarded adapter into the EXISTING searchMemory.
 * A photo vector is optional. Existing MiniLM vector + FTS/OCR options are
 * unchanged. No second SQL query, result model, or fallback index.
 *
 * Called explicitly from chat photo intent; Android runtime quality still
 * needs physical-device QA. Ordinary FTS/MiniLM chat search stays unchanged.
 */
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { SqliteMemoryRepository } from "../local-memory/repository";
import type { MemoryHit } from "../local-memory/types";
import { readyNativeVisionModel83 } from "./vision-native-model";
import { embedVisionText83 } from "./vision-native-vectors";

type ScopedSearch = {
  /** User explicitly chose photo search: never silently show only text results. */
  requireVisionModel?:boolean;
  collectionIds?:string[];sensitivities?:string[];limit?:number;
  vector?:{model:string;values:Float32Array};
};
export async function searchWithVision83(
  profile:string,query:string,options:ScopedSearch={},
):Promise<MemoryHit[]> {
  if (!profile || profile.length>160 ||
      typeof query!=="string" || !query.trim() || query.length>256) {
    throw new Error("vision_invalid_search_query");
  }
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  const model=await readyNativeVisionModel83();
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  if (!model && options.requireVisionModel) throw new Error("vision_model_not_installed");
  const imageVector=model?{
    model:model.modelSpace,
    values:await embedVisionText83({
      modelName:model.modelName,modelSha256:model.modelSha256,
    },query),
  }:undefined;
  if(!localMemorySessionUnlocked())throw new Error("application_locked");
  const { requireVisionModel: _required, ...memoryScope } = options;
  return withLocalMemoryDatabase(profile, async db => new SqliteMemoryRepository(db)
    .searchMemory(query,{...memoryScope,...(imageVector?{imageVector}:{})}));
}
