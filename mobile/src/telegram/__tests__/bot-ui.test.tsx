import React from "react";
import {fireEvent,render,waitFor} from "@testing-library/react-native";
import {TelegramBotCard} from "../TelegramBotCard";
import {verifyTelegramBot,listBotPairCandidates} from "../bot-api";
import {
  inspectTelegramBot,saveVerifiedBot,loadTelegramBotConfig,pairTelegramBot,clearTelegramBot,
} from "../bot-settings";
import {syncTelegramBotText,TelegramBotBlocked,skipBlockedBotUpdate} from "../bot-sync";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../TelegramImportTargetPicker",()=>({TelegramImportTargetPicker:()=>null}));
jest.mock("../import-target",()=>({loadTelegramTargetForWrite:jest.fn(async()=>undefined)}));
jest.mock("../bot-api",()=>({
  verifyTelegramBot:jest.fn(),listBotPairCandidates:jest.fn(),
}));
jest.mock("../bot-settings",()=>({
  inspectTelegramBot:jest.fn(),saveVerifiedBot:jest.fn(),
  loadTelegramBotConfig:jest.fn(),pairTelegramBot:jest.fn(),clearTelegramBot:jest.fn(),
}));
jest.mock("../bot-sync",()=>({
  syncTelegramBotText:jest.fn(),skipBlockedBotUpdate:jest.fn(),
  TelegramBotBlocked:class TelegramBotBlocked extends Error{
    reason:string;updateId:number;
    constructor(reason:string,updateId:number){
      super("В очереди бота есть сообщение, которое PersAI не умеет сохранять.");
      this.reason=reason;this.updateId=updateId;
    }
  },
}));
const token="12345678:"+"a".repeat(35);
beforeEach(()=>{
  jest.clearAllMocks();
  (inspectTelegramBot as jest.Mock).mockResolvedValue({configured:false,username:null,paired:false,cursor:0});
  (saveVerifiedBot as jest.Mock).mockResolvedValue(undefined);
  (verifyTelegramBot as jest.Mock).mockResolvedValue({id:456,username:"MyPersAIBot"});
  (loadTelegramBotConfig as jest.Mock).mockResolvedValue({botId:456,token,allowedChatId:null});
  (listBotPairCandidates as jest.Mock).mockResolvedValue([{chatId:"12345",label:"Личный пользователь"}]);
  (pairTelegramBot as jest.Mock).mockResolvedValue(undefined);
  (clearTelegramBot as jest.Mock).mockResolvedValue(undefined);
  (syncTelegramBotText as jest.Mock).mockResolvedValue({imported:2,skipped:1,duplicates:0,lastUpdate:42});
  (skipBlockedBotUpdate as jest.Mock).mockResolvedValue(undefined);
});
test("bot token is masked and never saved before Telegram verifies its getMe identity",async()=>{
  const ui=render(<TelegramBotCard profile="guest"/>);
  await waitFor(()=>ui.getByLabelText("Telegram Bot Token"));
  const field=ui.getByLabelText("Telegram Bot Token");
  expect(field.props.secureTextEntry).toBe(true);
  expect(saveVerifiedBot).not.toHaveBeenCalled();
  fireEvent.changeText(field,token);
  fireEvent.press(ui.getByText("Проверить и сохранить бота"));
  await waitFor(()=>expect(verifyTelegramBot).toHaveBeenCalledWith(token,expect.any(Object)));
  await waitFor(()=>expect(saveVerifiedBot).toHaveBeenCalledWith("guest",token,{id:456,username:"MyPersAIBot"}));
  expect(ui.queryByLabelText("Telegram Bot Token")).toBeNull();
  expect(ui.getByText(/чат не подтверждён/)).toBeTruthy();
});
test("pairing is explicit, uses selected chat, then manual import uses canonical flow",async()=>{
  (inspectTelegramBot as jest.Mock).mockResolvedValue({configured:true,username:"MyPersAIBot",paired:false,cursor:0});
  const ui=render(<TelegramBotCard profile="guest"/>);
  await waitFor(()=>ui.getByText(/чат не подтверждён/));
  fireEvent.press(ui.getByText("Найти мой чат после /start"));
  await waitFor(()=>ui.getByText("Подтвердить чат 12345"));
  expect(pairTelegramBot).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Подтвердить чат 12345"));
  await waitFor(()=>expect(pairTelegramBot).toHaveBeenCalledWith("guest",456,"12345"));
  fireEvent.press(ui.getByText("Импортировать новые сообщения бота"));
  await waitFor(()=>expect(syncTelegramBotText).toHaveBeenCalledWith("guest",expect.any(Object),undefined));
  expect(ui.getByText(/Импортировано: 2/)).toBeTruthy();
});
test("invalid token/Telegram network errors keep the connection unpaired",async()=>{
  (verifyTelegramBot as jest.Mock).mockRejectedValue(new Error("Telegram недоступен. Проверьте интернет и повторите."));
  const ui=render(<TelegramBotCard profile="guest"/>);
  await waitFor(()=>ui.getByLabelText("Telegram Bot Token"));
  fireEvent.changeText(ui.getByLabelText("Telegram Bot Token"),token);
  fireEvent.press(ui.getByText("Проверить и сохранить бота"));
  await waitFor(()=>ui.getByText(/Telegram недоступен/));
  expect(saveVerifiedBot).not.toHaveBeenCalled();
  expect(ui.getByLabelText("Telegram Bot Token")).toBeTruthy();
});

test("user can cancel a pending Bot API verification without saving credentials",async()=>{
  (verifyTelegramBot as jest.Mock).mockImplementation(
    (_token:string,signal:AbortSignal)=>new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("Запрос Telegram отменён.")),{once:true});
    }));
  const ui=render(<TelegramBotCard profile="guest"/>);
  await waitFor(()=>ui.getByLabelText("Telegram Bot Token"));
  fireEvent.changeText(ui.getByLabelText("Telegram Bot Token"),token);
  fireEvent.press(ui.getByText("Проверить и сохранить бота"));
  await waitFor(()=>ui.getByText("Отменить операцию Telegram"));
  fireEvent.press(ui.getByText("Отменить операцию Telegram"));
  await waitFor(()=>ui.getByText("Запрос Telegram отменён."));
  expect(saveVerifiedBot).not.toHaveBeenCalled();
  expect(ui.getByLabelText("Telegram Bot Token")).toBeTruthy();
  expect(ui.getByText("Проверить и сохранить бота")).toBeTruthy();
});

test("blocked update is not skipped without an explicit second confirmation",async()=>{
 (inspectTelegramBot as jest.Mock).mockResolvedValue({
   configured:true,username:"MyPersAIBot",paired:true,cursor:0,
 });
 (syncTelegramBotText as jest.Mock).mockRejectedValueOnce(
   new TelegramBotBlocked("unsupported",12));
 const ui=render(<TelegramBotCard profile="guest"/>);
 await waitFor(()=>ui.getByText("Импортировать новые сообщения бота"));
 fireEvent.press(ui.getByText("Импортировать новые сообщения бота"));
 await waitFor(()=>ui.getByText("Пропустить это сообщение"));
 expect(skipBlockedBotUpdate).not.toHaveBeenCalled();
 fireEvent.press(ui.getByText("Пропустить это сообщение"));
 expect(skipBlockedBotUpdate).not.toHaveBeenCalled();
 expect(ui.getByText(/Сообщение не будет сохранено/)).toBeTruthy();
 fireEvent.press(ui.getByText("Подтвердить пропуск"));
 await waitFor(()=>expect(skipBlockedBotUpdate).toHaveBeenCalledWith(
   "guest",12,expect.any(Object)));
});
