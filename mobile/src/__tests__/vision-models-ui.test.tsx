import React from "react";
import { Alert, Text, View } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { VisionModelCard } from "../components/VisionModelCard";
import { cancelVisionModelDownload, downloadVisionModel, chooseVisionModel,
  deleteVisionModel } from "../media/vision-model-manager";

const mockStatus: { current: any } = { current: null };
jest.mock("../theme", () => ({ useTheme: () => ({
  text: "#ffffff", muted: "#abbad8", panel: "#14213d", line: "#445574",
  soft: "#26395c", secondary: "#30caed", ok: "#2fd3a4", err: "#ff9faf"
}) }));
jest.mock("../components/Collapsible", () => ({
  Collapsible: ({children, summary}: any) => { const { View, Text } = require("react-native"); return <View><Text>{summary}</Text>{children}</View>; },
}));
jest.mock("../media/vision-model-manager", () => ({
  useVisionModelStatus: () => mockStatus.current,
  cancelVisionModelDownload: jest.fn(), downloadVisionModel: jest.fn(),
  chooseVisionModel: jest.fn(), deleteVisionModel: jest.fn(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockStatus.current = { loaded: true, busy: false, downloadingId: null,
    progress: 0, installed: [], activeId: null, error: "", notice: "" };
});
test("shows honest unintegrated state and a confirmed, optional 388MB download", () => {
  const a = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VisionModelCard />);
  expect(v.getByText(/поиск по сохранённым фотографиям будет включён только после/)).toBeTruthy();
  fireEvent.press(v.getByLabelText("Скачать EmbeddingGemma 2 · Фото"));
  expect(a).toHaveBeenCalledTimes(1);
  expect(downloadVisionModel).not.toHaveBeenCalled();
  const choices = a.mock.calls[0][2]!;
  choices[1].onPress!();
  expect(downloadVisionModel).toHaveBeenCalledWith("eg2-vision-440");
  a.mockRestore();
});
test("installed model offers select and delete without confusing it with active search", () => {
  mockStatus.current.installed = [{
    id: "eg2-vision-440", sha256: "a".repeat(64),
    revision: "b".repeat(40), filename: "eg2-vision-440-aaaaaaaaaaaaaaaaaaaaaaaa.litertlm", bytes: 388000000,
  }];
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VisionModelCard />);
  fireEvent.press(v.getByLabelText("Выбрать EmbeddingGemma 2 · Фото"));
  expect(chooseVisionModel).toHaveBeenCalledWith("eg2-vision-440");
  fireEvent.press(v.getByLabelText("Удалить EmbeddingGemma 2 · Фото"));
  expect(deleteVisionModel).not.toHaveBeenCalled();
  alert.mock.calls[0][2]![1].onPress!();
  expect(deleteVisionModel).toHaveBeenCalledWith("eg2-vision-440");
  alert.mockRestore();
});
test("running download shows progress/cancel and disables all other model choices", () => {
  mockStatus.current = {...mockStatus.current, busy: true, progress: 57, downloadingId: "eg2-vision-440"};
  const v = render(<VisionModelCard />);
  expect(v.getByText("Загружается: 57%")).toBeTruthy();
  expect(v.getByLabelText("Скачать EmbeddingGemma 2 · MediaTek").props.accessibilityState.disabled).toBe(true);
  fireEvent.press(v.getByLabelText("Отменить скачивание модели"));
  expect(cancelVisionModelDownload).toHaveBeenCalledTimes(1);
});
