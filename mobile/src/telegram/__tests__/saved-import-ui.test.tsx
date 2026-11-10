import React from "react";
import {fireEvent,render,waitFor} from "@testing-library/react-native";
import {TelegramSavedImportCard} from "../TelegramSavedImportCard";
import {importSavedTextPage} from "../saved-import";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../saved-import",()=>({importSavedTextPage:jest.fn()}));
beforeEach(()=>{
  jest.clearAllMocks();
  (importSavedTextPage as jest.Mock).mockResolvedValue({
    saved:2,duplicates:1,unsupported:3,empty:0,nextCursor:"44",selfChatId:"12345",
  });
});
test("manual import is visible, page bounded, reports skipped media without claiming they were saved",async()=>{
  const ui=render(<TelegramSavedImportCard profile="guest"/>);
  expect(ui.getByText(/Фото, документы и подписи/)).toBeTruthy();
  expect(importSavedTextPage).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Импортировать последние 20 сообщений"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","0"));
  expect(ui.getByText(/Сохранено: 2; уже были: 1/)).toBeTruthy();
  expect(ui.getByText(/медиа пропущено: 3/)).toBeTruthy();
  fireEvent.press(ui.getByText("Продолжить историю (до 20)"));
  await waitFor(()=>expect(importSavedTextPage).toHaveBeenCalledWith("guest","44"));
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
