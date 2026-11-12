import Constants from "expo-constants";
import {bundledTelegramApiCredentials} from "../bundled-api";
jest.mock("expo-constants",()=>({__esModule:true,default:{expoConfig:{extra:{}}}}));
const expo=Constants as unknown as {expoConfig:{extra:Record<string,unknown>}};
beforeEach(()=>{expo.expoConfig.extra={};});
test("absent embedded PersAI identity does not fake Telegram availability",()=>{
  expect(bundledTelegramApiCredentials()).toBeNull();
});
test("validated shared identity is available without any per-profile state",()=>{
  expo.expoConfig.extra.persaiTelegramApi={apiId:123456,apiHash:"A".repeat(32)};
  expect(bundledTelegramApiCredentials()).toEqual({apiId:123456,apiHash:"a".repeat(32)});
});
test("malformed config never supplies unsafe or partial credentials",()=>{
  for(const value of [
    {apiId:0,apiHash:"a".repeat(32)},
    {apiId:2147483648,apiHash:"a".repeat(32)},
    {apiId:123456,apiHash:"test"},
    {apiId:"123456",apiHash:"a".repeat(32)},
    {apiId:123456,apiHash:undefined},
    null,[],
  ]){
    expo.expoConfig.extra.persaiTelegramApi=value;
    expect(bundledTelegramApiCredentials()).toBeNull();
  }
});
