import * as SecureStore from "expo-secure-store";
import {
  advanceTelegramBotCursor,clearTelegramBot,inspectTelegramBot,loadTelegramBotConfig,
  pairTelegramBot,saveVerifiedBot,validateBotToken,validatePrivateChatId,
} from "../bot-settings";
jest.mock("expo-secure-store",()=>({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY:"device-only",
  getItemAsync:jest.fn(),setItemAsync:jest.fn(),deleteItemAsync:jest.fn(),
}));
const mockData=new Map<string,string>();
const token="12345678:"+"a".repeat(35);
beforeEach(()=>{
  jest.clearAllMocks();mockData.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async(k:string)=>mockData.get(k)??null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async(k:string,v:string)=>{mockData.set(k,v);});
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async(k:string)=>{mockData.delete(k);});
});
test("only verified bot can be stored; token stays private and profile scoped",async()=>{
  expect(()=>validateBotToken("abc")).toThrow();
  expect(()=>validatePrivateChatId("-123")).toThrow();
  await saveVerifiedBot("guest",token,{id:456,username:"MyPersAIBot"});
  expect(await inspectTelegramBot("guest")).toEqual({
    configured:true,username:"MyPersAIBot",paired:false,cursor:0,
  });
  expect(JSON.stringify(await inspectTelegramBot("guest"))).not.toContain(token);
  expect(await loadTelegramBotConfig("other")).toBeNull();
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith("pia.telegram.bot.v1.guest",
    expect.stringContaining('"token":"12345678:'),{keychainAccessible:"device-only"});
});
test("explicit pairing and ACK only after forward and only for same bot/chat",async()=>{
  await saveVerifiedBot("guest",token,{id:456,username:"MyPersAIBot"});
  await pairTelegramBot("guest",456,"12345");
  expect((await loadTelegramBotConfig("guest"))?.allowedChatId).toBe("12345");
  await advanceTelegramBotCursor("guest",456,"12345",7);
  expect((await loadTelegramBotConfig("guest"))?.cursor).toBe(7);
  await expect(advanceTelegramBotCursor("guest",456,"12345",7)).rejects.toThrow("regression");
  await expect(advanceTelegramBotCursor("guest",999,"12345",8)).rejects.toThrow("changed");
  await expect(advanceTelegramBotCursor("guest",456,"99",8)).rejects.toThrow("changed");
  await clearTelegramBot("guest");
  expect(await loadTelegramBotConfig("guest")).toBeNull();
});
test("damaged data and unsafe scope fail closed",async()=>{
  mockData.set("pia.telegram.bot.v1.guest",'{"token":"bad","cursor":10}');
  expect(await loadTelegramBotConfig("guest")).toBeNull();
  await expect(saveVerifiedBot("../bad",token,{id:1,username:"MyPersAIBot"})).rejects.toThrow("invalid_local_profile");
  await expect(saveVerifiedBot("guest",token,{id:1,username:"bad"})).rejects.toThrow("invalid_telegram_bot_identity");
});
