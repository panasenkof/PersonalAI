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
  /** Short object requests use both current MiniLM text and the visual model. */
  includeTextVector?:boolean;
  /** Force collection ACL on text and visual hits in the same DB lease. */
  standardCollectionsOnly?:boolean;
  minImageSimilarity?:number;
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
  // Compose the two existing vector spaces without running another search.
  // Model initialization happens before the SQLCipher lease, one at a time.
  let textVector=options.vector;
  if (options.includeTextVector && !textVector) {
    const embedder = require("./embedder") as typeof import("./embedder");
    const values=await embedder.embedQuery(query).catch(()=>null);
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    const space=values?await embedder.verifiedVectorSpace().catch(()=>null):null;
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    if(values && space) textVector={model:space,values};
  }
  const { requireVisionModel: _required, includeTextVector: _text, standardCollectionsOnly: _acl,
    ...memoryScope } = options;
  return withLocalMemoryDatabase(profile, async db => {
    const repository=new SqliteMemoryRepository(db);
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    const allowedCollections=options.standardCollectionsOnly
      ? (await repository.listCollections()).filter(c=>c.sensitivity==="standard").map(c=>c.id)
      : undefined;
    const scope=allowedCollections ? {
      collectionIds:options.collectionIds
        ? options.collectionIds.filter(id=>allowedCollections.includes(id)) : allowedCollections,
    } : {};
    if(!localMemorySessionUnlocked())throw new Error("application_locked");
    return repository.searchMemory(query,{...memoryScope,...scope,
      ...(textVector?{vector:textVector}:{}),...(imageVector?{imageVector}:{})});
  });

}
