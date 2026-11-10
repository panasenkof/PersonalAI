import {parseSavedMessagesPage,readSavedMessagesPage} from "../saved-messages";
import {tdlibAccountState,tdlibAvailable} from "../account";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
jest.mock("../account",()=>({tdlibAvailable:jest.fn(),tdlibAccountState:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("expo-modules-core",()=>({
  ...jest.requireActual("expo-modules-core"),
  requireOptionalNativeModule:jest.fn(),
}));
const page=(messages:unknown[],nextCursor="")=>JSON.stringify({
  selfChatId:"12345",messages,nextCursor,
});
const item=(id:string,text="Текст")=>({id,date:1794300000,kind:"messageText",text,hasMedia:false});
beforeEach(()=>{
  jest.clearAllMocks();
  Object.defineProperty(Platform,"OS",{configurable:true,value:"android"});
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateReady");
  (requireOptionalNativeModule as jest.Mock).mockReturnValue({
    getSavedMessagesPage:jest.fn().mockResolvedValue(page([item("42"),item("41")],"41")),
  });
});
test("reads ONLY scoped native projection with bounded page; does not import",async()=>{
  const result=await readSavedMessagesPage("0",20);
  expect(result.messages.map(x=>x.id)).toEqual(["42","41"]);
  expect(result.nextCursor).toBe("41");
  expect((requireOptionalNativeModule as jest.Mock).mock.results[0].value.getSavedMessagesPage)
    .toHaveBeenCalledWith("0",20);
});
test("rejects locked, unavailable, not authorized, malformed cursor before native read",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValueOnce(false);
  await expect(readSavedMessagesPage()).rejects.toThrow("telegram_app_locked");
  (tdlibAvailable as jest.Mock).mockReturnValueOnce(false);
  await expect(readSavedMessagesPage()).rejects.toThrow("telegram_account_not_authorized");
  await expect(readSavedMessagesPage("-123")).rejects.toThrow("telegram_saved_request_invalid");
  await expect(readSavedMessagesPage("0",101)).rejects.toThrow("telegram_saved_request_invalid");
});
test("rejects unexpected raw response, another chat identity, ordering and truncation",()=>{
  expect(()=>parseSavedMessagesPage("{}", "0",20)).toThrow("telegram_saved_page_invalid");
  expect(()=>parseSavedMessagesPage(page([item("42"),item("43")],"43"),"0",20))
    .toThrow("telegram_saved_order_invalid");
  expect(()=>parseSavedMessagesPage(page([item("42")],"99"),"0",20))
    .toThrow("telegram_saved_cursor_mismatch");
  expect(()=>parseSavedMessagesPage(page([{...item("42"),text:"x".repeat(60001)}],"42"),"0",20))
    .toThrow("telegram_saved_item_invalid");
  expect(()=>parseSavedMessagesPage(page([item("42")],"42"),"40",20))
    .toThrow("telegram_saved_order_invalid");
  expect(()=>parseSavedMessagesPage("x".repeat(2_000_001),"0",20))
    .toThrow("telegram_saved_page_invalid");
});
test("anchor repeat is skipped and zero-progress cursor terminates",()=>{
  const p=parseSavedMessagesPage(page([item("42"),item("41"),item("40")],"40"),"42",20);
  expect(p.messages.map(m=>m.id)).toEqual(["41","40"]);
  expect(p.nextCursor).toBe("40");
  const empty=parseSavedMessagesPage(page([item("42")],"42"),"42",20);
  expect(empty).toMatchObject({messages:[],nextCursor:""});
});
test("locks after network read discard the result",async()=>{
  (localMemorySessionUnlocked as jest.Mock)
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(false);
  await expect(readSavedMessagesPage()).rejects.toThrow("telegram_app_locked");
});
test("media flags are preserved; no fake plaintext for files",()=>{
  const p=parseSavedMessagesPage(page([
    {id:"42",date:1794300000,kind:"messageDocument",text:"подпись",hasMedia:true},
    {id:"41",date:1794300000,kind:"messagePhoto",text:"",hasMedia:true},
  ],"41"),"0",20);
  expect(p.messages.every(x=>x.hasMedia)).toBe(true);
  expect(p.messages[1].text).toBe("");
});
