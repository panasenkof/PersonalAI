import React from "react";
import {render,waitFor} from "@testing-library/react-native";
import {TelegramAutoSync,resetTelegramAutoSyncForTests} from "../TelegramAutoSync";
import {loadTelegramSyncMode,wasTelegramAuthorized} from "../settings";
import {tdlibAvailable,initializeTelegramAccount,observeTelegramAccountState} from "../account";
import {importSavedTextPage} from "../saved-import";
import {loadTelegramBotConfig} from "../bot-settings";
import {syncTelegramBotText} from "../bot-sync";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
jest.mock("../settings",()=>({loadTelegramSyncMode:jest.fn(),wasTelegramAuthorized:jest.fn(),markTelegramAuthorized:jest.fn(async()=>{})}));
jest.mock("../bot-settings",()=>({loadTelegramBotConfig:jest.fn()}));
jest.mock("../bot-sync",()=>({syncTelegramBotText:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn(),onLocalMemorySessionChange:jest.fn(()=>()=>{})}));
jest.mock("../account",()=>({
 closeTelegramAccount:jest.fn(async()=> "offline"),
 tdlibAvailable:jest.fn(),initializeTelegramAccount:jest.fn(),
 observeTelegramAccountState:jest.fn(),
}));
jest.mock("../saved-import",()=>({importSavedTextPage:jest.fn()}));
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
  (tdlibAvailable as jest.Mock).mockReturnValue(false);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(false);
  (initializeTelegramAccount as jest.Mock).mockResolvedValue("starting");
  (observeTelegramAccountState as jest.Mock).mockReturnValue(()=>{});
  (importSavedTextPage as jest.Mock).mockResolvedValue({saved:0,duplicates:0,unsupported:0,empty:0,nextCursor:"",selfChatId:"12345"});
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

test("on_open with a previously started TDLib session imports one bounded account page",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(true);
  (initializeTelegramAccount as jest.Mock).mockResolvedValue("authorizationStateReady");
  const ui=render(<TelegramAutoSync/>);
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledTimes(1));
  expect(initializeTelegramAccount).toHaveBeenCalledWith("guest");
  expect(importSavedTextPage).toHaveBeenCalledWith("guest","0",expect.any(Object));
  expect(syncTelegramBotText).toHaveBeenCalledTimes(1);
  ui.rerender(<TelegramAutoSync/>);
  expect(importSavedTextPage).toHaveBeenCalledTimes(1);
});
test("on_open does not silently create a TDLib session for an account never connected",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(false);
  render(<TelegramAutoSync/>);
  await waitFor(()=>expect(wasTelegramAuthorized).toHaveBeenCalledWith("guest"));
  expect(initializeTelegramAccount).not.toHaveBeenCalled();
  expect(importSavedTextPage).not.toHaveBeenCalled();
});
test("TDLib auth must reach ready state before account import (never import during code/2FA)",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(true);
  (initializeTelegramAccount as jest.Mock).mockResolvedValue("authorizationStateWaitCode");
  let update:(state:string)=>void=()=>{};
  (observeTelegramAccountState as jest.Mock).mockImplementation(fn=>{update=fn;return ()=>{};});
  render(<TelegramAutoSync/>);
  await waitFor(()=>expect(initializeTelegramAccount).toHaveBeenCalledWith("guest"));
  expect(importSavedTextPage).not.toHaveBeenCalled();
  update("authorizationStateReady");
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledTimes(1));
  update("authorizationStateReady");
  expect(importSavedTextPage).toHaveBeenCalledTimes(1);
});
test("manual mode starts neither account TDLib nor bot channel even if account key exists",async()=>{
  (loadTelegramSyncMode as jest.Mock).mockResolvedValue("manual");
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(true);
  render(<TelegramAutoSync/>);
  await waitFor(()=>expect(loadTelegramSyncMode).toHaveBeenCalledWith("guest"));
  expect(initializeTelegramAccount).not.toHaveBeenCalled();
  expect(syncTelegramBotText).not.toHaveBeenCalled();
});
test("bot failure does not suppress account channel, and both are gated independently",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (wasTelegramAuthorized as jest.Mock).mockResolvedValue(true);
  (initializeTelegramAccount as jest.Mock).mockResolvedValue("authorizationStateReady");
  (syncTelegramBotText as jest.Mock).mockRejectedValueOnce(new Error("bot unavailable"));
  render(<TelegramAutoSync/>);
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledTimes(1));
});
