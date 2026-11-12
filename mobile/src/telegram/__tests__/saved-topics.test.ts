import {Platform} from "react-native";
import {requireOptionalNativeModule} from "expo-modules-core";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
import {tdlibAccountState,tdlibAvailable} from "../account";
import {listSavedTopics,parseSavedTopics,readSavedTopicPage,safeTopicId} from "../saved-topics";
jest.mock("../account",()=>({tdlibAvailable:jest.fn(),tdlibAccountState:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("expo-modules-core",()=>({
  ...jest.requireActual("expo-modules-core"),requireOptionalNativeModule:jest.fn(),
}));
const topic=(id:string,kind="savedMessagesTopicTypeMyNotes")=>({
  id,kind,isPinned:false,order:"123456789012345",
});
const message=(id:string)=>({id,date:1794300000,kind:"messageText",text:"тест",hasMedia:false});
const moduleMock={
  listSavedMessagesTopics:jest.fn(),
  getSavedMessagesTopicPage:jest.fn(),
};
beforeEach(()=>{
  jest.clearAllMocks();
  Object.defineProperty(Platform,"OS",{configurable:true,value:"android"});
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateReady");
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(moduleMock);
  moduleMock.listSavedMessagesTopics.mockResolvedValue(JSON.stringify({topics:[
    topic("0"),topic("-1001234","savedMessagesTopicTypeChat"),
  ]}));
  moduleMock.getSavedMessagesTopicPage.mockResolvedValue(JSON.stringify({
    selfChatId:"12345",topicId:"-1001234",messages:[message("42"),message("41")],nextCursor:"41",
  }));
});
test("native-discovered topic IDs can be signed; list does not expose raw chat content",async()=>{
  const list=await listSavedTopics("guest");
  expect(list.map(x=>x.id)).toEqual(["0","-1001234"]);
  expect(moduleMock.listSavedMessagesTopics).toHaveBeenCalledWith("guest");
  expect(safeTopicId("9007199254740991")).toBe(true);
  expect(safeTopicId("-9007199254740991")).toBe(true);
  expect(safeTopicId("9007199254740992")).toBe(false);
  expect(safeTopicId("1.5")).toBe(false);
  expect(safeTopicId("-0")).toBe(false);
});
test("native page preserves topic provenance with bounded cursor and self-chat projection",async()=>{
  const page=await readSavedTopicPage("guest","-1001234","0",20);
  expect(page.messages.map(x=>x.id)).toEqual(["42","41"]);
  expect(moduleMock.getSavedMessagesTopicPage)
    .toHaveBeenCalledWith("guest","-1001234","0",20);
});
test("reject forged/duplicate/malformed topic lists and foreign page IDs",async()=>{
  expect(()=>parseSavedTopics(JSON.stringify({topics:[topic("1"),topic("1")]})))
    .toThrow("telegram_saved_topic_invalid");
  expect(()=>parseSavedTopics(JSON.stringify({topics:[topic("1","groupChat")]})))
    .toThrow("telegram_saved_topic_invalid");
  expect(()=>parseSavedTopics(JSON.stringify({topics:[{...topic("1"),order:"NaN"}]})))
    .toThrow("telegram_saved_topic_invalid");
  expect(()=>parseSavedTopics(JSON.stringify({topics:[{...topic("1"),isPinned:1}]})))
    .toThrow("telegram_saved_topic_invalid");
  moduleMock.getSavedMessagesTopicPage.mockResolvedValue(JSON.stringify({
    selfChatId:"12345",topicId:"9999",messages:[],nextCursor:"",
  }));
  await expect(readSavedTopicPage("guest","-1001234"))
    .rejects.toThrow("telegram_saved_topic_source_mismatch");
  expect(moduleMock.getSavedMessagesTopicPage).toHaveBeenCalledTimes(1);
});
test("AppLock, missing native reader and expired auth fail closed",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValueOnce(false);
  await expect(listSavedTopics("guest")).rejects.toThrow("telegram_app_locked");
  (tdlibAccountState as jest.Mock).mockReturnValueOnce("authorizationStateWaitCode");
  await expect(readSavedTopicPage("guest","1")).rejects.toThrow("telegram_account_not_authorized");
  await expect(readSavedTopicPage("guest","../other")).rejects.toThrow("telegram_saved_topic_request_invalid");
  await expect(listSavedTopics("../other")).rejects.toThrow("telegram_saved_profile_invalid");
  (requireOptionalNativeModule as jest.Mock).mockReturnValueOnce(null);
  await expect(listSavedTopics("guest")).rejects.toThrow("telegram_saved_topic_reader_missing");
});
test("re-check after native await; no results escape after screen lock",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValueOnce(true).mockReturnValueOnce(false);
  await expect(readSavedTopicPage("guest","-1001234"))
    .rejects.toThrow("telegram_app_locked");
});

test("optional native topic title is safe and bounded",()=>{
 const data=JSON.stringify({topics:[{...topic("-1001234","savedMessagesTopicTypeChat"),title:"Математика"}]});
 expect(parseSavedTopics(data)[0].title).toBe("Математика");
 expect(parseSavedTopics(JSON.stringify({topics:[topic("0")]}))[0].title).toBeUndefined();
 expect(()=>parseSavedTopics(JSON.stringify({topics:[{...topic("1"),title:"a".repeat(81)}]})))
   .toThrow("telegram_saved_topic_invalid");
});
