import { capturePhotoForSearch83 } from "../vision-chat-camera";
import { localMemorySessionUnlocked } from "../../local-memory/storage";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync } from "expo-image-manipulator";
import { readyNativeVisionModel83 } from "../vision-native-model";
const mockDelete=jest.fn();
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
  File:jest.fn().mockImplementation((uri:string)=>({
    uri,exists:true,size:500,base64:mockBase64,delete:mockDelete,
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
