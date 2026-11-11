import React from "react";
import {fireEvent,render,waitFor} from "@testing-library/react-native";
import {TelegramSavedImportCard} from "../TelegramSavedImportCard";
import {importSavedTextPage} from "../saved-import";
import {listSavedTopics} from "../saved-topics";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../saved-import",()=>({importSavedTextPage:jest.fn()}));
jest.mock("../saved-topics",()=>({listSavedTopics:jest.fn()}));
beforeEach(()=>{
  jest.clearAllMocks();
  (listSavedTopics as jest.Mock).mockResolvedValue([]);
  (importSavedTextPage as jest.Mock).mockResolvedValue({
    saved:2,duplicates:1,unsupported:3,empty:0,nextCursor:"44",selfChatId:"12345",
  });
});
test("manual import is visible, page bounded, reports skipped media without claiming they were saved",async()=>{
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  expect(ui.getByText(/одиночные поддерживаемые оригиналы/)).toBeTruthy();
  expect(importSavedTextPage).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","0",undefined,undefined,"supported-originals"));
  expect(ui.getByText(/Сохранено: 2; уже были: 1/)).toBeTruthy();
  expect(ui.getByText(/неподдержанных: 3/)).toBeTruthy();
  fireEvent.press(ui.getByText("Продолжить историю (до 20)"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","44",undefined,undefined,"supported-originals"));
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
  fireEvent.press(ui.getByText("Обновить подборки «Избранного»"));
  await waitFor(()=>ui.getByText("Пересланное из чата · №-1005432"));
  fireEvent.press(ui.getByText("Пересланное из чата · №-1005432"));
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage)
    .toHaveBeenCalledWith("guest","0",undefined,"-1005432","supported-originals"));
  fireEvent.press(ui.getByText("Все сообщения «Избранного»"));
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenLastCalledWith("guest","0",undefined,undefined,"supported-originals"));
});
test("empty topic list and failures are non-destructive",async()=>{
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  fireEvent.press(ui.getByText("Обновить подборки «Избранного»"));
  await waitFor(()=>ui.getByText(/Список пока пуст/));
  expect(importSavedTextPage).not.toHaveBeenCalled();
});
