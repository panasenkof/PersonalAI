import React from "react";
import {render,waitFor} from "@testing-library/react-native";
import {TelegramAutoSync,resetTelegramAutoSyncForTests} from "../TelegramAutoSync";
import {loadTelegramSyncMode} from "../settings";
import {loadTelegramBotConfig} from "../bot-settings";
import {syncTelegramBotText} from "../bot-sync";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
jest.mock("../settings",()=>({loadTelegramSyncMode:jest.fn()}));
jest.mock("../bot-settings",()=>({loadTelegramBotConfig:jest.fn()}));
jest.mock("../bot-sync",()=>({syncTelegramBotText:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn(),onLocalMemorySessionChange:jest.fn(()=>()=>{})}));
jest.mock("../account",()=>({closeTelegramAccount:jest.fn(async()=> "offline")}));
jest.mock("../../profile/ProfileContext",()=>({useProfile:()=> "guest"}));
const mockVisibility={current:true};
jest.mock("../../security/visibility",()=>({
  useApplicationVisible:()=>mockVisibility.current,
}));
beforeEach(()=>{
  resetTelegramAutoSyncForTests();jest.clearAllMocks();mockVisibility.current=true;
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (loadTelegramSyncMode as jest.Mock).mockResolvedValue("on_open");
  (loadTelegramBotConfig as jest.Mock).mockResolvedValue({allowedChatId:"12345"});
  (syncTelegramBotText as jest.Mock).mockResolvedValue({imported:0,skipped:0,lastUpdate:0});
});
test("explicit on_open sync starts once after unlock, not on rerender",async()=>{
  const ui=render(<TelegramAutoSync/>);
  await waitFor(()=>expect(syncTelegramBotText).toHaveBeenCalledTimes(1));
  ui.rerender(<TelegramAutoSync/>);
  expect(syncTelegramBotText).toHaveBeenCalledTimes(1);
});
test("manual mode or unpaired bot never sync automatically",async()=>{
  (loadTelegramSyncMode as jest.Mock).mockResolvedValueOnce("manual");
  const manual=render(<TelegramAutoSync/>);
  await waitFor(()=>expect(loadTelegramSyncMode).toHaveBeenCalled());
  expect(syncTelegramBotText).not.toHaveBeenCalled();
  manual.unmount();
  resetTelegramAutoSyncForTests();
  (loadTelegramBotConfig as jest.Mock).mockResolvedValueOnce({allowedChatId:null});
  const ui=render(<TelegramAutoSync/>);
  await waitFor(()=>expect(loadTelegramBotConfig).toHaveBeenCalled());
  expect(syncTelegramBotText).not.toHaveBeenCalled();
  ui.unmount();
});
test("AppLock and invisible windows block all Telegram reads",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValueOnce(false);
  render(<TelegramAutoSync/>);
  expect(loadTelegramSyncMode).not.toHaveBeenCalled();
  resetTelegramAutoSyncForTests();
  mockVisibility.current=false;
  render(<TelegramAutoSync/>);
  expect(loadTelegramSyncMode).not.toHaveBeenCalled();
});
