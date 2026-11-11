import {parseSavedOriginal,downloadSavedOriginal,supportsSavedOriginal} from "../saved-original";
import {tdlibAvailable,tdlibAccountState} from "../account";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
jest.mock("../account",()=>({tdlibAvailable:jest.fn(),tdlibAccountState:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("../../media/attachments",()=>({MAX_ORIGINAL_BYTES:80*1024*1024}));
jest.mock("expo-modules-core",()=>({
  ...jest.requireActual("expo-modules-core"),requireOptionalNativeModule:jest.fn(),
}));
const preview={id:"71",date:1794300000,kind:"messagePhoto",text:"Подпись",
  hasMedia:true};
const original={chatId:"12345",messageId:"71",date:1794300000,
  kind:"messagePhoto",text:"Подпись",name:"photo.jpg",mimeType:"image/jpeg",
  size:4024,uri:"file:///data/user/0/com.persai.app/files/persai-tdlib-guest/files/photos/original.jpg"};
beforeEach(()=>{
  jest.clearAllMocks();
  Object.defineProperty(Platform,"OS",{configurable:true,value:"android"});
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateReady");
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    downloadSavedMessageOriginal:jest.fn().mockResolvedValue(JSON.stringify(original)),
  });
});
test("accepts only native self-chat media original with matching message snapshot",async()=>{
  const item=parseSavedOriginal(JSON.stringify(original),"guest","12345",preview);
  expect(item.file).toMatchObject({name:"photo.jpg",size:4024,mimeType:"image/jpeg"});
  expect(await downloadSavedOriginal("guest","12345",preview)).toEqual(item);
  expect((requireOptionalNativeModule as jest.Mock).mock.results[0].value
    .downloadSavedMessageOriginal).toHaveBeenCalledWith("guest","12345","71");
});
test("rejects mismatched caption, source, date and type before canonical writer",()=>{
  for(const bad of [
    {...original,chatId:"999"},
    {...original,messageId:"72"},
    {...original,text:"Изменено"},
    {...original,date:original.date+1},
    {...original,kind:"messageDocument"},
    {...original,uri:"file:///outside/path/secret.jpg"},
    {...original,uri:"file:///data/files/persai-tdlib-other/files/photo.jpg"},
    {...original,uri:original.uri.replace("/photos/original.jpg","/../private.jpg")},
    {...original,size:80*1024*1024+1},
    {...original,name:"../secret.jpg"},
  ]){
    expect(()=>parseSavedOriginal(JSON.stringify(bad),"guest","12345",preview))
      .toThrow("telegram_saved_original_invalid");
  }
});
test("refuses unsupported original format, media album and unauthenticated account",async()=>{
  expect(supportsSavedOriginal("messageSticker")).toBe(false);
  await expect(downloadSavedOriginal("guest","12345",{...preview,kind:"messageSticker"}))
    .rejects.toThrow("telegram_saved_original_request_invalid");
  (tdlibAccountState as jest.Mock).mockReturnValue("offline");
  await expect(downloadSavedOriginal("guest","12345",preview))
    .rejects.toThrow("telegram_account_not_authorized");
});
test("AppLock after native transfer rejects the result without producing a note",async()=>{
  (localMemorySessionUnlocked as jest.Mock)
    .mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(downloadSavedOriginal("guest","12345",preview))
    .rejects.toThrow("telegram_saved_original_cancelled");
});
test("explicit abort prevents invoking native downloader",async()=>{
  const controller=new AbortController();controller.abort();
  await expect(downloadSavedOriginal("guest","12345",preview,controller.signal))
    .rejects.toThrow("telegram_saved_original_cancelled");
  expect(requireOptionalNativeModule).not.toHaveBeenCalled();
});
