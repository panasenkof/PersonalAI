/** #83.2 raw EmbeddingGemma vectors through the ONE verified Java ABI.
 * This is an opt-in native capability, NOT a parallel search store or a
 * production indexing scheduler. The native module stays disabled in
 * ordinary PersAI APKs until a separate signed/runtime acceptance.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import { localMemorySessionUnlocked } from "../local-memory/storage";
import { IMAGE_VECTOR_DIM } from "../local-memory/attachment-vectors";

type NativeVisionVectors = {
  isSupported(): boolean;
  embedTextVector(modelName:string, sha:string, query:string):Promise<number[]>;
  embedImageVector(modelName:string, sha:string, imageName:string):Promise<number[]>;
};
export type NativeVisionModel = { modelName:string; modelSha256:string };
export type NativeVisionImage = NativeVisionModel & {imageName:string};
const MODEL_NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.litertlm$/;
const IMAGE_NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.(?:jpg|jpeg|png|webp)$/i;
const SHA=/^[a-f0-9]{64}$/;

function bridge(model:NativeVisionModel):NativeVisionVectors {
  if (Platform.OS!=="android") throw new Error("vision_android_only");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
  if (!MODEL_NAME.test(model.modelName) || !SHA.test(model.modelSha256))
    throw new Error("invalid_vision_model");
  const native=requireOptionalNativeModule<NativeVisionVectors>("PersaiVisionProbe");
  if (!native?.isSupported()) throw new Error("vision_native_unavailable");
  return native;
}
function checkedVector(result:unknown):Float32Array {
  if (!Array.isArray(result) || result.length!==IMAGE_VECTOR_DIM ||
      !result.every(v=>typeof v==="number" && Number.isFinite(v))) {
    throw new Error("invalid_native_vision_vector");
  }
  const result64=result as number[];
  const energy=result64.reduce((sum,v)=>sum+v*v,0);
  if (!Number.isFinite(energy) || energy<0.9 || energy>1.1)
    throw new Error("invalid_native_vision_norm");
  const values=Float32Array.from(result64);
  if (!values.every(Number.isFinite))throw new Error("invalid_native_vision_vector");
  return values;
}
export async function embedVisionText83(model:NativeVisionModel,query:string):Promise<Float32Array> {
  if (typeof query!=="string" || !query.trim() || query.length>256)
    throw new Error("invalid_vision_query");
  const native=bridge(model);
  return checkedVector(await native.embedTextVector(model.modelName,model.modelSha256,query));
}
export async function embedVisionImage83(input:NativeVisionImage):Promise<Float32Array> {
  if (!IMAGE_NAME.test(input.imageName)) throw new Error("invalid_vision_image");
  const native=bridge(input);
  return checkedVector(await native.embedImageVector(
    input.modelName,input.modelSha256,input.imageName));
}
