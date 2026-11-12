import React from "react";
import {fireEvent,render,waitFor} from "@testing-library/react-native";
import {TelegramSavedImportCard} from "../TelegramSavedImportCard";
import {importSavedTextPage} from "../saved-import";
import {listSavedTopics} from "../saved-topics";
import {onLocalMemorySessionChange} from "../../local-memory/storage";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../saved-import",()=>({importSavedTextPage:jest.fn()}));
jest.mock("../saved-topics",()=>({listSavedTopics:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({onLocalMemorySessionChange:jest.fn(()=>()=>{})}));
beforeEach(()=>{
  jest.clearAllMocks();
  (listSavedTopics as jest.Mock).mockResolvedValue([]);
  (importSavedTextPage as jest.Mock).mockResolvedValue({
    saved:2,duplicates:1,unsupported:3,empty:0,nextCursor:"44",selfChatId:"12345",
  });
});
test("manual import is visible, page bounded, reports skipped media without claiming they were saved",async()=>{
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  expect(ui.getByText(/тексты, одиночные оригиналы и завершённые альбомы/)).toBeTruthy();
  expect(importSavedTextPage).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","0",expect.any(Object),undefined,"supported-originals"));
  expect(ui.getByText(/Сохранено: 2; уже были: 1/)).toBeTruthy();
  expect(ui.getByText(/неподдержанных: 3/)).toBeTruthy();
  fireEvent.press(ui.getByText("Продолжить историю (до 20)"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","44",expect.any(Object),undefined,"supported-originals"));
  fireEvent.press(ui.getByText("Начать с новых сообщений"));
  expect(ui.getByText("Импортировать последние 20 сообщений")).toBeTruthy();
});
test("end of history disables repeated paging but allows explicit reset",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce({
    saved:0,duplicates:0,unsupported:0,empty:0,nextCursor:"",selfChatId:"12345",
  });
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText(/Больше сообщений в этом диапазоне нет/));
  expect(ui.getByLabelText("Импортировать последние 20 сообщений").props.accessibilityState.disabled)
    .toBe(true);
});
test("failure is visible but does not advance pagination",async()=>{
  (importSavedTextPage as jest.Mock).mockRejectedValueOnce(new Error("connection-key-redacted"));
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText(/Не удалось прочитать или сохранить/));
  expect(ui.queryByText(/connection-key-redacted/)).toBeNull();
  expect(ui.getByText("Импортировать последние 20 сообщений")).toBeTruthy();
});

test("explicit topic selection resets cursor and reuses canonical importer",async()=>{
  (listSavedTopics as jest.Mock).mockResolvedValueOnce([
    {id:"-1005432",kind:"savedMessagesTopicTypeChat",isPinned:false,order:"123456789"},
  ]);
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  expect(listSavedTopics).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Показать подборки"));
  await waitFor(()=>ui.getByText("○ Чат без названия"));
  fireEvent.press(ui.getByText("○ Чат без названия"));
  expect(ui.getByText("● Чат без названия")).toBeTruthy();
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage)
    .toHaveBeenCalledWith("guest","0",expect.any(Object),"-1005432","supported-originals"));
  fireEvent.press(ui.getByText("○ Все сообщения «Избранного»"));
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenLastCalledWith("guest","0",expect.any(Object),undefined,"supported-originals"));
});
test("empty topic list and failures are non-destructive",async()=>{
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Показать подборки"));
  await waitFor(()=>ui.getByText(/Список пока пуст/));
  expect(importSavedTextPage).not.toHaveBeenCalled();
});

test("an album pending at history boundary remains retryable without a false completion message",async()=>{
  (importSavedTextPage as jest.Mock).mockResolvedValueOnce({
    saved:0,duplicates:0,unsupported:0,empty:0,nextCursor:"0",
    selfChatId:"12345",pendingAlbum:2,
  });
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText(/Альбом из 2 элементов ожидает завершения/));
  expect(ui.queryByText(/Больше сообщений в этом диапазоне нет/)).toBeNull();
  expect(ui.getByLabelText("Импортировать последние 20 сообщений").props.accessibilityState.disabled)
    .toBe(false);
});

test("cancel button aborts in-flight Saved originals without changing history cursor",async()=>{
  let onCancel:(()=>void)|undefined;
  (importSavedTextPage as jest.Mock).mockImplementation((_profile:string,_cursor:string,signal:AbortSignal)=>
    new Promise((_resolve,reject)=>{
      onCancel=()=>reject(new Error("telegram_saved_import_cancelled"));
      signal.addEventListener("abort",onCancel,{once:true});
    }));
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText("Отменить импорт Telegram"));
  const supplied=(importSavedTextPage as jest.Mock).mock.calls[0][2] as AbortSignal;
  fireEvent.press(ui.getByText("Отменить импорт Telegram"));
  expect(supplied.aborted).toBe(true);
  await waitFor(()=>ui.getByText(/Импорт Telegram отменён/));
  expect(ui.getByText("Импортировать последние 20 сообщений")).toBeTruthy();
  expect(ui.queryByText("Продолжить историю (до 20)")).toBeNull();
});
test("AppLock aborts current Saved originals import",async()=>{
  let lock:(unlocked:boolean)=>void=()=>{};
  (onLocalMemorySessionChange as jest.Mock).mockImplementation(cb=>{lock=cb;return()=>{};});
  (importSavedTextPage as jest.Mock).mockImplementation((_p:string,_c:string,signal:AbortSignal)=>
    new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("telegram_saved_import_cancelled")),{once:true});
    }));
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText("Отменить импорт Telegram"));
  lock(false);
  await waitFor(()=>ui.getByText(/Импорт Telegram отменён/));
  expect(ui.queryByText(/Сохранено:/)).toBeNull();
});
test("leaving the importer aborts the in-flight request without writing UI state",async()=>{
  (importSavedTextPage as jest.Mock).mockImplementation((_p:string,_c:string,signal:AbortSignal)=>
    new Promise((_resolve,reject)=>{
      signal.addEventListener("abort",()=>reject(new Error("telegram_saved_import_cancelled")),{once:true});
    }));
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText("Отменить импорт Telegram"));
  const supplied=(importSavedTextPage as jest.Mock).mock.calls[0][2] as AbortSignal;
  ui.unmount();
  expect(supplied.aborted).toBe(true);
});

test("switching profiles aborts old import and enables a new profile without stale busy state",async()=>{
  const oldSignals:AbortSignal[]=[];
  (importSavedTextPage as jest.Mock).mockImplementation((_p:string,_c:string,signal:AbortSignal)=>
    new Promise((_resolve,reject)=>{
      oldSignals.push(signal);
      signal.addEventListener("abort",()=>reject(new Error("telegram_saved_import_cancelled")),{once:true});
    }));
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>ui.getByText("Отменить импорт Telegram"));
  ui.rerender(<TelegramSavedImportCard profile="second"/>);
  await waitFor(()=>expect(oldSignals[0]?.aborted).toBe(true));
  expect(ui.queryByText("Отменить импорт Telegram")).toBeNull();
  const importButton=ui.getByLabelText("Импортировать последние 20 сообщений");
  expect(importButton.props.accessibilityState.disabled).toBe(false);
  fireEvent.press(importButton);
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith(
    "second","0",expect.any(Object),undefined,"supported-originals"));
  expect(ui.getByText("Отменить импорт Telegram")).toBeTruthy();
});
