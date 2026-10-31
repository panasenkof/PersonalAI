import { capturePhotoDraft83, capturePhotoForChat83, capturePhotoForSearch83, discardCameraPhotoDraft83, stageChatImageForNote83 } from "../vision-chat-camera";
import { localMemorySessionUnlocked } from "../../local-memory/storage";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync } from "expo-image-manipulator";
import { readyNativeVisionModel83 } from "../vision-native-model";
const mockDelete=jest.fn();
const mockCopy=jest.fn(async()=>{});
const mockWrite=jest.fn(async()=>{});
const mockBase64=jest.fn(async()=>Buffer.from([255,216,255,224,1,2,3,4]).toString("base64"));
jest.mock("expo-crypto",()=>({randomUUID:()=>"temporary-camera"}));
jest.mock("expo-image-picker",()=>({
  requestCameraPermissionsAsync:jest.fn(),launchCameraAsync:jest.fn(),
}));
jest.mock("expo-image-manipulator",()=>({
  SaveFormat:{JPEG:"jpeg"},manipulateAsync:jest.fn(),
}));
jest.mock("expo-file-system",()=>({
  Paths:{cache:{uri:"file:///cache"}},
  Directory:jest.fn().mockImplementation(()=>({create:jest.fn()})),
  File:jest.fn().mockImplementation((uri:any,name?:string)=>({
    uri:name?"file:///cache/persai-camera-drafts/"+name:uri,
    exists:true,size:500,base64:mockBase64,delete:mockDelete,
    copy:jest.fn((target:any)=>mockCopy(uri,target.uri)),
    write:jest.fn((data:Uint8Array)=>mockWrite(data)),
  })),
}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("../vision-native-model",()=>({readyNativeVisionModel83:jest.fn()}));
jest.mock("../../security/native-interaction",()=>({
  withNativeInteraction:jest.fn(async(fn:()=>Promise<unknown>)=>fn()),
}));
const unlocked=localMemorySessionUnlocked as jest.Mock;
const activeModel=readyNativeVisionModel83 as jest.Mock;
const permission=ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const camera=ImagePicker.launchCameraAsync as jest.Mock;
const manipulate=manipulateAsync as jest.Mock;
beforeEach(()=>{
  jest.clearAllMocks();
  unlocked.mockReturnValue(true);
  activeModel.mockResolvedValue({modelSpace:"model"});
  permission.mockResolvedValue({granted:true});
  camera.mockResolvedValue({canceled:false,assets:[{uri:"file:///cache/photo.jpg"}]});
  manipulate.mockResolvedValue({uri:"file:///cache/resized.jpg"});
});
test("tap camera -> one local JPEG, no memory writer; source and derived cache cleaned",async()=>{
  const image=await capturePhotoForSearch83();
  expect(image).toMatchObject({kind:"image",mime:"image/jpeg",name:"Снимок для поиска.jpg"});
  expect(camera).toHaveBeenCalledTimes(1);
  expect(manipulate).toHaveBeenCalledTimes(1);
  expect(mockBase64).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(2);
});
test("camera cancel creates no attachment and sends nothing",async()=>{
  camera.mockResolvedValueOnce({canceled:true,assets:[]});
  expect(await capturePhotoForSearch83()).toBeNull();
  expect(manipulate).not.toHaveBeenCalled();
});
test("no installed photo model stops before opening camera",async()=>{
  activeModel.mockResolvedValueOnce(null);
  await expect(capturePhotoForSearch83()).rejects.toThrow("vision_model_not_installed");
  expect(permission).not.toHaveBeenCalled();
  expect(camera).not.toHaveBeenCalled();
});
test("camera permission denied prevents photographing",async()=>{
  permission.mockResolvedValueOnce({granted:false});
  await expect(capturePhotoForSearch83()).rejects.toThrow("vision_camera_permission_denied");
  expect(camera).not.toHaveBeenCalled();
});
test("AppLock after photo capture aborts and does not return image bytes",async()=>{
  manipulate.mockImplementationOnce(async()=>{unlocked.mockReturnValue(false);return {uri:"file:///cache/resized.jpg"};});
  await expect(capturePhotoForSearch83()).rejects.toThrow("application_locked");
  expect(mockBase64).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledTimes(2);
});

test("ordinary chat snapshot works without a visual embedding model and is not searched or saved automatically",async()=>{
  activeModel.mockResolvedValueOnce(null);
  const image=await capturePhotoForChat83();
  expect(image).toMatchObject({kind:"image",mime:"image/jpeg",name:"Снимок.jpg"});
  expect(activeModel).not.toHaveBeenCalled();
  expect(camera).toHaveBeenCalledTimes(1);
  expect(mockDelete).toHaveBeenCalledTimes(2);
});
test("ordinary camera cancel leaves the draft untouched",async()=>{
  camera.mockResolvedValueOnce({canceled:true,assets:[]});
  expect(await capturePhotoForChat83()).toBeNull();
  expect(mockBase64).not.toHaveBeenCalled();
});

test("capture-first does not need embeddings and retains original only for later note",async()=>{
  activeModel.mockResolvedValueOnce(null);
  const draft=await capturePhotoDraft83();
  expect(activeModel).not.toHaveBeenCalled();
  expect(draft?.attachment).toMatchObject({name:"Снимок.jpg",kind:"image"});
  expect(draft?.originalUri).toContain("persai-camera-drafts");
  expect(mockCopy).toHaveBeenCalledWith("file:///cache/photo.jpg",draft?.originalUri);
  expect(mockDelete).toHaveBeenCalledTimes(2);
  discardCameraPhotoDraft83(draft!.originalUri);
  expect(mockDelete).toHaveBeenCalledTimes(3);
});
test("gallery photo can reuse note importer without reopening camera",async()=>{
  const attachment=await capturePhotoForChat83();
  const uri=await stageChatImageForNote83(attachment!);
  expect(uri).toContain("persai-camera-drafts");
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(camera).toHaveBeenCalledTimes(1);
});
