import {parseSavedOriginal,downloadSavedOriginal,downloadSavedAlbumOriginal,releaseSavedOriginal,supportsSavedOriginal} from "../saved-original";
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

test("releases only the verified self-chat file by scoped native operation",async()=>{
  const release=jest.fn().mockResolvedValue("ok");
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    downloadSavedMessageOriginal:jest.fn(),releaseSavedMessageOriginal:release,
  });
  const {releaseSavedOriginal}=require("../saved-original");
  const originalValue=parseSavedOriginal(JSON.stringify(original),"guest","12345",preview);
  await releaseSavedOriginal("guest",originalValue);
  expect(release).toHaveBeenCalledWith("guest","12345","71",original.uri);
});
test("never asks TDLib to delete cached original while app is locked",async()=>{
  const release=jest.fn().mockResolvedValue("ok");
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({releaseSavedMessageOriginal:release});
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  const {releaseSavedOriginal}=require("../saved-original");
  await releaseSavedOriginal("guest",parseSavedOriginal(JSON.stringify(original),"guest","12345",preview));
  expect(release).not.toHaveBeenCalled();
});
test("cache release failures never change a committed note result or leak a path",async()=>{
  const release=jest.fn().mockRejectedValue(new Error("secret TDLib native path"));
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({releaseSavedMessageOriginal:release});
  const {releaseSavedOriginal}=require("../saved-original");
  await expect(releaseSavedOriginal("guest",
    parseSavedOriginal(JSON.stringify(original),"guest","12345",preview))).resolves.toBeUndefined();
});

test("album downloader sends only a TDLib-projected ID and validates album provenance",async()=>{
  const albumPreview={...preview,hasAlbum:true,albumId:"9223372036854775807"};
  const albumOriginal={...original,albumId:albumPreview.albumId};
  const nativeDownload=jest.fn().mockResolvedValue(JSON.stringify(albumOriginal));
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    downloadSavedAlbumOriginal:nativeDownload,releaseSavedAlbumOriginal:jest.fn(),
  });
  const result=await downloadSavedAlbumOriginal("guest","12345",albumPreview);
  expect(result.albumId).toBe(albumPreview.albumId);
  expect(nativeDownload).toHaveBeenCalledWith("guest","12345","71","9223372036854775807");
  const nativeRelease=jest.fn().mockResolvedValue("ok");
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    releaseSavedAlbumOriginal:nativeRelease,
  });
  await releaseSavedOriginal("guest",result);
  expect(nativeRelease).toHaveBeenCalledWith("guest","12345","71",
    albumPreview.albumId,original.uri);
});
test("rejects different TDLib album ID and no fake album state",async()=>{
  const albumPreview={...preview,hasAlbum:true,albumId:"987"};
  const nativeDownload=jest.fn().mockResolvedValue(JSON.stringify({...original,albumId:"999"}));
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    downloadSavedAlbumOriginal:nativeDownload,
  });
  await expect(downloadSavedAlbumOriginal("guest","12345",albumPreview))
    .rejects.toThrow("telegram_saved_original_invalid");
  expect(()=>parseSavedOriginal(JSON.stringify({...original,albumId:"987"}),
    "guest","12345",preview)).toThrow("telegram_saved_original_invalid");
  await expect(downloadSavedAlbumOriginal("guest","12345",{...preview,hasAlbum:true}))
    .rejects.toThrow("telegram_saved_album_original_request_invalid");
});
test("album source cannot be downloaded as a standalone original",async()=>{
  await expect(downloadSavedOriginal("guest","12345",{
    ...preview,hasAlbum:true,albumId:"987",
  })).rejects.toThrow("telegram_saved_original_request_invalid");
});
