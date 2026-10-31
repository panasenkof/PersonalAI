/** Single authenticated model descriptor shared by visual indexing/query.
 * The native model sandbox is app-owned filesDir/persai-vision-models.
 * The SHA has already been checked against actual bytes by the existing
 * manager, and the native module independently recomputes before inference.
 */
import { verifiedActiveVisionModel } from "./vision-model-manager";
const SPACE = /^eg2\|vision\|768\|sha256:([a-f0-9]{64})$/;
const FILE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}\.litertlm$/;
export type ReadyVisionModel83 = {
  modelSpace:string; modelName:string; modelSha256:string;
};
export async function readyNativeVisionModel83():Promise<ReadyVisionModel83|null>{
  const active=await verifiedActiveVisionModel();
  if(!active)return null;
  const match=SPACE.exec(active.space);
  const name=active.path.split("/").at(-1)||"";
  if(!match || !FILE.test(name) ||
      !active.path.endsWith("/persai-vision-models/"+name))
    throw new Error("vision_model_path_invalid");
  return {modelSpace:active.space,modelName:name,modelSha256:match[1]};
}
